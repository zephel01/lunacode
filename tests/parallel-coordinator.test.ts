/**
 * Phase 31: `ParallelAgentCoordinator` の単体テスト。
 *
 * 範囲:
 *   1. 2 task を並行実行して両方 success、独立した workspace が割り当てられる
 *   2. maxConcurrency=1 で直列化されることを「実行中のピーク数」で検証
 *   3. 1 task が失敗しても他 task は完走する
 *   4. timeoutMs 超過で status: "timeout" になる
 *   5. autoMerge: true + onConflict: "abort" で origin 並行変更が検出される
 *   6. autoMerge: false なら workspace が残る (keepWorkspaceOnFailure 無関係)
 *   7. 同じ task id を 2 つ入れると run() が throw する
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import { ParallelAgentCoordinator } from "../src/agents/ParallelAgentCoordinator.js";
import type {
  ILLMProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  GenerateResponseOptions,
  LLMProviderType,
} from "../src/providers/LLMProvider.js";

// ────────────────────────────────────────────────────────────────────────────
// 共通: テスト用のモック LLM プロバイダ
// ────────────────────────────────────────────────────────────────────────────

interface ScriptedResponse {
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  /** このレスポンスを返すまでに待機する ms (並行性検証用) */
  delayMs?: number;
  /** true なら chatCompletion が throw する */
  throwError?: string;
}

class ScriptedMockProvider implements ILLMProvider {
  private callIndex = 0;
  public concurrentCalls = 0;
  public peakConcurrent = 0;
  constructor(private responses: ScriptedResponse[]) {}

  async chatCompletion(
    _request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    this.concurrentCalls++;
    this.peakConcurrent = Math.max(this.peakConcurrent, this.concurrentCalls);
    const r =
      this.responses[Math.min(this.callIndex, this.responses.length - 1)];
    this.callIndex++;
    try {
      if (r.delayMs && r.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, r.delayMs));
      }
      if (r.throwError) {
        throw new Error(r.throwError);
      }
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
              content: r.content,
              tool_calls: r.tool_calls,
            },
            finish_reason: r.tool_calls ? "tool_calls" : "stop",
          },
        ],
      };
    } finally {
      this.concurrentCalls--;
    }
  }

  async generateResponse(
    _prompt: string,
    _options?: GenerateResponseOptions,
  ): Promise<string> {
    return "Mock response";
  }
  getType(): LLMProviderType {
    return "openai";
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

/** origin ディレクトリを作り、最小限の `.kairos/config.json` を書く */
async function makeOrigin(tag: string): Promise<string> {
  const origin = mkdtempSync(pathJoin(tmpdir(), `phase31-${tag}-`));
  await mkdir(pathJoin(origin, ".kairos"), { recursive: true });
  writeFileSync(
    pathJoin(origin, ".kairos", "config.json"),
    JSON.stringify({
      llm: { provider: "openai" },
      agent: { maxIterations: 5 },
      // sandbox 設定は意図的に入れない。
      // ParallelAgentCoordinator が外側で workspace を作る設計のため、
      // 内部 AgentLoop は externallyManagedWorkspace: true で自動スキップする。
    }),
  );
  // 動作検証用のダミーファイル
  writeFileSync(pathJoin(origin, "hello.txt"), "origin-version\n");
  return origin;
}

// ────────────────────────────────────────────────────────────────────────────
// テスト本体
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 31: ParallelAgentCoordinator", () => {
  let origin: string;

  beforeEach(async () => {
    origin = await makeOrigin("coord");
  });

  afterEach(() => {
    rmSync(origin, { recursive: true, force: true });
  });

  test("2 task を並行実行して両方 success / 独立 workspace", async () => {
    const coord = new ParallelAgentCoordinator();
    const providers: ScriptedMockProvider[] = [];
    const factory = () => {
      const p = new ScriptedMockProvider([{ content: "done", delayMs: 40 }]);
      providers.push(p);
      return p;
    };

    const results = await coord.run(
      [
        { id: "task-a", prompt: "p1" },
        { id: "task-b", prompt: "p2" },
      ],
      {
        originPath: origin,
        llmProviderFactory: factory,
        maxConcurrency: 2,
        autoMerge: false,
      },
    );

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("success");
    expect(results[1].status).toBe("success");
    expect(results[0].taskId).toBe("task-a");
    expect(results[1].taskId).toBe("task-b");
    // 独立 workspace が割り当てられている
    expect(results[0].workspacePath).toBeTruthy();
    expect(results[1].workspacePath).toBeTruthy();
    expect(results[0].workspacePath).not.toBe(results[1].workspacePath);
    // 各 task に別の provider が渡されている
    expect(providers.length).toBe(2);
    expect(providers[0]).not.toBe(providers[1]);
  });

  test("maxConcurrency=1 では並行せず peak=1 になる", async () => {
    const coord = new ParallelAgentCoordinator();
    const shared = new ScriptedMockProvider([{ content: "done", delayMs: 30 }]);
    // factory は毎回同じインスタンスを返す → 全 task で shared.peakConcurrent を観測
    const factory = () => shared;

    const results = await coord.run(
      [
        { id: "s1", prompt: "p" },
        { id: "s2", prompt: "p" },
        { id: "s3", prompt: "p" },
      ],
      {
        originPath: origin,
        llmProviderFactory: factory,
        maxConcurrency: 1,
        autoMerge: false,
      },
    );

    expect(results.every((r) => r.status === "success")).toBe(true);
    expect(shared.peakConcurrent).toBe(1);
  });

  test("maxConcurrency=3 では少なくとも 2 件同時に走る", async () => {
    const coord = new ParallelAgentCoordinator();

    // バリア方式: 少なくとも 2 件の chatCompletion が同時に入るまで
    // どの呼び出しも return しない。これにより AgentLoop.initialize() の
    // 揺らぎに依存せず、並行度ピークを決定論的に観測できる。
    let entered = 0;
    let current = 0;
    let peak = 0;
    let resolveBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      resolveBarrier = resolve;
    });

    const makeBarrierProvider = (): ILLMProvider => ({
      async chatCompletion(
        _req: ChatCompletionRequest,
      ): Promise<ChatCompletionResponse> {
        current++;
        peak = Math.max(peak, current);
        entered++;
        if (entered >= 2) resolveBarrier();
        // 2 件入ったら barrier を解放し、それまでは最大 3 秒だけ待つ
        // (safety timeout: バリアが成立しない場合でも suite を hang させない)
        await Promise.race([
          barrier,
          new Promise<void>((r) => setTimeout(r, 3000)),
        ]);
        current--;
        return {
          id: "b",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "mock",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "done" },
              finish_reason: "stop",
            },
          ],
        };
      },
      async generateResponse(): Promise<string> {
        return "";
      },
      getType(): LLMProviderType {
        return "openai";
      },
      getDefaultModel(): string {
        return "mock";
      },
      async initialize(): Promise<void> {},
      async cleanup(): Promise<void> {},
      async testConnection(): Promise<boolean> {
        return true;
      },
    });

    const factory = () => makeBarrierProvider();

    const results = await coord.run(
      [
        { id: "p1", prompt: "p" },
        { id: "p2", prompt: "p" },
        { id: "p3", prompt: "p" },
      ],
      {
        originPath: origin,
        llmProviderFactory: factory,
        maxConcurrency: 3,
        autoMerge: false,
      },
    );

    expect(results.every((r) => r.status === "success")).toBe(true);
    expect(peak).toBeGreaterThanOrEqual(2);
  });

  test("1 task が失敗しても他 task は完走する", async () => {
    const coord = new ParallelAgentCoordinator();
    // factory が特定 task で throw する。これにより executeTask() の
    // try/catch が失敗を捕捉し、ParallelResult.status: "failure" になる。
    // (LLM provider の chatCompletion 内で throw しても AgentLoop は
    //  内部リトライで握りつぶすため、factory 段階で落とすほうが確実)
    let callCount = 0;
    const factory = () => {
      const idx = callCount++;
      if (idx === 0) {
        throw new Error("factory boom");
      }
      return new ScriptedMockProvider([{ content: "ok" }]);
    };

    const results = await coord.run(
      [
        { id: "bad", prompt: "p" },
        { id: "good", prompt: "p" },
      ],
      {
        originPath: origin,
        llmProviderFactory: factory,
        maxConcurrency: 1, // 順序を確定させる
        autoMerge: false,
      },
    );

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("failure");
    expect(results[0].error?.message).toContain("factory boom");
    expect(results[1].status).toBe("success");
  });

  test("timeoutMs を超過すると status: timeout で終わる", async () => {
    const coord = new ParallelAgentCoordinator();
    const factory = () =>
      new ScriptedMockProvider([
        // LLM 呼び出しが 500ms かかる → 50ms で timeout
        { content: "slow", delayMs: 500 },
      ]);

    const results = await coord.run([{ id: "slow", prompt: "p" }], {
      originPath: origin,
      llmProviderFactory: factory,
      maxConcurrency: 1,
      autoMerge: false,
      defaultTimeoutMs: 50,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("timeout");
    expect(results[0].error).toBeDefined();
    expect(results[0].error?.message).toContain("timed out");
  });

  test("autoMerge: true で workspace の変更が origin に反映される", async () => {
    const coord = new ParallelAgentCoordinator();
    // プロンプトから write_file tool_call を発行させる
    const factory = () =>
      new ScriptedMockProvider([
        {
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "hello.txt",
                  content: "merged-version\n",
                }),
              },
            },
          ],
        },
        // 次ターンで終了
        { content: "done" },
      ]);

    const results = await coord.run(
      [{ id: "merge-task", prompt: "update hello" }],
      {
        originPath: origin,
        llmProviderFactory: factory,
        maxConcurrency: 1,
        autoMerge: true,
        onConflict: "abort",
      },
    );

    expect(results[0].status).toBe("success");
    expect(results[0].mergeResult).toBeDefined();
    expect(results[0].mergeResult?.applied.length).toBeGreaterThan(0);
    // origin 側が更新された
    const after = readFileSync(pathJoin(origin, "hello.txt"), "utf8");
    expect(after).toBe("merged-version\n");
  });

  test("重複する task id を渡すと throw する", async () => {
    const coord = new ParallelAgentCoordinator();
    const factory = () => new ScriptedMockProvider([{ content: "ok" }]);

    await expect(
      coord.run(
        [
          { id: "dup", prompt: "p" },
          { id: "dup", prompt: "p" },
        ],
        {
          originPath: origin,
          llmProviderFactory: factory,
        },
      ),
    ).rejects.toThrow(/duplicate task id/);
  });

  test("空配列は空配列を返す (副作用なし)", async () => {
    const coord = new ParallelAgentCoordinator();
    let factoryCalls = 0;
    const factory = () => {
      factoryCalls++;
      return new ScriptedMockProvider([{ content: "ok" }]);
    };

    const results = await coord.run([], {
      originPath: origin,
      llmProviderFactory: factory,
    });

    expect(results).toEqual([]);
    expect(factoryCalls).toBe(0);
  });
});
