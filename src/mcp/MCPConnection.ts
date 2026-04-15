import { spawn, ChildProcess } from "child_process";

export type MCPTransport = "stdio" | "sse";

export interface MCPServerConfig {
  name: string;
  transport: MCPTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface MCPResource {
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
}

export class MCPConnection {
  private config: MCPServerConfig;
  private process?: ChildProcess;
  private requestId: number = 0;
  private pendingRequests: Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
      timer: NodeJS.Timeout;
    }
  > = new Map();
  private connected: boolean = false;
  private buffer: string = "";

  constructor(config: MCPServerConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.config.transport === "stdio") {
      await this.connectStdio();
    } else if (this.config.transport === "sse") {
      // SSE transport not yet implemented
      throw new Error("SSE transport not yet implemented");
    } else {
      throw new Error(`Unknown transport type: ${this.config.transport}`);
    }
  }

  private async connectStdio(): Promise<void> {
    if (!this.config.command) {
      throw new Error("command is required for stdio transport");
    }

    return new Promise((resolve, reject) => {
      try {
        const env = {
          ...process.env,
          ...(this.config.env || {}),
        };

        this.process = spawn(this.config.command!, this.config.args || [], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });

        if (!this.process.stdout || !this.process.stdin) {
          reject(new Error("Failed to create process pipes"));
          return;
        }

        // Handle stdout data
        this.process.stdout.on("data", (data: Buffer) => {
          this.handleData(data);
        });

        // Handle process exit
        this.process.on("exit", (code) => {
          this.connected = false;
          if (code !== 0 && code !== null) {
            console.warn(
              `MCP server ${this.config.name} exited with code ${code}`,
            );
          }
        });

        // Handle process error
        this.process.on("error", (err: Error) => {
          this.connected = false;
          reject(err);
        });

        // Send initialize request
        this.connected = true;

        const initRequest = {
          jsonrpc: "2.0",
          id: ++this.requestId,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: {
              name: "lunacode",
              version: "1.0.0",
            },
          },
        };

        this.sendRequestRaw(initRequest)
          .then(() => {
            // Send initialized notification
            this.sendNotification("notifications/initialized", {});
            resolve();
          })
          .catch(reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = undefined;
    }
    this.connected = false;

    // Reject all pending requests
    for (const [id, { reject, timer }] of this.pendingRequests.entries()) {
      clearTimeout(timer);
      reject(new Error("Connection closed"));
      this.pendingRequests.delete(id);
    }
  }

  async listTools(): Promise<MCPTool[]> {
    const response = (await this.sendRequest("tools/list", {})) as {
      tools: MCPTool[];
    };
    return response.tools || [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }> {
    const response = (await this.sendRequest("tools/call", {
      name,
      arguments: args,
    })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    return response;
  }

  async listResources(): Promise<MCPResource[]> {
    const response = (await this.sendRequest("resources/list", {})) as {
      resources: MCPResource[];
    };
    return response.resources || [];
  }

  async readResource(
    uri: string,
  ): Promise<{ contents: Array<{ uri: string; text?: string }> }> {
    const response = (await this.sendRequest("resources/read", {
      uri,
    })) as {
      contents: Array<{ uri: string; text?: string }>;
    };
    return response;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getConfig(): MCPServerConfig {
    return this.config;
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    const request = {
      jsonrpc: "2.0",
      id: ++this.requestId,
      method,
      params,
    };
    return this.sendRequestRaw(request);
  }

  private sendRequestRaw(request: {
    jsonrpc: string;
    id: number;
    method: string;
    params?: unknown;
  }): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = request.id;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout for method: ${request.method}`));
      }, 30000);

      this.pendingRequests.set(id, { resolve, reject, timer });

      if (!this.process?.stdin) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error("Process stdin not available"));
        return;
      }

      const message = JSON.stringify(request) + "\n";
      this.process.stdin.write(message, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    if (!this.process?.stdin) {
      console.warn("Process stdin not available for notification");
      return;
    }

    const message = {
      jsonrpc: "2.0",
      method,
      params,
    };

    const text = JSON.stringify(message) + "\n";
    this.process.stdin.write(text);
  }

  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    // Split by newlines and process complete lines
    const lines = this.buffer.split("\n");

    // Keep the last incomplete line in the buffer
    this.buffer = lines[lines.length - 1];

    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const message = JSON.parse(line);

        // Handle response (has id)
        if (message.id !== undefined) {
          const pending = this.pendingRequests.get(message.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(message.id);

            if (message.error) {
              pending.reject(
                new Error(
                  `RPC error: ${message.error.message || JSON.stringify(message.error)}`,
                ),
              );
            } else {
              pending.resolve(message.result);
            }
          }
        }
        // Handle notification (no id) - could be logged or ignored
      } catch (err) {
        console.warn("Failed to parse MCP message:", line, err);
      }
    }
  }
}
