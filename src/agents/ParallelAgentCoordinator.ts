/**
 * Phase 31: マルチエージェント並列実行 (`ParallelAgentCoordinator`)
 *
 * 複数の {@link AgentLoop} をそれぞれ独立した {@link IsolatedWorkspace} 上で
 * 並行起動し、完了後に (`autoMerge: true` の場合) `workspace.merge()` で
 * origin へ反映するトップレベル orchestrator。
 *
 * Phase 29 で完成した `ToolRegistry.setContext({ basePath })` 注入と、
 * Phase 25〜28 の `WorkspaceIsolator` / baseline / 衝突検知を土台にしている。
 *
 * 使用例:
 * ```ts
 * const coordinator = new ParallelAgentCoordinator();
 * const results = await coordinator.run(
 *   [
 *     { id: "task-a", prompt: "add docstring to foo()" },
 *     { id: "task-b", prompt: "fix typo in README" },
 *   ],
 *   {
 *     originPath: process.cwd(),
 *     llmProviderFactory: () => new OllamaProvider(...),
 *     maxConcurrency: 2,
 *     onConflict: "abort",
 *   },
 * );
 * ```
 *
 * 注意:
 *   - 各 task ごとに LLM provider を **新規生成** する (`llmProviderFactory()`)。
 *     これはセッション内の stateful な provider が複数 task 間で汚染されるのを防ぐため。
 *   - 内部の AgentLoop には `externallyManagedWorkspace: true` を渡し、
 *     AgentLoop が自前で `WorkspaceIsolator.create()` を呼ばないようにする。
 *   - 1 task が throw しても他 task は継続する (`Promise.allSettled` 相当の意味論)。
 */

import { AgentLoop } from "./AgentLoop.js";
import { ConfigManager } from "../config/ConfigManager.js";
import { WorkspaceIsolator } from "../sandbox/WorkspaceIsolator.js";
import { Logger } from "../utils/Logger.js";
import type { ILLMProvider } from "../providers/LLMProvider.js";
import type {
  IsolatedWorkspace,
  MergeConflictPolicy,
  MergeResult,
  WorkspaceSandboxConfig,
} from "../sandbox/types.js";

// ────────────────────────────────────────────────────────────────────────────
// 公開型
// ────────────────────────────────────────────────────────────────────────────

/** 並列実行する単一タスク */
export interface ParallelTask {
  /** 一意 ID（同一 `run()` 呼び出し内で重複不可。workspace の taskId にも使う） */
  id: string;
  /** エージェントに渡す入力プロンプト */
  prompt: string;
  /**
   * 個別のタイムアウト (ms)。未指定時は `options.defaultTimeoutMs`、
   * それも未指定なら制限なし。
   */
  timeoutMs?: number;
  /** このタスクだけ workspace 設定を上書きしたい場合 */
  workspaceConfig?: WorkspaceSandboxConfig;
}

/** `ParallelAgentCoordinator.run()` の共通オプション */
export interface ParallelCoordinatorOptions {
  /** 本体プロジェクトのパス（全タスク共通の origin） */
  originPath: string;
  /**
   * 各タスクごとに新規の LLM provider を生成する factory。
   *
   * タスク間で状態を共有したくないため、必ず task 実行直前に呼ばれる。
   * `await` に対応しているので async factory も可。
   */
  llmProviderFactory: () => ILLMProvider | Promise<ILLMProvider>;
  /** 同時実行の最大数。既定 3。最低 1 */
  maxConcurrency?: number;
  /** タスク完了後に自動で merge するか。既定 true */
  autoMerge?: boolean;
  /** merge 時の衝突ポリシー (Phase 28)。既定 "abort" */
  onConflict?: MergeConflictPolicy;
  /** タスクごとの既定タイムアウト (ms)。0 / 省略で制限なし */
  defaultTimeoutMs?: number;
  /**
   * タスク失敗時に workspace を残すか。既定 false (= cleanup する)。
   * true にすると、失敗した task の workspace をあとで
   * `lunacode sandbox list` / `... diff` で調査できる。
   */
  keepWorkspaceOnFailure?: boolean;
  /** すべての task に共通の workspace config (task.workspaceConfig が優先) */
  workspaceConfig?: WorkspaceSandboxConfig;
}

/** 単一タスクの実行結果ステータス */
export type ParallelTaskStatus = "success" | "failure" | "timeout";

/** 単一タスクの実行結果 */
export interface ParallelResult {
  taskId: string;
  status: ParallelTaskStatus;
  /** 生成された workspace のパス (失敗でも `keepWorkspaceOnFailure: true` なら残る) */
  workspacePath?: string;
  /** `AgentLoop.processUserInput()` の戻り値 (success 時) */
  output?: string;
  /** `autoMerge: true` かつ success の場合にセット */
  mergeResult?: MergeResult;
  /** 失敗 or timeout 時の Error */
  error?: Error;
  /** 実行時間 (ms) */
  durationMs: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Coordinator 本体
// ────────────────────────────────────────────────────────────────────────────

export class ParallelAgentCoordinator {
  private log = Logger.get("ParallelAgentCoordinator");

  /**
   * N 個の task を並行実行する。
   *
   * - maxConcurrency 個のワーカが task queue から順に 1 件ずつ取り、
   *   各々 workspace 作成 → AgentLoop 起動 → merge → cleanup を行う。
   * - 1 task の失敗は他 task に伝播しない。
   *
   * 戻り値は入力 `tasks` と同じ順序 (= 入力 index を保持) で返される。
   */
  async run(
    tasks: ParallelTask[],
    options: ParallelCoordinatorOptions,
  ): Promise<ParallelResult[]> {
    if (tasks.length === 0) return [];

    // ID 重複検出
    const seen = new Set<string>();
    for (const t of tasks) {
      if (seen.has(t.id)) {
        throw new Error(
          `ParallelAgentCoordinator: duplicate task id "${t.id}"`,
        );
      }
      seen.add(t.id);
    }

    const maxConcurrency = Math.max(1, options.maxConcurrency ?? 3);
    const autoMerge = options.autoMerge ?? true;
    const onConflict: MergeConflictPolicy = options.onConflict ?? "abort";

    this.log.info(
      {
        taskCount: tasks.length,
        maxConcurrency,
        autoMerge,
        onConflict,
      },
      "Starting parallel run",
    );

    const results: ParallelResult[] = new Array(tasks.length);
    let cursor = 0;
    const nextIndex = (): number => {
      if (cursor >= tasks.length) return -1;
      return cursor++;
    };

    const runOne = async (index: number, task: ParallelTask): Promise<void> => {
      results[index] = await this.executeTask(task, {
        originPath: options.originPath,
        llmProviderFactory: options.llmProviderFactory,
        autoMerge,
        onConflict,
        defaultTimeoutMs: options.defaultTimeoutMs,
        keepWorkspaceOnFailure: options.keepWorkspaceOnFailure ?? false,
        workspaceConfig: options.workspaceConfig,
      });
    };

    // maxConcurrency 個のワーカを起動して queue を消化する
    const workers: Promise<void>[] = [];
    for (let w = 0; w < maxConcurrency; w++) {
      workers.push(
        (async () => {
          while (true) {
            const idx = nextIndex();
            if (idx < 0) return;
            await runOne(idx, tasks[idx]);
          }
        })(),
      );
    }
    await Promise.all(workers);

    const ok = results.filter((r) => r.status === "success").length;
    const fail = results.filter((r) => r.status === "failure").length;
    const timeout = results.filter((r) => r.status === "timeout").length;
    this.log.info(
      { ok, fail, timeout, total: results.length },
      "Parallel run finished",
    );

    return results;
  }

  /** 単一 task を 1 回だけ実行する (run() の内部ヘルパ、テストから直接呼んでもよい) */
  async executeTask(
    task: ParallelTask,
    opts: {
      originPath: string;
      llmProviderFactory: () => ILLMProvider | Promise<ILLMProvider>;
      autoMerge: boolean;
      onConflict: MergeConflictPolicy;
      defaultTimeoutMs?: number;
      keepWorkspaceOnFailure: boolean;
      workspaceConfig?: WorkspaceSandboxConfig;
    },
  ): Promise<ParallelResult> {
    const started = Date.now();
    let workspace: IsolatedWorkspace | undefined;

    try {
      // 1) workspace を外側で確保する (内部の AgentLoop には作らせない)
      workspace = await WorkspaceIsolator.create({
        origin: opts.originPath,
        taskId: task.id,
        config: task.workspaceConfig ?? opts.workspaceConfig ?? {},
      });

      // 2) task ごとに provider を新規生成 (状態分離)
      const provider = await opts.llmProviderFactory();

      // 3) AgentLoop を workspace.path で起動
      //    externallyManagedWorkspace: true で内部の setupSandboxWorkspace を抑止
      const agent = new AgentLoop(
        provider,
        workspace.path,
        new ConfigManager(workspace.path),
        { externallyManagedWorkspace: true },
      );
      await agent.initialize();

      // 4) プロンプト実行 (タイムアウト付き)
      const timeoutMs = task.timeoutMs ?? opts.defaultTimeoutMs ?? 0;
      const output = await this.withTimeout(
        agent.processUserInput(task.prompt),
        timeoutMs,
        `Task "${task.id}" timed out after ${timeoutMs}ms`,
      );

      // 5) autoMerge: true なら merge
      let mergeResult: MergeResult | undefined;
      if (opts.autoMerge) {
        mergeResult = await workspace.merge({ onConflict: opts.onConflict });
      }

      const result: ParallelResult = {
        taskId: task.id,
        status: "success",
        workspacePath: workspace.path,
        output,
        mergeResult,
        durationMs: Date.now() - started,
      };

      // 6) 成功時は workspace を片付ける (失敗時は後で keepWorkspaceOnFailure で判断)
      if (opts.autoMerge) {
        await workspace.cleanup().catch((e) => {
          this.log.warn(
            { err: e, taskId: task.id },
            "workspace cleanup failed after success",
          );
        });
      }

      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const isTimeout =
        error.message.includes("timed out") || error.name === "TimeoutError";

      const result: ParallelResult = {
        taskId: task.id,
        status: isTimeout ? "timeout" : "failure",
        workspacePath: workspace?.path,
        error,
        durationMs: Date.now() - started,
      };

      if (workspace && !opts.keepWorkspaceOnFailure) {
        await workspace.cleanup().catch((e) => {
          this.log.warn(
            { err: e, taskId: task.id },
            "workspace cleanup failed after failure",
          );
        });
        // cleanup 済みなら path は残しても参照先は消えている
      }

      this.log.warn(
        { taskId: task.id, status: result.status, err: error.message },
        "task failed",
      );

      return result;
    }
  }

  /** Promise をタイムアウト付きでラップする。timeoutMs<=0 は無制限 */
  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) return promise;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const e = new Error(message);
        e.name = "TimeoutError";
        reject(e);
      }, timeoutMs);
      timer.unref?.();
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }
}
