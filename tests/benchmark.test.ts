import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { OllamaProvider } from "../src/providers/OllamaProvider.js";
import { AgentLoop } from "../src/agents/AgentLoop.js";
import {
  ILLMProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  GenerateResponseOptions,
  LLMProviderType,
} from "../src/providers/LLMProvider.js";
import * as fs from "fs/promises";
import * as path from "path";

// ========================================
// ベンチマーク設定
// ========================================
const BENCH_DIR = "/tmp/lunacode-benchmark";
const ITERATIONS = 5; // 各テストの繰り返し回数

// 利用可能な Ollama モデルを自動検出
let availableModels: string[] = [];
let ollamaAvailable = false;

// ========================================
// ヘルパー関数
// ========================================

/** 実行時間を計測 */
async function measure<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  return { result, ms };
}

/** 統計情報を計算 */
function stats(times: number[]): { avg: number; min: number; max: number; p50: number; p95: number } {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    avg: times.reduce((a, b) => a + b, 0) / times.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
  };
}

/** 結果テーブルを表示 */
function printTable(title: string, rows: Array<Record<string, string | number>>) {
  console.log(`\n📊 ${title}`);
  console.log("─".repeat(70));
  if (rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) =>
    Math.max(k.length, ...rows.map((r) => String(r[k]).length)),
  );
  console.log(keys.map((k, i) => k.padEnd(widths[i])).join(" │ "));
  console.log(widths.map((w) => "─".repeat(w)).join("─┼─"));
  for (const row of rows) {
    console.log(keys.map((k, i) => String(row[k]).padEnd(widths[i])).join(" │ "));
  }
  console.log("");
}

// ========================================
// セットアップ
// ========================================

beforeAll(async () => {
  await fs.rm(BENCH_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(BENCH_DIR, ".kairos"), { recursive: true });
  await fs.writeFile(
    path.join(BENCH_DIR, ".kairos", "config.json"),
    JSON.stringify({ llm: { provider: "ollama" }, agent: { maxIterations: 5 } }),
  );

  try {
    const res = await fetch("http://localhost:11434/api/tags");
    if (res.ok) {
      ollamaAvailable = true;
      const data = (await res.json()) as { models: Array<{ name: string }> };
      availableModels = data.models.map((m) => m.name);
      console.log(`\n✅ Ollama available. Models: ${availableModels.join(", ")}`);
    }
  } catch {
    console.log("\n⚠️  Ollama not available. Skipping LLM benchmarks.");
  }
});

afterAll(async () => {
  await fs.rm(BENCH_DIR, { recursive: true, force: true }).catch(() => {});
});

// ========================================
// 1. ツール実行速度ベンチマーク
// ========================================

describe("ベンチマーク: ツール実行速度", () => {
  let registry: ToolRegistry;

  beforeAll(() => {
    registry = new ToolRegistry();
  });

  test("write_file の実行速度", async () => {
    const times: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const filePath = path.join(BENCH_DIR, `bench-write-${i}.txt`);
      const { ms } = await measure(() =>
        registry.executeTool("write_file", {
          path: filePath,
          content: "x".repeat(10000), // 10KB
        }),
      );
      times.push(ms);
    }
    const s = stats(times);
    printTable("write_file (10KB)", [
      { metric: "avg", value: `${s.avg.toFixed(2)}ms` },
      { metric: "min", value: `${s.min.toFixed(2)}ms` },
      { metric: "max", value: `${s.max.toFixed(2)}ms` },
      { metric: "p50", value: `${s.p50.toFixed(2)}ms` },
    ]);
    expect(s.avg).toBeLessThan(100); // 100ms 以下であること
  });

  test("read_file の実行速度", async () => {
    const filePath = path.join(BENCH_DIR, "bench-read.txt");
    await fs.writeFile(filePath, "x".repeat(100000)); // 100KB

    const times: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const { ms } = await measure(() =>
        registry.executeTool("read_file", { path: filePath }),
      );
      times.push(ms);
    }
    const s = stats(times);
    printTable("read_file (100KB)", [
      { metric: "avg", value: `${s.avg.toFixed(2)}ms` },
      { metric: "min", value: `${s.min.toFixed(2)}ms` },
      { metric: "max", value: `${s.max.toFixed(2)}ms` },
      { metric: "p50", value: `${s.p50.toFixed(2)}ms` },
    ]);
    expect(s.avg).toBeLessThan(100);
  });

  test("edit_file の実行速度", async () => {
    const times: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const filePath = path.join(BENCH_DIR, `bench-edit-${i}.txt`);
      await fs.writeFile(filePath, "Hello World ".repeat(1000));
      const { ms } = await measure(() =>
        registry.executeTool("edit_file", {
          path: filePath,
          oldString: "Hello World",
          newString: "Hello LunaCode",
        }),
      );
      times.push(ms);
    }
    const s = stats(times);
    printTable("edit_file (12KB, first match)", [
      { metric: "avg", value: `${s.avg.toFixed(2)}ms` },
      { metric: "min", value: `${s.min.toFixed(2)}ms` },
      { metric: "max", value: `${s.max.toFixed(2)}ms` },
      { metric: "p50", value: `${s.p50.toFixed(2)}ms` },
    ]);
    expect(s.avg).toBeLessThan(100);
  });

  test("bash の実行速度", async () => {
    const times: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const { ms } = await measure(() =>
        registry.executeTool("bash", { command: "echo benchmark" }),
      );
      times.push(ms);
    }
    const s = stats(times);
    printTable("bash (echo)", [
      { metric: "avg", value: `${s.avg.toFixed(2)}ms` },
      { metric: "min", value: `${s.min.toFixed(2)}ms` },
      { metric: "max", value: `${s.max.toFixed(2)}ms` },
      { metric: "p50", value: `${s.p50.toFixed(2)}ms` },
    ]);
    expect(s.avg).toBeLessThan(200);
  });
});

// ========================================
// 2. LLM 応答時間ベンチマーク
// ========================================

describe("ベンチマーク: LLM 応答時間", () => {
  test("モデル別 応答速度比較", async () => {
    if (!ollamaAvailable) return;

    const results: Array<Record<string, string | number>> = [];

    for (const model of availableModels) {
      const provider = new OllamaProvider({ type: "ollama", model });

      try {
        const { ms } = await measure(() =>
          provider.chatCompletion({
            model,
            messages: [{ role: "user", content: "Reply with just: OK" }],
            max_tokens: 10,
          }),
        );
        results.push({
          model: model.substring(0, 25),
          latency: `${ms.toFixed(0)}ms`,
          status: "✅",
        });
      } catch (e) {
        results.push({
          model: model.substring(0, 25),
          latency: "N/A",
          status: "❌",
        });
      }
    }

    printTable("LLM 応答時間（簡易プロンプト）", results);
    expect(results.length).toBeGreaterThan(0);
  }, 120000);
});

// ========================================
// 3. ツール呼び出し検出精度ベンチマーク
// ========================================

describe("ベンチマーク: ツール呼び出し検出精度", () => {
  test("モデル別 ツール検出率", async () => {
    if (!ollamaAvailable) return;

    const results: Array<Record<string, string | number>> = [];

    for (const model of availableModels) {
      const provider = new OllamaProvider({ type: "ollama", model });

      let detected = 0;
      let total = 3;
      let totalMs = 0;

      const prompts = [
        'Create a file called test.txt with content "hello". Use the write_file tool.',
        "Read the file at /tmp/test.txt. Use the read_file tool.",
        'Run the command "echo hello" using the bash tool.',
      ];

      const tools = [
        {
          type: "function" as const,
          function: {
            name: "write_file",
            description: "Write content to a file",
            parameters: {
              type: "object" as const,
              properties: {
                path: { type: "string", description: "File path" },
                content: { type: "string", description: "Content" },
              },
              required: ["path", "content"],
            },
          },
        },
        {
          type: "function" as const,
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: {
              type: "object" as const,
              properties: {
                path: { type: "string", description: "File path" },
              },
              required: ["path"],
            },
          },
        },
        {
          type: "function" as const,
          function: {
            name: "bash",
            description: "Execute a bash command",
            parameters: {
              type: "object" as const,
              properties: {
                command: { type: "string", description: "Command" },
              },
              required: ["command"],
            },
          },
        },
      ];

      for (const prompt of prompts) {
        try {
          const { result, ms } = await measure(() =>
            provider.chatCompletion({
              model,
              messages: [{ role: "user", content: prompt }],
              tools,
              max_tokens: 500,
            }),
          );
          totalMs += ms;
          const msg = result.choices[0].message;
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            detected++;
          }
        } catch {
          // エラーは検出失敗としてカウント
        }
      }

      const rate = ((detected / total) * 100).toFixed(0);
      const avgMs = (totalMs / total).toFixed(0);
      results.push({
        model: model.substring(0, 25),
        "検出率": `${rate}% (${detected}/${total})`,
        "平均応答": `${avgMs}ms`,
        grade: Number(rate) >= 100 ? "⭐" : Number(rate) >= 66 ? "✅" : Number(rate) >= 33 ? "⚠️" : "❌",
      });
    }

    printTable("ツール呼び出し検出精度", results);
    expect(results.length).toBeGreaterThan(0);
  }, 300000);
});

// ========================================
// 4. E2E タスク完了ベンチマーク
// ========================================

describe("ベンチマーク: E2E タスク完了", () => {
  /** モック LLM: 必ず write_file を呼ぶ */
  class BenchmarkMockProvider implements ILLMProvider {
    private callCount = 0;
    async chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      this.callCount++;
      const isFirst = this.callCount % 2 === 1;
      return {
        id: `mock-${this.callCount}`,
        object: "chat.completion",
        created: Date.now(),
        model: "mock",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: isFirst ? null : "Task completed.",
              tool_calls: isFirst
                ? [
                    {
                      id: `call_${this.callCount}`,
                      type: "function",
                      function: {
                        name: "write_file",
                        arguments: JSON.stringify({
                          path: path.join(BENCH_DIR, `e2e-${this.callCount}.txt`),
                          content: `File created by iteration ${this.callCount}`,
                        }),
                      },
                    },
                  ]
                : undefined,
            },
            finish_reason: isFirst ? "tool_calls" : "stop",
          },
        ],
      };
    }
    async generateResponse(): Promise<string> { return ""; }
    getType(): LLMProviderType { return "openai"; }
    getDefaultModel(): string { return "mock"; }
    async initialize(): Promise<void> {}
    async cleanup(): Promise<void> {}
    async testConnection(): Promise<boolean> { return true; }
  }

  test("モック LLM での E2E 実行速度", async () => {
    const times: number[] = [];
    const kairosPath = path.join(BENCH_DIR, ".kairos");

    for (let i = 0; i < ITERATIONS; i++) {
      const provider = new BenchmarkMockProvider();
      const agent = new AgentLoop(provider, kairosPath);
      await agent.initialize();

      const { ms } = await measure(() =>
        agent.processUserInput("Create a test file"),
      );
      times.push(ms);
    }

    const s = stats(times);
    printTable("E2E タスク完了（モック LLM）", [
      { metric: "avg", value: `${s.avg.toFixed(2)}ms` },
      { metric: "min", value: `${s.min.toFixed(2)}ms` },
      { metric: "max", value: `${s.max.toFixed(2)}ms` },
      { metric: "p50", value: `${s.p50.toFixed(2)}ms` },
    ]);
    expect(s.avg).toBeLessThan(500);
  });

  test("実 Ollama での E2E ファイル作成", async () => {
    if (!ollamaAvailable) return;

    const results: Array<Record<string, string | number>> = [];
    const kairosPath = path.join(BENCH_DIR, ".kairos");

    for (const model of availableModels) {
      const provider = new OllamaProvider({ type: "ollama", model });
      const agent = new AgentLoop(provider, kairosPath);
      await agent.initialize();

      // maxIterations を強制的に制限（config 読み込みに頼らない）
      (agent as any).maxIterations = 5;
      (agent as any).state.maxIterations = 5;

      const targetFile = path.join(BENCH_DIR, `e2e-${model.replace(/[:/]/g, "_")}.js`);
      const prompt = `Create a file at ${targetFile} with content: console.log("hello from ${model}");`;

      try {
        const { ms } = await measure(() => agent.processUserInput(prompt));

        // ファイルが実際に作成されたか確認
        let fileCreated = false;
        try {
          await fs.access(targetFile);
          fileCreated = true;
        } catch {}

        results.push({
          model: model.substring(0, 25),
          latency: `${(ms / 1000).toFixed(1)}s`,
          "ファイル作成": fileCreated ? "✅" : "❌",
          iterations: agent.getState().iteration,
        });
      } catch (e) {
        results.push({
          model: model.substring(0, 25),
          latency: "timeout",
          "ファイル作成": "❌",
          iterations: 0,
        });
      }
    }

    printTable("E2E ファイル作成（実 Ollama）", results);
    expect(results.length).toBeGreaterThan(0);
  }, 600000);
});
