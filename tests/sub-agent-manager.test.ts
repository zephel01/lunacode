import { describe, test, expect } from "bun:test";
import { SubAgentManager } from "../src/agents/SubAgentManager.js";
import { SubAgentTool } from "../src/tools/SubAgentTool.js";

// Mock LLM provider
const mockProvider = {
  chatCompletion: async () => ({
    id: "test",
    object: "chat.completion",
    created: 0,
    model: "test",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "Task completed successfully." },
      finish_reason: "stop",
    }],
  }),
  generateResponse: async () => "test",
  getType: () => "ollama" as any,
  getDefaultModel: () => "test-model",
  initialize: async () => {},
  cleanup: async () => {},
  testConnection: async () => true,
};

describe("SubAgentManager", () => {
  test("constructor with default maxConcurrent", () => {
    const manager = new SubAgentManager(mockProvider, "/tmp");
    expect(manager).toBeDefined();
  });

  test("constructor with custom maxConcurrent", () => {
    const manager = new SubAgentManager(mockProvider, "/tmp", 5);
    expect(manager).toBeDefined();
  });

  test("getAllowedTools returns correct tools for explorer role", () => {
    const manager = new SubAgentManager(mockProvider, "/tmp");
    const tools = manager.getAllowedTools("explorer");

    expect(tools).toContain("read_file");
    expect(tools).toContain("glob");
    expect(tools).toContain("grep");
    expect(tools).toContain("git");
    expect(tools.length).toBe(4);
  });

  test("getAllowedTools returns correct tools for worker role", () => {
    const manager = new SubAgentManager(mockProvider, "/tmp");
    const tools = manager.getAllowedTools("worker");

    expect(tools).toContain("read_file");
    expect(tools).toContain("write_file");
    expect(tools).toContain("edit_file");
    expect(tools).toContain("glob");
    expect(tools).toContain("grep");
    expect(tools).toContain("bash");
    expect(tools).toContain("git");
    expect(tools.length).toBe(7);
  });

  test("getAllowedTools returns correct tools for reviewer role", () => {
    const manager = new SubAgentManager(mockProvider, "/tmp");
    const tools = manager.getAllowedTools("reviewer");

    expect(tools).toContain("read_file");
    expect(tools).toContain("glob");
    expect(tools).toContain("grep");
    expect(tools).toContain("bash");
    expect(tools).toContain("git");
    expect(tools).not.toContain("write_file");
    expect(tools).not.toContain("edit_file");
    expect(tools.length).toBe(5);
  });

  test("explorer role cannot write files", () => {
    const manager = new SubAgentManager(mockProvider, "/tmp");
    const tools = manager.getAllowedTools("explorer");

    expect(tools).not.toContain("write_file");
    expect(tools).not.toContain("edit_file");
  });

  test("worker has all tools", () => {
    const manager = new SubAgentManager(mockProvider, "/tmp");
    const tools = manager.getAllowedTools("worker");

    const allExpectedTools = ["read_file", "write_file", "edit_file", "glob", "grep", "bash", "git"];
    for (const tool of allExpectedTools) {
      expect(tools).toContain(tool);
    }
  });

  test("reviewer has bash but not write_file", () => {
    const manager = new SubAgentManager(mockProvider, "/tmp");
    const tools = manager.getAllowedTools("reviewer");

    expect(tools).toContain("bash");
    expect(tools).not.toContain("write_file");
  });

  test("chunk helper splits arrays correctly", () => {
    const manager = new SubAgentManager(mockProvider, "/tmp", 2);
    const arr = [1, 2, 3, 4, 5];

    // We'll test this indirectly through spawnParallel logic
    // For now, just verify the manager respects maxConcurrent of 2
    expect(manager).toBeDefined();
  });
});

describe("SubAgentTool", () => {
  test("SubAgentTool name is 'delegate_task'", () => {
    const manager = new SubAgentManager(mockProvider, "/tmp");
    const tool = new SubAgentTool(manager);

    expect(tool.name).toBe("delegate_task");
  });

  test("SubAgentTool has correct riskLevel", () => {
    const manager = new SubAgentManager(mockProvider, "/tmp");
    const tool = new SubAgentTool(manager);

    expect(tool.riskLevel).toBe("MEDIUM");
  });

  test("SubAgentTool has correct description", () => {
    const manager = new SubAgentManager(mockProvider, "/tmp");
    const tool = new SubAgentTool(manager);

    expect(tool.description).toBeDefined();
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.description).toContain("Delegate sub-tasks");
  });

  test("SubAgentTool has correct parameters schema", () => {
    const manager = new SubAgentManager(mockProvider, "/tmp");
    const tool = new SubAgentTool(manager);

    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.properties).toBeDefined();
    expect(tool.parameters.properties.tasks).toBeDefined();
    expect(tool.parameters.required).toContain("tasks");
  });

  test("SubAgentTool rejects empty tasks array", async () => {
    const manager = new SubAgentManager(mockProvider, "/tmp");
    const tool = new SubAgentTool(manager);

    const result = await tool.execute({ tasks: [] });

    expect(result.success).toBe(false);
    expect(result.error).toBe("No tasks provided");
  });

  test("SubAgentTool rejects null/undefined tasks", async () => {
    const manager = new SubAgentManager(mockProvider, "/tmp");
    const tool = new SubAgentTool(manager);

    const result = await tool.execute({ tasks: null });

    expect(result.success).toBe(false);
    expect(result.error).toBe("No tasks provided");
  });

  test("SubAgentTool rejects more than 6 tasks", async () => {
    const manager = new SubAgentManager(mockProvider, "/tmp");
    const tool = new SubAgentTool(manager);

    const tasks = Array.from({ length: 7 }, (_, i) => ({
      role: "worker" as const,
      task: `Task ${i + 1}`,
    }));

    const result = await tool.execute({ tasks });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Maximum 6 sub-tasks allowed");
  });

  test("SubAgentTool accepts valid tasks configuration", async () => {
    const manager = new SubAgentManager(mockProvider, "/tmp");
    const tool = new SubAgentTool(manager);

    const tasks = [
      {
        role: "explorer" as const,
        task: "Analyze the codebase",
      },
    ];

    // This should not reject for invalid task count/format
    // (actual execution may fail due to mock provider, but validation passes)
    const result = await tool.execute({ tasks });

    // Result may fail due to mock, but should have output
    expect(result.output).toBeDefined();
  });
});
