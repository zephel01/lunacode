/**
 * ProviderTester.checkModel() のユニットテスト。
 *
 * ModelSettingsRegistry の宣言と実機の挙動が一致/乖離する各パターンで
 * verdict が期待通りに決まるか、suggestedPatch が付くかを検証する。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import { ProviderTester } from "../src/testing/ProviderTester.js";
import { ConfigManager } from "../src/config/ConfigManager.js";
import {
  resetModelSettingsRegistryForTests,
  getModelSettingsRegistry,
} from "../src/providers/ModelSettingsRegistry.js";
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ILLMProvider,
  LLMProviderType,
  ToolCall,
} from "../src/providers/LLMProvider.js";
import { StreamChunk } from "../src/types/index.js";

// ─── モックプロバイダ ──────────────────────────────────────────────────────────

interface MockProviderOptions {
  type: LLMProviderType;
  model: string;
  /** tool_calls を返す（ネイティブ対応モデルのエミュレーション） */
  returnsToolCalls?: boolean;
  /** chatCompletion が投げるエラー（undefined なら正常終了） */
  throws?: Error;
}

function createMockProvider(opts: MockProviderOptions): ILLMProvider {
  const toolCall: ToolCall = {
    id: "call_1",
    type: "function",
    function: { name: "calculator", arguments: '{"expression":"2+2"}' },
  };
  return {
    chatCompletion: async (
      _req: ChatCompletionRequest,
    ): Promise<ChatCompletionResponse> => {
      if (opts.throws) throw opts.throws;
      return {
        id: "res_1",
        object: "chat.completion",
        created: Date.now(),
        model: opts.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: opts.returnsToolCalls ? null : "2+2 = 4",
              tool_calls: opts.returnsToolCalls ? [toolCall] : undefined,
            },
            finish_reason: opts.returnsToolCalls ? "tool_calls" : "stop",
          },
        ],
      };
    },
    chatCompletionStream: async function* (
      _req: ChatCompletionRequest,
    ): AsyncGenerator<StreamChunk> {
      yield { type: "content", delta: "mock" };
      yield { type: "done" };
    },
    supportsStreaming: () => true,
    generateResponse: async () => "mock",
    getType: () => opts.type,
    getDefaultModel: () => opts.model,
    initialize: async () => {},
    cleanup: async () => {},
    testConnection: async () => true,
  };
}

// ─── テスト本体 ────────────────────────────────────────────────────────────────

describe("ProviderTester.checkModel", () => {
  let tempDir: string;
  let tester: ProviderTester;

  beforeEach(() => {
    tempDir = mkdtempSync(pathJoin(tmpdir(), "check-model-test-"));
    resetModelSettingsRegistryForTests();
    // シングルトンを明示的に作って builtin を読ませる
    getModelSettingsRegistry();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    resetModelSettingsRegistryForTests();
  });

  function buildTester(opts: MockProviderOptions): ProviderTester {
    const provider = createMockProvider(opts);
    const config = new ConfigManager(tempDir);
    return new ProviderTester(provider, tempDir, config);
  }

  test("registry=true かつ実機で tool_calls が返る → supported", async () => {
    // qwen2.5-coder は builtin で native_tools=true
    tester = buildTester({
      type: "ollama",
      model: "qwen2.5-coder:7b",
      returnsToolCalls: true,
    });
    const report = await tester.checkModel();
    expect(report.verdict).toBe("supported");
    expect(report.resolvedSettings.native_tools).toBe(true);
    expect(report.nativeProbe.succeeded).toBe(true);
    expect(report.suggestedPatch).toBeUndefined();
  });

  test("registry=false かつ実機で tool_calls が返らない → supported", async () => {
    // gemma は builtin で native_tools=false
    tester = buildTester({
      type: "ollama",
      model: "gemma2:9b",
      returnsToolCalls: false,
    });
    const report = await tester.checkModel();
    expect(report.verdict).toBe("supported");
    expect(report.resolvedSettings.native_tools).toBe(false);
    expect(report.nativeProbe.succeeded).toBe(false);
    expect(report.suggestedPatch).toBeUndefined();
  });

  test("registry=false だが実機で tool_calls が返る → needs_tuning + patch", async () => {
    // gemma を騙して tool_calls を返させる想定
    tester = buildTester({
      type: "ollama",
      model: "gemma2:9b",
      returnsToolCalls: true,
    });
    const report = await tester.checkModel();
    expect(report.verdict).toBe("needs_tuning");
    expect(report.resolvedSettings.native_tools).toBe(false);
    expect(report.nativeProbe.succeeded).toBe(true);
    expect(report.suggestedPatch).toBeDefined();
    expect(report.suggestedPatch).toContain("native_tools: true");
  });

  test("registry=true だが実機で tool_calls が返らない → needs_tuning + patch", async () => {
    tester = buildTester({
      type: "ollama",
      model: "qwen2.5-coder:7b",
      returnsToolCalls: false,
    });
    const report = await tester.checkModel();
    expect(report.verdict).toBe("needs_tuning");
    expect(report.resolvedSettings.native_tools).toBe(true);
    expect(report.nativeProbe.succeeded).toBe(false);
    expect(report.suggestedPatch).toBeDefined();
    expect(report.suggestedPatch).toContain("native_tools: false");
  });

  test("400 Bad Request エラー + registry=true → needs_tuning に落とす", async () => {
    tester = buildTester({
      type: "ollama",
      model: "qwen2.5-coder:7b",
      throws: new Error("HTTP 400 Bad Request: tool calls not supported"),
    });
    const report = await tester.checkModel();
    expect(report.verdict).toBe("needs_tuning");
    expect(report.suggestedPatch).toBeDefined();
    expect(report.suggestedPatch).toContain("native_tools: false");
  });

  test("400 Bad Request エラー + registry=false → supported（整合）", async () => {
    tester = buildTester({
      type: "ollama",
      model: "gemma2:9b",
      throws: new Error("HTTP 400 Bad Request"),
    });
    const report = await tester.checkModel();
    expect(report.verdict).toBe("supported");
  });

  test("任意のエラー → unknown", async () => {
    tester = buildTester({
      type: "ollama",
      model: "qwen2.5-coder:7b",
      throws: new Error("ECONNREFUSED 127.0.0.1:11434"),
    });
    const report = await tester.checkModel();
    expect(report.verdict).toBe("unknown");
    expect(report.summary).toContain("ECONNREFUSED");
  });

  test("レポートに provider/model/durationMs が含まれる", async () => {
    tester = buildTester({
      type: "ollama",
      model: "qwen2.5-coder:7b",
      returnsToolCalls: true,
    });
    const report = await tester.checkModel();
    expect(report.provider).toBe("ollama");
    expect(report.model).toBe("qwen2.5-coder:7b");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
