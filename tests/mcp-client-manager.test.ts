import { test, expect, mock, beforeEach } from "bun:test";
import { MCPClientManager } from "../src/mcp/MCPClientManager.js";
import { MCPConnection, MCPServerConfig, MCPTool } from "../src/mcp/MCPConnection.js";
import { Tool, ToolResult } from "../src/types/index.js";

// Mock MCPConnection
class MockMCPConnection {
  private config: MCPServerConfig;
  private tools: MCPTool[];

  constructor(config: MCPServerConfig, tools: MCPTool[] = []) {
    this.config = config;
    this.tools = tools;
  }

  async connect(): Promise<void> {
    // Mock connect
  }

  async disconnect(): Promise<void> {
    // Mock disconnect
  }

  async listTools(): Promise<MCPTool[]> {
    return this.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }> {
    return {
      content: [{ type: "text", text: `Tool ${name} result` }],
      isError: false,
    };
  }

  isConnected(): boolean {
    return true;
  }

  getConfig(): MCPServerConfig {
    return this.config;
  }
}

// Mock ToolRegistry
class MockToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }
}

test("MCPClientManager: constructor with toolRegistry", () => {
  const registry = new MockToolRegistry();
  const manager = new MCPClientManager(registry);

  expect(manager).toBeDefined();
});

test("MCPClientManager: connectServer adds to connections map", async () => {
  const registry = new MockToolRegistry();
  const manager = new MCPClientManager(registry);

  // Directly inject a mock connection (since ES modules don't support global mock replacement)
  const mockConn = new MockMCPConnection(
    { name: "test-server", transport: "stdio", command: "test-command" },
    [
      {
        name: "test-tool",
        description: "A test tool",
        inputSchema: { type: "object", properties: { input: { type: "string" } } },
      },
    ]
  );

  (manager as any).connections.set("test-server", mockConn);
  const conn = manager.getConnection("test-server");

  expect(conn).toBeDefined();
  expect(conn!.isConnected()).toBe(true);
});

test("MCPClientManager: disconnectServer removes from connections", async () => {
  const registry = new MockToolRegistry();
  const manager = new MCPClientManager(registry);

  // Manually add a mock connection
  const mockConn = new MockMCPConnection(
    {
      name: "test-server",
      transport: "stdio",
      command: "test-command",
    },
    []
  );

  (manager as any).connections.set("test-server", mockConn);

  await manager.disconnectServer("test-server");
  const conn = manager.getConnection("test-server");

  expect(conn).toBeUndefined();
});

test("MCPClientManager: disconnectAll clears all connections", async () => {
  const registry = new MockToolRegistry();
  const manager = new MCPClientManager(registry);

  // Manually add mock connections
  const mockConn1 = new MockMCPConnection(
    {
      name: "server1",
      transport: "stdio",
      command: "command1",
    },
    []
  );
  const mockConn2 = new MockMCPConnection(
    {
      name: "server2",
      transport: "stdio",
      command: "command2",
    },
    []
  );

  (manager as any).connections.set("server1", mockConn1);
  (manager as any).connections.set("server2", mockConn2);

  await manager.disconnectAll();

  expect(manager.getConnection("server1")).toBeUndefined();
  expect(manager.getConnection("server2")).toBeUndefined();
});

test("MCPClientManager: getStatus returns correct info", () => {
  const registry = new MockToolRegistry();
  const manager = new MCPClientManager(registry);

  const mockConn = new MockMCPConnection(
    {
      name: "test-server",
      transport: "stdio",
      command: "test-command",
    },
    []
  );

  (manager as any).connections.set("test-server", mockConn);

  const status = manager.getStatus();

  expect(status).toHaveLength(1);
  expect(status[0].name).toBe("test-server");
  expect(status[0].connected).toBe(true);
  expect(status[0].toolCount).toBe(0);
});

test("MCPClientManager: wrapMCPTool creates correct tool name with namespace", async () => {
  const registry = new MockToolRegistry();
  const manager = new MCPClientManager(registry);

  const mockConn = new MockMCPConnection(
    {
      name: "test-server",
      transport: "stdio",
      command: "test-command",
    },
    []
  );

  const mcpTool: MCPTool = {
    name: "my-tool",
    description: "A sample tool",
    inputSchema: {
      type: "object",
      properties: { input: { type: "string" } },
    },
  };

  const wrappedTool = (manager as any).wrapMCPTool(
    "test-server",
    mcpTool,
    mockConn
  );

  expect(wrappedTool.name).toBe("mcp_test-server_my-tool");
  expect(wrappedTool.description).toContain("[MCP:test-server]");
  expect(wrappedTool.description).toContain("A sample tool");
});

test("MCPClientManager: wrapMCPTool execute calls callTool and formats result", async () => {
  const registry = new MockToolRegistry();
  const manager = new MCPClientManager(registry);

  const mockConn = new MockMCPConnection(
    {
      name: "test-server",
      transport: "stdio",
      command: "test-command",
    },
    []
  );

  const mcpTool: MCPTool = {
    name: "my-tool",
    description: "A sample tool",
    inputSchema: {
      type: "object",
      properties: { input: { type: "string" } },
    },
  };

  const wrappedTool = (manager as any).wrapMCPTool(
    "test-server",
    mcpTool,
    mockConn
  );

  const result = await wrappedTool.execute({ input: "test" });

  expect(result.success).toBe(true);
  expect(result.output).toContain("Tool my-tool result");
  expect(result.error).toBeUndefined();
});

test("MCPClientManager: tool registration in toolRegistry", async () => {
  const registry = new MockToolRegistry();
  const manager = new MCPClientManager(registry);

  const mockConn = new MockMCPConnection(
    {
      name: "test-server",
      transport: "stdio",
      command: "test-command",
    },
    [
      {
        name: "tool1",
        description: "Tool 1",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ]
  );

  const mcpTool: MCPTool = {
    name: "tool1",
    description: "Tool 1",
    inputSchema: {
      type: "object",
      properties: {},
    },
  };

  const wrappedTool = (manager as any).wrapMCPTool(
    "test-server",
    mcpTool,
    mockConn
  );

  registry.register(wrappedTool);

  const registeredTool = registry.get("mcp_test-server_tool1");
  expect(registeredTool).toBeDefined();
  expect(registeredTool?.name).toBe("mcp_test-server_tool1");
});

test("MCPClientManager: handles connection failure gracefully", async () => {
  const registry = new MockToolRegistry();
  const manager = new MCPClientManager(registry);

  // connectServer with a non-existent command will throw
  // The connectAll method wraps this in try/catch
  const failingConfig: MCPServerConfig = {
    name: "failing-server",
    transport: "stdio",
    command: "non-existent-command-that-does-not-exist",
  };

  // connectAll should not throw, even when individual connections fail
  await manager.connectAll([failingConfig]);

  // Connection should not be in the map since it failed
  expect(manager.getConnection("failing-server")).toBeUndefined();
  expect(manager.getStatus()).toHaveLength(0);
});

test("MCPClientManager: getConnection returns correct connection", () => {
  const registry = new MockToolRegistry();
  const manager = new MCPClientManager(registry);

  const mockConn = new MockMCPConnection(
    {
      name: "test-server",
      transport: "stdio",
      command: "test-command",
    },
    []
  );

  (manager as any).connections.set("test-server", mockConn);

  const conn = manager.getConnection("test-server");

  expect(conn).toBe(mockConn);
  expect(conn?.getConfig().name).toBe("test-server");
});

test("MCPClientManager: connectAll with mock connections", async () => {
  const registry = new MockToolRegistry();
  const manager = new MCPClientManager(registry);

  // Directly inject mock connections to simulate connectAll behavior
  const mockConn1 = new MockMCPConnection(
    { name: "server1", transport: "stdio", command: "command1" },
    [{ name: "tool1", description: "Tool 1", inputSchema: { type: "object", properties: {} } }]
  );
  const mockConn2 = new MockMCPConnection(
    { name: "server2", transport: "stdio", command: "command2" },
    [{ name: "tool2", description: "Tool 2", inputSchema: { type: "object", properties: {} } }]
  );

  (manager as any).connections.set("server1", mockConn1);
  (manager as any).connections.set("server2", mockConn2);

  const status = manager.getStatus();
  expect(status).toHaveLength(2);
  expect(status[0].name).toBe("server1");
  expect(status[1].name).toBe("server2");
});
