import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { OllamaProvider } from "../src/providers/OllamaProvider.js";
import { AgentLoop } from "../src/agents/AgentLoop.js";
import * as fs from "fs/promises";
import * as path from "path";

// ========================================
// 実践コーディングタスクテスト
// 推奨8モデルで簡単なスクリプト作成を検証
// ========================================

const TEST_DIR = "/tmp/lunacode-coding-test";
const KAIROS_PATH = path.join(TEST_DIR, ".kairos");

// 推奨モデル（ベンチマークで成功した8モデル）
const RECOMMENDED_MODELS = [
  "llama3.1:latest",
  "qwen3.5:4b",
  "gemma4:e4b",
  "qwen2.5:14b",
  "mistral:7b-instruct",
  "qcwind/qwen2.5-7B-instruct:latest",
  "qwen2.5:1.5b",
];

let ollamaAvailable = false;
let installedModels: string[] = [];

/** 結果テーブルを表示 */
function printTable(title: string, rows: Array<Record<string, string | number>>) {
  console.log(`\n📊 ${title}`);
  console.log("─".repeat(90));
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

/** モデル単位のタイムアウト付き実行 */
async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

const MODEL_TIMEOUT = 60000; // モデルごとに最大60秒

/** ファイルの存在と内容を検証 */
async function verifyFile(
  filePath: string,
  checks: { exists?: boolean; contains?: string[]; minLength?: number },
): Promise<{ pass: boolean; details: string }> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const failures: string[] = [];

    if (checks.minLength && content.length < checks.minLength) {
      failures.push(`length ${content.length} < ${checks.minLength}`);
    }
    if (checks.contains) {
      for (const keyword of checks.contains) {
        if (!content.includes(keyword)) {
          failures.push(`missing: "${keyword}"`);
        }
      }
    }

    if (failures.length > 0) {
      return { pass: false, details: failures.join(", ") };
    }
    return { pass: true, details: `${content.length} bytes` };
  } catch {
    if (checks.exists === false) {
      return { pass: true, details: "correctly not created" };
    }
    return { pass: false, details: "file not found" };
  }
}

// ========================================
// セットアップ
// ========================================

beforeAll(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(KAIROS_PATH, { recursive: true });
  await fs.writeFile(
    path.join(KAIROS_PATH, "config.json"),
    JSON.stringify({
      llm: { provider: "ollama" },
      agent: { maxIterations: 5 },
    }),
  );

  try {
    const res = await fetch("http://localhost:11434/api/tags");
    if (res.ok) {
      ollamaAvailable = true;
      const data = (await res.json()) as { models: Array<{ name: string }> };
      const allModels = data.models.map((m) => m.name);
      // インストール済みの推奨モデルのみ使用
      installedModels = RECOMMENDED_MODELS.filter((m) =>
        allModels.some((am) => am === m || am.startsWith(m.split(":")[0])),
      );
      console.log(`\n✅ Ollama available. Testing ${installedModels.length} models: ${installedModels.join(", ")}`);
    }
  } catch {
    console.log("\n⚠️  Ollama not available. Skipping coding task tests.");
  }
});

afterAll(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
});

// ========================================
// タスク1: hello.js 作成（基本動作確認）
// ========================================

describe("コーディングタスク: hello.js 作成", () => {
  test("全推奨モデルで hello.js を作成", async () => {
    if (!ollamaAvailable || installedModels.length === 0) return;

    const results: Array<Record<string, string | number>> = [];

    for (const model of installedModels) {
      const modelDir = path.join(TEST_DIR, `hello-${model.replace(/[:/]/g, "_")}`);
      await fs.mkdir(modelDir, { recursive: true });

      const provider = new OllamaProvider({ type: "ollama", model });
      const agent = new AgentLoop(provider, KAIROS_PATH);
      await agent.initialize();

      const targetFile = path.join(modelDir, "hello.js");
      const prompt = `Create a file at ${targetFile} with this JavaScript code:
const greeting = "Hello from LunaCode";
console.log(greeting);
console.log("Model: ${model}");`;

      const start = performance.now();
      try {
        await withTimeout(() => agent.processUserInput(prompt), MODEL_TIMEOUT);
        const ms = performance.now() - start;

        const verification = await verifyFile(targetFile, {
          exists: true,
          contains: ["console.log"],
          minLength: 10,
        });

        results.push({
          model: model.substring(0, 28),
          latency: `${(ms / 1000).toFixed(1)}s`,
          ファイル作成: verification.pass ? "✅" : "❌",
          内容検証: verification.pass ? "✅" : `❌ ${verification.details}`,
          iterations: agent.getState().iteration,
        });
      } catch (e) {
        const ms = performance.now() - start;
        results.push({
          model: model.substring(0, 28),
          latency: `${(ms / 1000).toFixed(1)}s`,
          ファイル作成: "❌",
          内容検証: `❌ error: ${e instanceof Error ? e.message.substring(0, 30) : "unknown"}`,
          iterations: agent.getState().iteration,
        });
      }
    }

    printTable("タスク1: hello.js 作成", results);

    // 少なくとも半分のモデルが成功すること
    const successCount = results.filter((r) => r.ファイル作成 === "✅").length;
    console.log(`\n✅ 成功: ${successCount}/${results.length} モデル`);
    expect(successCount).toBeGreaterThan(results.length / 2);
  }, 600000);
});

// ========================================
// タスク2: FizzBuzz 実装（ロジック生成能力）
// ========================================

describe("コーディングタスク: FizzBuzz 実装", () => {
  test("全推奨モデルで FizzBuzz を実装", async () => {
    if (!ollamaAvailable || installedModels.length === 0) return;

    const results: Array<Record<string, string | number>> = [];

    for (const model of installedModels) {
      const modelDir = path.join(TEST_DIR, `fizzbuzz-${model.replace(/[:/]/g, "_")}`);
      await fs.mkdir(modelDir, { recursive: true });

      const provider = new OllamaProvider({ type: "ollama", model });
      const agent = new AgentLoop(provider, KAIROS_PATH);
      await agent.initialize();

      const targetFile = path.join(modelDir, "fizzbuzz.js");
      const prompt = `Create a file at ${targetFile} with this exact JavaScript program:

for (let i = 1; i <= 100; i++) {
  if (i % 15 === 0) console.log("FizzBuzz");
  else if (i % 3 === 0) console.log("Fizz");
  else if (i % 5 === 0) console.log("Buzz");
  else console.log(i);
}

Write EXACTLY this code to the file. Do not modify it.`;

      const start = performance.now();
      try {
        await withTimeout(() => agent.processUserInput(prompt), MODEL_TIMEOUT);
        const ms = performance.now() - start;

        const verification = await verifyFile(targetFile, {
          exists: true,
          contains: ["Fizz", "Buzz", "console.log"],
          minLength: 50,
        });

        // 生成コードの内容をログ出力
        try {
          const code = await fs.readFile(targetFile, "utf-8");
          console.log(`\n📝 [${model}] 生成コード:\n${code.substring(0, 500)}`);
        } catch {}

        // 実行可能か検証（Node.js で実行）
        let execResult = "skip";
        if (verification.pass) {
          try {
            const proc = Bun.spawn(["node", targetFile], {
              stdout: "pipe",
              stderr: "pipe",
            });
            const output = await new Response(proc.stdout).text();
            const stderr = await new Response(proc.stderr).text();
            const exitCode = await proc.exited;

            // 出力のサンプルをログ
            const outputLines = output.split("\n").filter(Boolean);
            console.log(`📤 [${model}] 出力サンプル (${outputLines.length}行): ${outputLines.slice(0, 5).join(", ")} ...`);
            console.log(`📤 [${model}] FizzBuzz含有: FB=${output.includes("FizzBuzz")}, F=${output.includes("Fizz")}, B=${output.includes("Buzz")}`);
            if (stderr) console.log(`⚠️ [${model}] stderr: ${stderr.substring(0, 200)}`);

            // 大文字小文字を区別しない判定
            const lowerOutput = output.toLowerCase();
            if (exitCode === 0 && lowerOutput.includes("fizzbuzz") && lowerOutput.includes("fizz") && lowerOutput.includes("buzz")) {
              execResult = "✅ 正常実行";
            } else if (exitCode === 0) {
              execResult = `⚠️ 出力不一致`;
            } else {
              execResult = `❌ exit=${exitCode}`;
            }
          } catch {
            execResult = "❌ 実行エラー";
          }
        }

        results.push({
          model: model.substring(0, 28),
          latency: `${(ms / 1000).toFixed(1)}s`,
          ファイル作成: verification.pass ? "✅" : "❌",
          実行結果: execResult,
          iterations: agent.getState().iteration,
        });
      } catch (e) {
        const ms = performance.now() - start;
        results.push({
          model: model.substring(0, 28),
          latency: `${(ms / 1000).toFixed(1)}s`,
          ファイル作成: "❌",
          実行結果: "❌ error",
          iterations: agent.getState().iteration,
        });
      }
    }

    printTable("タスク2: FizzBuzz 実装", results);

    const successCount = results.filter((r) => r.実行結果 === "✅ 正常実行").length;
    console.log(`\n✅ 正常実行: ${successCount}/${results.length} モデル`);
    expect(successCount).toBeGreaterThan(0);
  }, 600000);
});

// ========================================
// タスク3: JSONデータ処理（実用的なスクリプト）
// ========================================

describe("コーディングタスク: JSONデータ処理", () => {
  test("全推奨モデルで JSON 処理スクリプトを作成", async () => {
    if (!ollamaAvailable || installedModels.length === 0) return;

    const results: Array<Record<string, string | number>> = [];

    // 入力データ（配列形式 — モデルが .users アクセスを忘れないように）
    const inputData = JSON.stringify([
      { name: "Alice", age: 30, active: true },
      { name: "Bob", age: 25, active: false },
      { name: "Charlie", age: 35, active: true },
    ]);

    for (const model of installedModels) {
      const modelDir = path.join(TEST_DIR, `json-${model.replace(/[:/]/g, "_")}`);
      await fs.mkdir(modelDir, { recursive: true });

      // 入力ファイルを作成
      const inputFile = path.join(modelDir, "data.json");
      await fs.writeFile(inputFile, inputData);

      const provider = new OllamaProvider({ type: "ollama", model });
      const agent = new AgentLoop(provider, KAIROS_PATH);
      await agent.initialize();

      const targetFile = path.join(modelDir, "process.js");
      const prompt = `Create a file at ${targetFile} with a Node.js script that:
1. Reads ${inputFile} using fs.readFileSync
2. Parses the JSON (the file contains a JSON array of user objects)
3. Each user has: name (string), age (number), active (boolean)
4. Filters only users where active === true
5. Prints each active user's name and age with console.log
Expected output should include "Alice" and "Charlie" but not "Bob".`;

      const start = performance.now();
      try {
        await withTimeout(() => agent.processUserInput(prompt), MODEL_TIMEOUT);
        const ms = performance.now() - start;

        const verification = await verifyFile(targetFile, {
          exists: true,
          contains: ["readFileSync", "JSON"],
          minLength: 30,
        });

        // 実行可能か検証
        let execResult = "skip";
        if (verification.pass) {
          try {
            const proc = Bun.spawn(["node", targetFile], {
              stdout: "pipe",
              stderr: "pipe",
            });
            const output = await new Response(proc.stdout).text();
            const exitCode = await proc.exited;
            if (exitCode === 0 && output.includes("Alice") && output.includes("Charlie") && !output.includes("Bob")) {
              execResult = "✅ 完全一致";
            } else if (exitCode === 0 && (output.includes("Alice") || output.includes("Charlie"))) {
              execResult = "⚠️ 部分一致";
            } else {
              execResult = `❌ exit=${exitCode}`;
            }
          } catch {
            execResult = "❌ 実行エラー";
          }
        }

        results.push({
          model: model.substring(0, 28),
          latency: `${(ms / 1000).toFixed(1)}s`,
          ファイル作成: verification.pass ? "✅" : "❌",
          実行結果: execResult,
          iterations: agent.getState().iteration,
        });
      } catch (e) {
        const ms = performance.now() - start;
        results.push({
          model: model.substring(0, 28),
          latency: `${(ms / 1000).toFixed(1)}s`,
          ファイル作成: "❌",
          実行結果: "❌ error",
          iterations: agent.getState().iteration,
        });
      }
    }

    printTable("タスク3: JSONデータ処理", results);

    const successCount = results.filter((r) =>
      String(r.実行結果).includes("✅") || String(r.実行結果).includes("⚠️"),
    ).length;
    console.log(`\n✅ 動作成功: ${successCount}/${results.length} モデル`);
    expect(successCount).toBeGreaterThan(0);
  }, 600000);
});
