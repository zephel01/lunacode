/**
 * ProviderTester — LLMプロバイダーの包括的な診断テストスイート
 *
 * テスト項目:
 * 1. 基本接続テスト（API疎通確認）
 * 2. ツール呼び出しテスト（ネイティブ/テキスト抽出の判定）
 * 3. 個別ツール動作テスト（read_file, write_file, glob, grep 等）
 * 4. コンテキストウィンドウ確認
 * 5. メモリシステム確認
 * 6. サブエージェント動作テスト（delegate_task）
 *
 * 全テスト終了後にレポートを出力
 */

import {
  ILLMProvider,
  ChatCompletionRequest,
} from "../providers/LLMProvider.js";
import { AgentLoop } from "../agents/AgentLoop.js";
import { ConfigManager } from "../config/ConfigManager.js";
import { MemorySystem } from "../memory/MemorySystem.js";
import { ModelRegistry } from "../providers/ModelRegistry.js";
import {
  getModelSettingsRegistry,
  ModelSettings,
} from "../providers/ModelSettingsRegistry.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

// LunaCode のインストールディレクトリ（src/testing/ の2階層上）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LUNACODE_ROOT = path.resolve(__dirname, "../../");

export interface TestResult {
  name: string;
  category: string;
  status: "pass" | "fail" | "skip" | "warn";
  durationMs: number;
  message: string;
  details?: string;
}

export interface TestReport {
  provider: string;
  model: string;
  timestamp: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  warned: number;
  totalDurationMs: number;
  results: TestResult[];
  capabilities: {
    nativeToolCalling: boolean;
    textExtractionFallback: boolean;
    streaming: boolean;
    contextWindowTokens: number;
    subAgentDelegation: boolean;
  };
}

/**
 * 単一モデルの対応状況チェック結果。
 *
 * - `verdict`: 総合判定
 *   - `supported`       : registry 通りに動作
 *   - `needs_tuning`    : registry と実機の挙動がずれている（YAML パッチ推奨）
 *   - `unsupported`     : native も text extraction も望めない状態
 *   - `unknown`         : 実機テストでエラーが出て判定不能
 */
export type ModelCheckVerdict =
  | "supported"
  | "needs_tuning"
  | "unsupported"
  | "unknown";

export interface ModelCheckReport {
  provider: string;
  model: string;
  timestamp: string;
  durationMs: number;
  /** ModelSettingsRegistry がこのモデルに対して返した設定 */
  resolvedSettings: ModelSettings;
  /** registry が組み込みデフォルト (match が全プロバイダ wildcard など) にマッチしたか */
  isBuiltinFallback: boolean;
  /** 実機で native tool calling を試した結果 */
  nativeProbe: {
    attempted: boolean;
    succeeded: boolean;
    toolCallCount: number;
    errorMessage?: string;
    responsePreview?: string;
  };
  verdict: ModelCheckVerdict;
  /** 判定根拠の 1 行説明 */
  summary: string;
  /** 乖離時に推奨する model-settings.yml エントリ（YAML 文字列） */
  suggestedPatch?: string;
}

export class ProviderTester {
  private provider: ILLMProvider;
  private basePath: string;
  private configManager: ConfigManager;
  private results: TestResult[] = [];
  private tempDir: string = "";
  private nativeToolCallingSupported: boolean = false;

  constructor(
    provider: ILLMProvider,
    basePath: string,
    configManager: ConfigManager,
  ) {
    this.provider = provider;
    this.basePath = basePath;
    this.configManager = configManager;
  }

  /**
   * 全テストを実行してレポートを返す
   */
  async runAll(): Promise<TestReport> {
    const startTime = Date.now();

    // テスト用の一時ディレクトリを作成
    this.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lunacode-test-"));

    console.log("\n" + "═".repeat(70));
    console.log("  🧪 LunaCode Provider Comprehensive Test Suite");
    console.log("═".repeat(70));
    console.log(`  Provider: ${this.provider.getType()}`);
    console.log(`  Model:    ${this.provider.getDefaultModel()}`);
    console.log("─".repeat(70) + "\n");

    // カテゴリ別テスト実行
    await this.runCategory("1. 基本接続", [
      () => this.testBasicConnection(),
      () => this.testStreamingSupport(),
    ]);

    await this.runCategory("2. コンテキストウィンドウ", [
      () => this.testContextWindow(),
    ]);

    await this.runCategory("3. ツール呼び出し", [
      () => this.testNativeToolCalling(),
      () => this.testTextExtractionFallback(),
    ]);

    await this.runCategory("4. 個別ツール動作", [
      () => this.testToolGlob(),
      () => this.testToolReadFile(),
      () => this.testToolWriteFile(),
      () => this.testToolGrep(),
      () => this.testToolBash(),
    ]);

    await this.runCategory("5. メモリシステム", [
      () => this.testMemorySystem(),
    ]);

    await this.runCategory("6. サブエージェント", [
      () => this.testSubAgentDelegation(),
    ]);

    // 一時ディレクトリのクリーンアップ
    try {
      await fs.rm(this.tempDir, { recursive: true });
    } catch {
      // クリーンアップ失敗は無視
    }

    const totalDurationMs = Date.now() - startTime;

    // レポート生成
    const report = this.buildReport(totalDurationMs);
    this.printReport(report);
    return report;
  }

  private async runCategory(
    categoryName: string,
    tests: (() => Promise<void>)[],
  ): Promise<void> {
    console.log(`\n  📋 ${categoryName}`);
    console.log("  " + "─".repeat(50));
    for (const test of tests) {
      await test();
    }
  }

  private addResult(result: TestResult): void {
    this.results.push(result);
    const icon =
      result.status === "pass"
        ? "✅"
        : result.status === "fail"
          ? "❌"
          : result.status === "warn"
            ? "⚠️"
            : "⏭️";
    const time =
      result.durationMs >= 1000
        ? `${(result.durationMs / 1000).toFixed(1)}s`
        : `${result.durationMs}ms`;
    console.log(`  ${icon} ${result.name} [${time}] — ${result.message}`);
  }

  // ──────────────────────────────────────────────────
  // 1. 基本接続テスト
  // ──────────────────────────────────────────────────

  private async testBasicConnection(): Promise<void> {
    const start = Date.now();
    try {
      await this.provider.initialize();
      const request: ChatCompletionRequest = {
        model: this.provider.getDefaultModel(),
        messages: [
          {
            role: "system",
            content: "You are a test assistant. Reply with only: OK",
          },
          { role: "user", content: "ping" },
        ],
      };

      const response = await this.provider.chatCompletion(request);
      const content = response.choices[0]?.message?.content || "";

      this.addResult({
        name: "API 接続",
        category: "基本接続",
        status: content.length > 0 ? "pass" : "warn",
        durationMs: Date.now() - start,
        message:
          content.length > 0
            ? `応答あり (${content.length} chars)`
            : "空レスポンス",
        details: content.substring(0, 100),
      });
    } catch (error) {
      this.addResult({
        name: "API 接続",
        category: "基本接続",
        status: "fail",
        durationMs: Date.now() - start,
        message: `接続失敗: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async testStreamingSupport(): Promise<void> {
    const start = Date.now();
    try {
      const supportsStream = this.provider.supportsStreaming?.() ?? false;

      if (!supportsStream) {
        this.addResult({
          name: "ストリーミング",
          category: "基本接続",
          status: "skip",
          durationMs: Date.now() - start,
          message: "プロバイダーがストリーミング非対応",
        });
        return;
      }

      const request: ChatCompletionRequest = {
        model: this.provider.getDefaultModel(),
        messages: [
          { role: "system", content: "Reply with only: STREAM_OK" },
          { role: "user", content: "test" },
        ],
      };

      const generator = this.provider.chatCompletionStream?.(request);
      if (!generator) {
        this.addResult({
          name: "ストリーミング",
          category: "基本接続",
          status: "fail",
          durationMs: Date.now() - start,
          message: "ストリーミングジェネレーターが null",
        });
        return;
      }

      let content = "";
      let chunkCount = 0;
      for await (const chunk of generator) {
        if (chunk.type === "content" && chunk.delta) {
          content += chunk.delta;
          chunkCount++;
        }
        if (chunk.type === "done") break;
        if (chunk.type === "error") throw new Error(chunk.error);
      }

      this.addResult({
        name: "ストリーミング",
        category: "基本接続",
        status: content.length > 0 ? "pass" : "warn",
        durationMs: Date.now() - start,
        message: `${chunkCount} チャンク受信 (${content.length} chars)`,
      });
    } catch (error) {
      this.addResult({
        name: "ストリーミング",
        category: "基本接続",
        status: "fail",
        durationMs: Date.now() - start,
        message: `ストリーミングエラー: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // ──────────────────────────────────────────────────
  // 2. コンテキストウィンドウ
  // ──────────────────────────────────────────────────

  private async testContextWindow(): Promise<void> {
    const start = Date.now();
    try {
      const modelName = this.provider.getDefaultModel();
      const registry = new ModelRegistry();
      const ollamaBaseUrl =
        this.provider.getType() === "ollama"
          ? "http://localhost:11434"
          : undefined;
      const modelInfo = await registry.getModelInfo(modelName, ollamaBaseUrl);

      this.addResult({
        name: "コンテキストウィンドウ",
        category: "コンテキスト",
        status: "pass",
        durationMs: Date.now() - start,
        message: `${modelInfo.contextLength.toLocaleString()} tokens (${modelInfo.category})`,
        details: `supports tools: ${modelInfo.supportsTools}, streaming: ${modelInfo.supportsStreaming}`,
      });
    } catch (error) {
      this.addResult({
        name: "コンテキストウィンドウ",
        category: "コンテキスト",
        status: "warn",
        durationMs: Date.now() - start,
        message: `モデル情報取得失敗: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // ──────────────────────────────────────────────────
  // 3. ツール呼び出しテスト
  // ──────────────────────────────────────────────────

  private async testNativeToolCalling(): Promise<void> {
    const start = Date.now();
    try {
      const request: ChatCompletionRequest = {
        model: this.provider.getDefaultModel(),
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant with tools. Always use the provided tools.",
          },
          { role: "user", content: "What is 2+2? Use the calculator tool." },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "calculator",
              description: "Perform arithmetic calculations",
              parameters: {
                type: "object",
                properties: {
                  expression: {
                    type: "string",
                    description: "Math expression to evaluate",
                  },
                },
                required: ["expression"],
              },
            },
          },
        ],
      };

      const response = await this.provider.chatCompletion(request);
      const toolCalls = response.choices[0]?.message?.tool_calls;
      const hasNativeToolCalls = toolCalls && toolCalls.length > 0;

      if (hasNativeToolCalls) {
        this.nativeToolCallingSupported = true;
        this.addResult({
          name: "ネイティブ Tool Calling",
          category: "ツール呼び出し",
          status: "pass",
          durationMs: Date.now() - start,
          message: `対応 (${toolCalls!.length} tool call(s))`,
          details: toolCalls!.map((tc) => tc.function.name).join(", "),
        });
      } else {
        this.addResult({
          name: "ネイティブ Tool Calling",
          category: "ツール呼び出し",
          status: "warn",
          durationMs: Date.now() - start,
          message: "非対応 — テキスト抽出モードで動作",
          details: response.choices[0]?.message?.content?.substring(0, 100),
        });
      }
    } catch (error) {
      // 400 Bad Request = ネイティブ非対応
      const msg = error instanceof Error ? error.message : String(error);
      this.addResult({
        name: "ネイティブ Tool Calling",
        category: "ツール呼び出し",
        status:
          msg.includes("400") || msg.includes("Bad Request") ? "warn" : "fail",
        durationMs: Date.now() - start,
        message: msg.includes("400")
          ? "非対応 (400 Bad Request) — テキスト抽出で代替"
          : `エラー: ${msg}`,
      });
    }
  }

  private async testTextExtractionFallback(): Promise<void> {
    const start = Date.now();

    // ネイティブ Tool Calling 対応モデルはテキスト抽出フォールバックを使わないため skip
    if (this.nativeToolCallingSupported) {
      this.addResult({
        name: "テキスト抽出フォールバック",
        category: "ツール呼び出し",
        status: "skip",
        durationMs: 0,
        message: "ネイティブ Tool Calling 対応のためスキップ",
      });
      return;
    }

    try {
      // テキスト抽出モード: ツール指示をシステムプロンプトに含めて直接テスト
      const request: ChatCompletionRequest = {
        model: this.provider.getDefaultModel(),
        messages: [
          {
            role: "system",
            content: `You have tools. When you need a tool, respond EXACTLY like:
<tool_call>
{"name": "tool_name", "arguments": {"param": "value"}}
</tool_call>

Available tools:
- calculator: Perform arithmetic. Parameters: {expression: string (required)}`,
          },
          {
            role: "user",
            content:
              "Calculate 3+5 using the calculator tool. Respond ONLY with the tool call.",
          },
        ],
      };

      const response = await this.provider.chatCompletion(request);
      const content = response.choices[0]?.message?.content || "";
      const hasToolCallTag =
        content.includes("<tool_call>") || content.includes('"name"');

      this.addResult({
        name: "テキスト抽出フォールバック",
        category: "ツール呼び出し",
        status: hasToolCallTag ? "pass" : "warn",
        durationMs: Date.now() - start,
        message: hasToolCallTag
          ? "LLM が <tool_call> 形式を生成可能"
          : "LLM が <tool_call> 形式を生成しなかった",
        details: content.substring(0, 150),
      });
    } catch (error) {
      this.addResult({
        name: "テキスト抽出フォールバック",
        category: "ツール呼び出し",
        status: "fail",
        durationMs: Date.now() - start,
        message: `エラー: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // ──────────────────────────────────────────────────
  // 4. 個別ツール動作テスト
  // ──────────────────────────────────────────────────

  private async testToolGlob(): Promise<void> {
    const start = Date.now();
    try {
      const registry = new ToolRegistry();
      const result = await registry.executeTool("glob", {
        pattern: "src/**/*.ts",
        path: LUNACODE_ROOT,
      });
      const fileCount = result.output
        ? result.output.split("\n").filter((l: string) => l.trim()).length
        : 0;

      this.addResult({
        name: "glob ツール",
        category: "個別ツール",
        status: result.success ? "pass" : "fail",
        durationMs: Date.now() - start,
        message: result.success
          ? `${fileCount} ファイル検出`
          : `失敗: ${result.error}`,
      });
    } catch (error) {
      this.addResult({
        name: "glob ツール",
        category: "個別ツール",
        status: "fail",
        durationMs: Date.now() - start,
        message: `エラー: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async testToolReadFile(): Promise<void> {
    const start = Date.now();
    try {
      const registry = new ToolRegistry();
      const result = await registry.executeTool("read_file", {
        path: path.join(LUNACODE_ROOT, "package.json"),
      });

      this.addResult({
        name: "read_file ツール",
        category: "個別ツール",
        status: result.success ? "pass" : "fail",
        durationMs: Date.now() - start,
        message: result.success
          ? `読み取り成功 (${result.output.length} chars)`
          : `失敗: ${result.error}`,
      });
    } catch (error) {
      this.addResult({
        name: "read_file ツール",
        category: "個別ツール",
        status: "fail",
        durationMs: Date.now() - start,
        message: `エラー: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async testToolWriteFile(): Promise<void> {
    const start = Date.now();
    try {
      const registry = new ToolRegistry();
      const testFile = path.join(this.tempDir, "test-write.txt");
      const result = await registry.executeTool("write_file", {
        path: testFile,
        content: "LunaCode write_file test",
      });

      // 書き込み確認
      let verifyOk = false;
      if (result.success) {
        const content = await fs.readFile(testFile, "utf-8");
        verifyOk = content === "LunaCode write_file test";
      }

      this.addResult({
        name: "write_file ツール",
        category: "個別ツール",
        status: verifyOk ? "pass" : "fail",
        durationMs: Date.now() - start,
        message: verifyOk
          ? "書き込み＆検証成功"
          : `失敗: ${result.error || "内容不一致"}`,
      });
    } catch (error) {
      this.addResult({
        name: "write_file ツール",
        category: "個別ツール",
        status: "fail",
        durationMs: Date.now() - start,
        message: `エラー: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async testToolGrep(): Promise<void> {
    const start = Date.now();
    try {
      const registry = new ToolRegistry();
      const result = await registry.executeTool("grep", {
        pattern: "export class",
        path: path.join(LUNACODE_ROOT, "src/agents/AgentLoop.ts"),
      });

      this.addResult({
        name: "grep ツール",
        category: "個別ツール",
        status: result.success ? "pass" : "fail",
        durationMs: Date.now() - start,
        message: result.success ? "パターン検索成功" : `失敗: ${result.error}`,
      });
    } catch (error) {
      this.addResult({
        name: "grep ツール",
        category: "個別ツール",
        status: "fail",
        durationMs: Date.now() - start,
        message: `エラー: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async testToolBash(): Promise<void> {
    const start = Date.now();
    try {
      const registry = new ToolRegistry();
      const result = await registry.executeTool("bash", {
        command: "echo LunaCode-test-OK",
      });
      const output = result.output?.trim() || "";

      this.addResult({
        name: "bash ツール",
        category: "個別ツール",
        status: output.includes("LunaCode-test-OK") ? "pass" : "fail",
        durationMs: Date.now() - start,
        message: output.includes("LunaCode-test-OK")
          ? "コマンド実行成功"
          : `出力不一致: ${output.substring(0, 50)}`,
      });
    } catch (error) {
      this.addResult({
        name: "bash ツール",
        category: "個別ツール",
        status: "fail",
        durationMs: Date.now() - start,
        message: `エラー: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // ──────────────────────────────────────────────────
  // 5. メモリシステム
  // ──────────────────────────────────────────────────

  private async testMemorySystem(): Promise<void> {
    const start = Date.now();
    try {
      const memoryPath = path.join(this.tempDir, ".kairos");
      const memory = new MemorySystem(memoryPath);
      await memory.initialize();

      // 書き込みテスト
      await memory.updateMemory("Test project for provider testing");

      // 読み取りテスト
      const results = await memory.searchMemory("test");
      const content = results.length > 0 ? results[0].content : "";

      // ログ追記テスト
      await memory.appendToLog("ProviderTester: test log entry");

      this.addResult({
        name: "メモリシステム",
        category: "メモリ",
        status: "pass",
        durationMs: Date.now() - start,
        message: `初期化・書込・読取・ログ追記 全て成功`,
        details: `メモリ内容: ${content.substring(0, 80)}`,
      });
    } catch (error) {
      this.addResult({
        name: "メモリシステム",
        category: "メモリ",
        status: "fail",
        durationMs: Date.now() - start,
        message: `エラー: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // ──────────────────────────────────────────────────
  // 6. サブエージェント
  // ──────────────────────────────────────────────────

  private async testSubAgentDelegation(): Promise<void> {
    const start = Date.now();
    try {
      const agent = new AgentLoop(
        this.provider,
        this.basePath,
        this.configManager,
      );
      await agent.initialize();

      // delegate_task を直接呼ぶのではなく、LLM にサブエージェント使用を依頼
      // タイムアウト付きで実行
      const timeout = 60000; // 60秒
      const taskPromise = agent.processUserInput(
        "Use the delegate_task tool to spawn 1 explorer sub-agent that reads the file 'package.json' and reports its name field. Reply with the sub-agent result.",
      );

      const result = await Promise.race([
        taskPromise,
        new Promise<string>((_, reject) =>
          setTimeout(
            () => reject(new Error("Sub-agent test timeout (60s)")),
            timeout,
          ),
        ),
      ]);

      const hasResult = result.length > 0;
      const mentionsSubAgent =
        result.includes("sub-agent") ||
        result.includes("Sub-agent") ||
        result.includes("delegate") ||
        result.includes("package");

      this.addResult({
        name: "サブエージェント (delegate_task)",
        category: "サブエージェント",
        status:
          hasResult && mentionsSubAgent ? "pass" : hasResult ? "warn" : "fail",
        durationMs: Date.now() - start,
        message: hasResult
          ? `応答あり (${result.length} chars)${mentionsSubAgent ? " — サブエージェント動作確認" : " — サブエージェント未使用の可能性"}`
          : "応答なし",
        details: result.substring(0, 200),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.addResult({
        name: "サブエージェント (delegate_task)",
        category: "サブエージェント",
        status: msg.includes("timeout") ? "warn" : "fail",
        durationMs: Date.now() - start,
        message: msg.includes("timeout")
          ? "タイムアウト (60s) — モデルの応答が遅い可能性"
          : `エラー: ${msg}`,
      });
    }
  }

  // ──────────────────────────────────────────────────
  // レポート生成
  // ──────────────────────────────────────────────────

  private buildReport(totalDurationMs: number): TestReport {
    const passed = this.results.filter((r) => r.status === "pass").length;
    const failed = this.results.filter((r) => r.status === "fail").length;
    const skipped = this.results.filter((r) => r.status === "skip").length;
    const warned = this.results.filter((r) => r.status === "warn").length;

    // 能力判定
    const nativeToolResult = this.results.find(
      (r) => r.name === "ネイティブ Tool Calling",
    );
    const textExtResult = this.results.find(
      (r) => r.name === "テキスト抽出フォールバック",
    );
    const streamResult = this.results.find((r) => r.name === "ストリーミング");
    const contextResult = this.results.find(
      (r) => r.name === "コンテキストウィンドウ",
    );
    const subAgentResult = this.results.find((r) =>
      r.name.includes("サブエージェント"),
    );

    const contextTokens = contextResult?.details
      ? parseInt(contextResult.message.replace(/[^0-9]/g, "")) || 0
      : 0;

    return {
      provider: this.provider.getType(),
      model: this.provider.getDefaultModel(),
      timestamp: new Date().toISOString(),
      totalTests: this.results.length,
      passed,
      failed,
      skipped,
      warned,
      totalDurationMs,
      results: this.results,
      capabilities: {
        nativeToolCalling: nativeToolResult?.status === "pass",
        textExtractionFallback: textExtResult?.status === "pass",
        streaming: streamResult?.status === "pass",
        contextWindowTokens: contextTokens,
        subAgentDelegation: subAgentResult?.status === "pass",
      },
    };
  }

  printReport(report: TestReport): void {
    console.log("\n" + "═".repeat(70));
    console.log("  📊 Test Report");
    console.log("═".repeat(70));
    console.log(`  Provider:  ${report.provider}`);
    console.log(`  Model:     ${report.model}`);
    console.log(`  Timestamp: ${report.timestamp}`);
    console.log(`  Duration:  ${(report.totalDurationMs / 1000).toFixed(1)}s`);
    console.log("─".repeat(70));
    console.log(`  ✅ Passed:  ${report.passed}`);
    console.log(`  ❌ Failed:  ${report.failed}`);
    console.log(`  ⚠️  Warned:  ${report.warned}`);
    console.log(`  ⏭️  Skipped: ${report.skipped}`);
    console.log(`  📝 Total:   ${report.totalTests}`);
    console.log("─".repeat(70));
    console.log("  🔍 Capabilities:");
    console.log(
      `     Native Tool Calling:     ${report.capabilities.nativeToolCalling ? "✅ Yes" : "❌ No"}`,
    );
    console.log(
      `     Text Extraction Fallback: ${report.capabilities.textExtractionFallback ? "✅ Yes" : "❌ No"}`,
    );
    console.log(
      `     Streaming:               ${report.capabilities.streaming ? "✅ Yes" : "❌ No"}`,
    );
    console.log(
      `     Context Window:          ${report.capabilities.contextWindowTokens > 0 ? report.capabilities.contextWindowTokens.toLocaleString() + " tokens" : "不明"}`,
    );
    console.log(
      `     Sub-agent Delegation:    ${report.capabilities.subAgentDelegation ? "✅ Yes" : "❌ No"}`,
    );
    console.log("═".repeat(70) + "\n");
  }

  /**
   * レポートを JSON ファイルとして保存
   */
  async saveReport(report: TestReport, outputPath?: string): Promise<string> {
    const fileName = `test-report-${report.provider}-${Date.now()}.json`;
    const filePath = outputPath || path.join(this.basePath, fileName);
    await fs.writeFile(filePath, JSON.stringify(report, null, 2), "utf-8");
    return filePath;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // モデル対応状況チェック（lunacode test-provider --check-model）
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * 現在のプロバイダ/モデルについて、
   *   - ModelSettingsRegistry の宣言（どう扱われる予定か）
   *   - 実機の挙動（tool_calls が返るか）
   * を突き合わせて対応状況を判定する。
   *
   * 単一モデル用の軽量チェック。フルテスト（runAll）と違って
   * tool calling だけを相手にするため、数秒〜10秒程度で完了する想定。
   */
  async checkModel(): Promise<ModelCheckReport> {
    const start = Date.now();
    const providerType = this.provider.getType();
    const model = this.provider.getDefaultModel();
    const timestamp = new Date().toISOString();

    // 1. ModelSettingsRegistry から解決
    const registry = getModelSettingsRegistry();
    const resolvedSettings = registry.resolve(providerType, model);
    const isBuiltinFallback =
      resolvedSettings.match === "*/*" ||
      resolvedSettings.match === `${providerType}/*`;

    // 2. 実機で native tool calling を試す
    const nativeProbe = await this.probeNativeToolCalling(model);

    // 3. 判定
    const { verdict, summary, suggestedPatch } = this.judgeModelCheck(
      providerType,
      model,
      resolvedSettings,
      nativeProbe,
      isBuiltinFallback,
    );

    return {
      provider: providerType,
      model,
      timestamp,
      durationMs: Date.now() - start,
      resolvedSettings,
      isBuiltinFallback,
      nativeProbe,
      verdict,
      summary,
      suggestedPatch,
    };
  }

  /**
   * tools 付きリクエストを 1 回投げて、tool_calls が返ってくるかを確認する。
   * testNativeToolCalling の簡易版。
   */
  private async probeNativeToolCalling(model: string): Promise<{
    attempted: boolean;
    succeeded: boolean;
    toolCallCount: number;
    errorMessage?: string;
    responsePreview?: string;
  }> {
    const request: ChatCompletionRequest = {
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant with tools. Always use the provided tools.",
        },
        { role: "user", content: "What is 2+2? Use the calculator tool." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "calculator",
            description: "Perform arithmetic calculations",
            parameters: {
              type: "object",
              properties: {
                expression: {
                  type: "string",
                  description: "Math expression to evaluate",
                },
              },
              required: ["expression"],
            },
          },
        },
      ],
    };

    try {
      const response = await this.provider.chatCompletion(request);
      const toolCalls = response.choices[0]?.message?.tool_calls ?? [];
      const content = response.choices[0]?.message?.content ?? "";
      return {
        attempted: true,
        succeeded: toolCalls.length > 0,
        toolCallCount: toolCalls.length,
        responsePreview: content ? content.substring(0, 200) : undefined,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        attempted: true,
        succeeded: false,
        toolCallCount: 0,
        errorMessage: msg,
      };
    }
  }

  /**
   * registry の declaration と実機の結果を突き合わせて verdict を決める。
   */
  private judgeModelCheck(
    providerType: string,
    model: string,
    settings: ModelSettings,
    probe: {
      succeeded: boolean;
      toolCallCount: number;
      errorMessage?: string;
    },
    isBuiltinFallback: boolean,
  ): {
    verdict: ModelCheckVerdict;
    summary: string;
    suggestedPatch?: string;
  } {
    const declared = settings.native_tools;
    const observed = probe.succeeded;

    // エラーで落ちた場合は判定不能（HTTP 400 など特定エラーは非対応と断定できるが、
    // 安全側で unknown に倒す）
    if (probe.errorMessage) {
      const msg = probe.errorMessage;
      const looksUnsupported =
        /400|bad request|does not support tools|tool.*not supported/i.test(msg);
      if (looksUnsupported && declared === false) {
        return {
          verdict: "supported",
          summary:
            "registry は native_tools=false を宣言しており、実機も tool calling 非対応で整合",
        };
      }
      if (looksUnsupported && declared === true) {
        return {
          verdict: "needs_tuning",
          summary:
            "registry は native_tools=true だが実機は tool calling 非対応。false に下げるのが推奨",
          suggestedPatch: renderYamlPatch(providerType, model, {
            ...settings,
            native_tools: false,
            notes:
              "実機で tool calling 非対応を確認 (test-provider --check-model)",
          }),
        };
      }
      return {
        verdict: "unknown",
        summary: `実機テストがエラーで判定不能: ${msg.substring(0, 120)}`,
      };
    }

    // 成功ケース: registry と実機が一致
    if (declared === observed) {
      return {
        verdict: "supported",
        summary: declared
          ? `native tool calling が動作し、registry の宣言と一致 (${probe.toolCallCount} tool call(s))`
          : "registry は native_tools=false を宣言しており、実機も tool_calls を返さず整合",
      };
    }

    // 乖離ケース 1: registry=false だが実機は tool_calls を返した
    // → モデル側が実は対応している。YAML で true に上げることを提案
    if (declared === false && observed === true) {
      const note = isBuiltinFallback
        ? "組み込みデフォルト (`*/*`) にマッチ中。専用エントリ追加を推奨"
        : "registry の該当エントリを true に更新することを推奨";
      return {
        verdict: "needs_tuning",
        summary: `registry は native_tools=false だが、実機では tool calling が動作 (${probe.toolCallCount} tool call(s))。${note}`,
        suggestedPatch: renderYamlPatch(providerType, model, {
          ...settings,
          match: isBuiltinFallback
            ? `${providerType}/${escapeGlobSegment(model)}`
            : settings.match,
          native_tools: true,
          notes: "実機で tool calling 対応を確認 (test-provider --check-model)",
        }),
      };
    }

    // 乖離ケース 2: registry=true だが実機は tool_calls を返さない
    // → 実機非対応。false に下げる提案
    return {
      verdict: "needs_tuning",
      summary:
        "registry は native_tools=true だが、実機は tool_calls を返さず。false に下げるのが推奨",
      suggestedPatch: renderYamlPatch(providerType, model, {
        ...settings,
        match: isBuiltinFallback
          ? `${providerType}/${escapeGlobSegment(model)}`
          : settings.match,
        native_tools: false,
        notes: "実機で tool calling 不動作を確認 (test-provider --check-model)",
      }),
    };
  }

  /**
   * モデルチェック結果を人間向けに整形して stdout に表示する。
   */
  printModelCheckReport(report: ModelCheckReport): void {
    const verdictLabel: Record<ModelCheckVerdict, string> = {
      supported: "✅ SUPPORTED",
      needs_tuning: "⚠️  NEEDS TUNING",
      unsupported: "❌ UNSUPPORTED",
      unknown: "❓ UNKNOWN",
    };

    console.log("\n" + "═".repeat(70));
    console.log("  🔍 Model Compatibility Check");
    console.log("═".repeat(70));
    console.log(`  Provider  : ${report.provider}`);
    console.log(`  Model     : ${report.model}`);
    console.log(`  Duration  : ${(report.durationMs / 1000).toFixed(2)}s`);
    console.log("─".repeat(70));

    // Registry 側
    console.log("  📋 Registry Declaration");
    console.log(
      `     match         : ${report.resolvedSettings.match}${report.isBuiltinFallback ? " (builtin fallback)" : ""}`,
    );
    console.log(`     native_tools  : ${report.resolvedSettings.native_tools}`);
    console.log(`     edit_format   : ${report.resolvedSettings.edit_format}`);
    if (
      report.resolvedSettings.num_ctx !== undefined &&
      report.resolvedSettings.num_ctx !== null
    ) {
      console.log(`     num_ctx       : ${report.resolvedSettings.num_ctx}`);
    }
    if (report.resolvedSettings.notes) {
      console.log(`     notes         : ${report.resolvedSettings.notes}`);
    }
    console.log("─".repeat(70));

    // 実機プローブ
    console.log("  🧪 Native Tool Calling Probe");
    if (report.nativeProbe.errorMessage) {
      console.log(
        `     result        : error — ${report.nativeProbe.errorMessage.substring(0, 180)}`,
      );
    } else if (report.nativeProbe.succeeded) {
      console.log(
        `     result        : ✅ tool_calls returned (${report.nativeProbe.toolCallCount})`,
      );
    } else {
      console.log(`     result        : ❌ no tool_calls (text response only)`);
      if (report.nativeProbe.responsePreview) {
        console.log(
          `     preview       : ${report.nativeProbe.responsePreview.substring(0, 120)}`,
        );
      }
    }
    console.log("─".repeat(70));

    // 判定
    console.log(`  Verdict       : ${verdictLabel[report.verdict]}`);
    console.log(`  Summary       : ${report.summary}`);

    if (report.suggestedPatch) {
      console.log("─".repeat(70));
      console.log("  💡 Suggested model-settings.yml patch:");
      console.log("");
      for (const line of report.suggestedPatch.split("\n")) {
        console.log(`     ${line}`);
      }
      console.log("");
      console.log(
        "  保存先: <project>/.kairos/model-settings.yml or ~/.kairos/model-settings.yml",
      );
    }

    console.log("═".repeat(70) + "\n");
  }
}

/**
 * YAML エントリ 1 つを手書き風に整形する（js-yaml の dump を通すと
 * コメントを残せないため、ここだけ手書き）。
 */
function renderYamlPatch(
  _providerType: string,
  _model: string,
  settings: ModelSettings,
): string {
  const lines: string[] = [];
  lines.push(`- match: "${settings.match}"`);
  lines.push(`  native_tools: ${settings.native_tools}`);
  lines.push(`  edit_format: ${settings.edit_format}`);
  if (settings.num_ctx !== undefined && settings.num_ctx !== null) {
    lines.push(`  num_ctx: ${settings.num_ctx}`);
  }
  if (settings.notes) {
    lines.push(`  notes: "${settings.notes.replace(/"/g, '\\"')}"`);
  }
  return lines.join("\n");
}

/**
 * モデル名を glob パターン用にエスケープする。
 * "qwen3:4b" → "qwen3:4b" のように `*` と `?` を持たない名前はそのまま。
 * 現状の matchesGlob は `*` と `?` を wildcard として扱うので、
 * リテラルなモデル名がそれらを含んでいないケースでは追加エスケープ不要。
 */
function escapeGlobSegment(model: string): string {
  return model;
}
