#!/usr/bin/env bun

/**
 * モック LLM プロバイダーを使用したエージェントテスト
 * ツール実行パイプラインが正しく動作することを確認
 */

import { AgentLoop } from "./src/agents/AgentLoop.js";
import { ILLMProvider, ChatCompletionRequest, ChatCompletionResponse } from "./src/providers/LLMProvider.js";
import { ConfigManager } from "./src/config/ConfigManager.js";
import * as path from "path";
import * as fs from "fs/promises";

/**
 * モック LLM プロバイダー
 * 常に特定のツール呼び出しを返す
 */
class MockLLMProvider implements ILLMProvider {
  private callCount = 0;
  private responses = [
    // ラウンド1: ファイルを作成
    {
      content: "I'll create a test file with some JavaScript code.",
      tool_calls: [
        {
          id: "call_1",
          type: "function" as const,
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              path: "/tmp/test-agent/hello.js",
              content: 'console.log("Hello from Agent");',
            }),
          },
        },
      ],
    },
    // ラウンド2: ファイルを読み取る
    {
      content: "Let me read the file I just created.",
      tool_calls: [
        {
          id: "call_2",
          type: "function" as const,
          function: {
            name: "read_file",
            arguments: JSON.stringify({
              path: "/tmp/test-agent/hello.js",
            }),
          },
        },
      ],
    },
    // ラウンド3: ファイルを編集
    {
      content: "Now I'll modify the file.",
      tool_calls: [
        {
          id: "call_3",
          type: "function" as const,
          function: {
            name: "edit_file",
            arguments: JSON.stringify({
              path: "/tmp/test-agent/hello.js",
              oldString: 'console.log("Hello from Agent");',
              newString: 'console.log("Hello from Agent - MODIFIED!");',
            }),
          },
        },
      ],
    },
    // ラウンド4: 完了
    {
      content: "Task completed successfully! I have created and modified the file.",
      tool_calls: undefined,
    },
  ];

  async initialize(): Promise<void> {
    console.log("[MockProvider] Initialized");
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const response = this.responses[Math.min(this.callCount, this.responses.length - 1)];
    this.callCount++;

    return {
      id: `mock-${this.callCount}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "mock-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: response.content,
            tool_calls: response.tool_calls,
          },
          finish_reason: "stop",
        },
      ],
    };
  }

  async generateResponse(): Promise<string> {
    return "Mock response";
  }

  getType(): "openai" {
    return "openai";
  }

  getDefaultModel(): string {
    return "mock-model";
  }

  async cleanup(): Promise<void> {}
}

async function main() {
  const testDir = "/tmp/test-agent";

  // クリーンアップ
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch {}
  await fs.mkdir(testDir, { recursive: true });

  const kairosPath = path.join(testDir, ".kairos");
  await fs.mkdir(kairosPath, { recursive: true });

  // テスト設定
  await fs.writeFile(
    path.join(kairosPath, "config.json"),
    JSON.stringify({
      llm: { provider: "openai" },
      agent: { maxIterations: 10 },
    }),
  );

  console.log("🧪 Agent Tool Execution Test with Mock LLM");
  console.log("─".repeat(60));
  console.log(`📁 Test directory: ${testDir}\n`);

  const configManager = new ConfigManager(kairosPath);
  const mockProvider = new MockLLMProvider();
  const agent = new AgentLoop(mockProvider, kairosPath, configManager);

  await agent.initialize();

  console.log("🚀 Processing user input...\n");
  const response = await agent.processUserInput("Create and modify a test file");

  console.log("\n" + "─".repeat(60));
  console.log("📊 Final Response:");
  console.log(response);

  console.log("\n" + "─".repeat(60));
  console.log("✅ Test completed!");

  // 結果確認
  console.log("\n📁 Files created:");
  try {
    const files = await fs.readdir(testDir);
    for (const file of files) {
      const stat = await fs.stat(path.join(testDir, file));
      if (stat.isFile()) {
        console.log(`  - ${file}`);
      }
    }

    // ファイル内容確認
    const helloJsPath = path.join(testDir, "hello.js");
    try {
      const content = await fs.readFile(helloJsPath, "utf-8");
      console.log(`\n📄 Content of hello.js:`);
      console.log(`  ${content}`);
    } catch {
      console.log(`\n⚠️  hello.js not found`);
    }
  } catch (error) {
    console.log(`  Error: ${error}`);
  }
}

main().catch(console.error);
