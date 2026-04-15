import { MCPConnection, MCPServerConfig, MCPTool } from "./MCPConnection.js";
import { Tool, ToolResult } from "../types/index.js";

interface ToolRegistryLike {
  register: (tool: Tool) => void;
}

export class MCPClientManager {
  private connections: Map<string, MCPConnection> = new Map();
  private toolRegistry: ToolRegistryLike;

  constructor(toolRegistry: ToolRegistryLike) {
    this.toolRegistry = toolRegistry;
  }

  async connectAll(servers: MCPServerConfig[]): Promise<void> {
    for (const serverConfig of servers) {
      try {
        await this.connectServer(serverConfig);
      } catch (error) {
        console.warn(
          `Failed to connect to MCP server ${serverConfig.name}:`,
          error,
        );
      }
    }
  }

  async connectServer(config: MCPServerConfig): Promise<void> {
    if (this.connections.has(config.name)) {
      console.warn(`MCP server ${config.name} already connected`);
      return;
    }

    const connection = new MCPConnection(config);
    await connection.connect();

    this.connections.set(config.name, connection);

    // List and register tools
    try {
      const tools = await connection.listTools();
      for (const mcpTool of tools) {
        const wrappedTool = this.wrapMCPTool(config.name, mcpTool, connection);
        this.toolRegistry.register(wrappedTool);
      }
      console.log(
        `✓ Connected to MCP server ${config.name} with ${tools.length} tools`,
      );
    } catch (error) {
      console.warn(
        `Failed to list tools from MCP server ${config.name}:`,
        error,
      );
      // Still keep the connection, might be able to call tools directly
    }
  }

  async disconnectServer(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (connection) {
      await connection.disconnect();
      this.connections.delete(name);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const [name] of this.connections) {
      await this.disconnectServer(name);
    }
  }

  getStatus(): Array<{
    name: string;
    connected: boolean;
    toolCount: number;
  }> {
    return Array.from(this.connections.entries()).map(([name, conn]) => ({
      name,
      connected: conn.isConnected(),
      toolCount: 0, // Would need to track this separately if needed
    }));
  }

  getConnection(name: string): MCPConnection | undefined {
    return this.connections.get(name);
  }

  private wrapMCPTool(
    serverName: string,
    mcpTool: MCPTool,
    conn: MCPConnection,
  ): Tool {
    const toolName = `mcp_${serverName}_${mcpTool.name}`;
    const description = `[MCP:${serverName}] ${mcpTool.description}`;

    return {
      name: toolName,
      description,
      parameters: mcpTool.inputSchema,
      riskLevel: "MEDIUM",
      execute: async (params: unknown): Promise<ToolResult> => {
        try {
          const result = await conn.callTool(
            mcpTool.name,
            (params as Record<string, unknown>) || {},
          );

          // Extract text content from result
          let output = "";
          if (result.content && Array.isArray(result.content)) {
            for (const item of result.content) {
              if (item.type === "text" && item.text) {
                output += item.text + "\n";
              }
            }
          }

          return {
            success: !result.isError,
            output: output.trim() || JSON.stringify(result),
            error: result.isError ? "Tool returned error" : undefined,
          };
        } catch (error) {
          return {
            success: false,
            output: "",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    };
  }
}
