import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AgentLoop } from "../src/agents/AgentLoop.js";
import {
  ILLMProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  GenerateResponseOptions,
  LLMProviderType,
} from "../src/providers/LLMProvider.js";
import { ConfigManager } from "../src/config/ConfigManager.js";
import * as fs from "fs/promises";
import * as path from "path";

const TEST_DIR = "/tmp/lunacode-test-agent";

/**
 * モック LLM プロバイダー
 * テストシナリオに応じたレスポンスを返す
 */
class MockLLMProvider implements ILLMProvider {
  private responses: Array<{
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  }>;
  private callIndex = 0;
  private providerType: LLMProviderType;

  constructor(
    responses: Array<{
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }>,
    providerType: LLMProviderType = "openai",
  ) {
    this.responses = responses;
    this.providerType = providerType;
  }

  async chatCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const response =
      this.responses[Math.min(this.callIndex, this.responses.length - 1)];
    this.callIndex++;

    return {
      id: `mock-${this.callIndex}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "mock",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: response.content,
            tool_calls: response.tool_calls,
          },
          finish_reason: response.tool_calls ? "tool_calls" : "stop",
        },
      ],
    };
  }

  async generateResponse(
    prompt: string,
    options?: GenerateResponseOptions,
  ): Promise<string> {
    return "Mock response";
  }

  getType(): LLMProviderType {
    return this.providerType;
  }
  getDefaultModel(): string {
    return "mock-model";
  }
  async initialize(): Promise<void> {}
  async cleanup(): Promise<void> {}
  async testConnection(): Promise<boolean> {
    return true;
  }
}

describe("AgentLoop", () => {
  beforeAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_DIR, ".kairos"), { recursive: true });
    await fs.writeFile(
      path.join(TEST_DIR, ".kairos", "config.json"),
      JSON.stringify({
        llm: { provider: "openai" },
        agent: { maxIterations: 10 },
      }),
    );
  });

  afterAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test("テキストのみのレスポンスで正常終了する", async () => {
    const provider = new MockLLMProvider([
      { content: "Hello! I can help you with that." },
    ]);

    const kairosPath = path.join(TEST_DIR, ".kairos");
    const agent = new AgentLoop(provider, kairosPath);
    await agent.initialize();

    const response = await agent.processUserInput("Hello");
    expect(response).toBe("Hello! I can help you with that.");
  });

  test("ツール呼び出し後にレスポンスを返す", async () => {
    const writeFilePath = path.join(TEST_DIR, "agent-test.txt");
    const provider = new MockLLMProvider([
      {
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: writeFilePath,
                content: "Hello from Agent test!",
              }),
            },
          },
        ],
      },
      { content: "File has been created successfully." },
    ]);

    const kairosPath = path.join(TEST_DIR, ".kairos");
    const agent = new AgentLoop(provider, kairosPath);
    await agent.initialize();

    const response = await agent.processUserInput("Create a file");
    expect(response).toBe("File has been created successfully.");

    // ファイルが実際に作成されたか確認
    const content = await fs.readFile(writeFilePath, "utf-8");
    expect(content).toBe("Hello from Agent test!");
  });

  test("複数ツール呼び出しが実行される", async () => {
    const file1 = path.join(TEST_DIR, "multi-1.txt");
    const file2 = path.join(TEST_DIR, "multi-2.txt");

    const provider = new MockLLMProvider([
      {
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: file1, content: "File 1" }),
            },
          },
          {
            id: "call_2",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: file2, content: "File 2" }),
            },
          },
        ],
      },
      { content: "Both files created." },
    ]);

    const kairosPath = path.join(TEST_DIR, ".kairos");
    const agent = new AgentLoop(provider, kairosPath);
    await agent.initialize();

    const response = await agent.processUserInput("Create two files");
    expect(response).toBe("Both files created.");

    const content1 = await fs.readFile(file1, "utf-8");
    const content2 = await fs.readFile(file2, "utf-8");
    expect(content1).toBe("File 1");
    expect(content2).toBe("File 2");
  });

  test("ツール実行失敗時もループが継続する", async () => {
    const provider = new MockLLMProvider([
      {
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "/nonexistent/file.txt" }),
            },
          },
        ],
      },
      { content: "The file does not exist." },
    ]);

    const kairosPath = path.join(TEST_DIR, ".kairos");
    const agent = new AgentLoop(provider, kairosPath);
    await agent.initialize();

    const response = await agent.processUserInput("Read a nonexistent file");
    expect(response).toBe("The file does not exist.");
  });

  test("write → read → edit の連続ツール実行", async () => {
    const filePath = path.join(TEST_DIR, "chain-test.txt");

    const provider = new MockLLMProvider([
      // Step 1: write_file
      {
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: filePath,
                content: "Hello World",
              }),
            },
          },
        ],
      },
      // Step 2: read_file
      {
        content: null,
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: filePath }),
            },
          },
        ],
      },
      // Step 3: edit_file
      {
        content: null,
        tool_calls: [
          {
            id: "call_3",
            type: "function",
            function: {
              name: "edit_file",
              arguments: JSON.stringify({
                path: filePath,
                oldString: "World",
                newString: "LunaCode",
              }),
            },
          },
        ],
      },
      // Step 4: 完了
      { content: "File created, read, and edited successfully." },
    ]);

    const kairosPath = path.join(TEST_DIR, ".kairos");
    const agent = new AgentLoop(provider, kairosPath);
    await agent.initialize();

    const response = await agent.processUserInput(
      "Create, read, and edit a file",
    );
    expect(response).toBe("File created, read, and edited successfully.");

    // ファイルが正しく編集されたか確認
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("Hello LunaCode");
  });

  test("状態がリセットされる", () => {
    const provider = new MockLLMProvider([]);
    const kairosPath = path.join(TEST_DIR, ".kairos");
    const agent = new AgentLoop(provider, kairosPath);

    agent.reset();
    const state = agent.getState();
    expect(state.phase).toBe("INIT");
    expect(state.iteration).toBe(0);
    expect(state.action).toBeNull();
    expect(state.observation).toBeNull();
  });
});
