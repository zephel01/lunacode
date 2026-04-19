/**
 * `lunacode parallel <prompt1> [prompt2 ...]` コマンドの実装 (Phase 31)。
 *
 * 複数のプロンプトを受け取り、それぞれを独立した workspace で並行実行する。
 * 実体は {@link ParallelAgentCoordinator} に委譲する。
 *
 * フラグ:
 *   --max-concurrency <n>          同時実行数の上限 (既定 3)
 *   --on-conflict <policy>         merge 衝突時の挙動 (abort | skip-conflicted | force, 既定 abort)
 *   --no-auto-merge                merge しない (workspace は残る)
 *   --timeout <ms>                 各 task 個別のタイムアウト
 *   --keep-on-failure              失敗 task の workspace を残す
 *   --dry-run                      パース結果だけ表示して実行しない
 *   --help                         このヘルプ
 */

import { ConfigManager } from "../config/ConfigManager.js";
import { LLMProviderFactory } from "../providers/LLMProviderFactory.js";
import { ParallelAgentCoordinator } from "./ParallelAgentCoordinator.js";
import type {
  ParallelTask,
  ParallelCoordinatorOptions,
} from "./ParallelAgentCoordinator.js";
import type { MergeConflictPolicy } from "../sandbox/types.js";

// ────────────────────────────────────────────────────────────────────────────
// 公開型
// ────────────────────────────────────────────────────────────────────────────

export interface ParallelCliOptions {
  /** origin (通常はプロジェクトルート) */
  origin: string;
}

/** 解析後のフラグ (テスト用に export) */
export interface ParsedParallelArgs {
  prompts: string[];
  maxConcurrency: number;
  onConflict: MergeConflictPolicy;
  autoMerge: boolean;
  timeoutMs?: number;
  keepOnFailure: boolean;
  dryRun: boolean;
  help: boolean;
  error?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// 公開エントリ
// ────────────────────────────────────────────────────────────────────────────

export async function handleParallelCommand(
  opts: ParallelCliOptions,
  args: string[],
): Promise<void> {
  const parsed = parseParallelArgs(args);

  if (parsed.help) {
    printHelp();
    return;
  }
  if (parsed.error) {
    console.error(parsed.error);
    printHelp();
    process.exitCode = 1;
    return;
  }
  if (parsed.prompts.length === 0) {
    console.error("lunacode parallel: at least one prompt is required");
    printHelp();
    process.exitCode = 1;
    return;
  }

  // Task 配列を組み立てる。id は "task-1" / "task-2" … と自動採番する
  const tasks: ParallelTask[] = parsed.prompts.map((prompt, i) => ({
    id: `parallel-task-${i + 1}`,
    prompt,
    timeoutMs: parsed.timeoutMs,
  }));

  if (parsed.dryRun) {
    console.log("🔍 Dry-run: would execute the following:");
    console.log(
      JSON.stringify(
        {
          origin: opts.origin,
          maxConcurrency: parsed.maxConcurrency,
          onConflict: parsed.onConflict,
          autoMerge: parsed.autoMerge,
          timeoutMs: parsed.timeoutMs ?? null,
          keepOnFailure: parsed.keepOnFailure,
          tasks,
        },
        null,
        2,
      ),
    );
    return;
  }

  // ConfigManager は origin の設定を使う (LLM provider 設定の読み取り)
  const configManager = new ConfigManager(opts.origin);
  const llmConfig = configManager.getLLMProviderConfig();

  const options: ParallelCoordinatorOptions = {
    originPath: opts.origin,
    llmProviderFactory: () => LLMProviderFactory.createProvider(llmConfig),
    maxConcurrency: parsed.maxConcurrency,
    autoMerge: parsed.autoMerge,
    onConflict: parsed.onConflict,
    defaultTimeoutMs: parsed.timeoutMs,
    keepWorkspaceOnFailure: parsed.keepOnFailure,
  };

  const coord = new ParallelAgentCoordinator();
  const results = await coord.run(tasks, options);

  // 結果サマリ
  const ok = results.filter((r) => r.status === "success").length;
  const fail = results.filter((r) => r.status === "failure").length;
  const timeout = results.filter((r) => r.status === "timeout").length;

  console.log("");
  console.log(
    `📊 Parallel run done: ${ok} ok / ${fail} fail / ${timeout} timeout (total ${results.length})`,
  );
  console.log("");
  for (const r of results) {
    const icon =
      r.status === "success" ? "✅" : r.status === "timeout" ? "⏱" : "❌";
    const ms = `${r.durationMs}ms`;
    const merge = r.mergeResult
      ? ` merged(${r.mergeResult.applied.length} files)`
      : "";
    const errMsg = r.error ? ` — ${r.error.message}` : "";
    console.log(`  ${icon} ${r.taskId} (${ms})${merge}${errMsg}`);
    if (r.workspacePath && r.status !== "success") {
      console.log(`      workspace kept at: ${r.workspacePath}`);
    }
  }

  if (fail + timeout > 0) {
    process.exitCode = 1;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 引数パース (テスト用に export)
// ────────────────────────────────────────────────────────────────────────────

export function parseParallelArgs(args: string[]): ParsedParallelArgs {
  const prompts: string[] = [];
  let maxConcurrency = 3;
  let onConflict: MergeConflictPolicy = "abort";
  let autoMerge = true;
  let timeoutMs: number | undefined = undefined;
  let keepOnFailure = false;
  let dryRun = false;
  let help = false;
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "--max-concurrency": {
        const v = args[++i];
        const n = parseInt(v ?? "", 10);
        if (!Number.isFinite(n) || n < 1) {
          error = `--max-concurrency requires a positive integer (got: ${v})`;
        } else {
          maxConcurrency = n;
        }
        break;
      }
      case "--on-conflict": {
        const v = args[++i];
        if (v === "abort" || v === "skip-conflicted" || v === "force") {
          onConflict = v;
        } else {
          error = `--on-conflict must be one of: abort, skip-conflicted, force (got: ${v})`;
        }
        break;
      }
      case "--no-auto-merge":
        autoMerge = false;
        break;
      case "--timeout": {
        const v = args[++i];
        const n = parseInt(v ?? "", 10);
        if (!Number.isFinite(n) || n < 1) {
          error = `--timeout requires a positive integer (ms) (got: ${v})`;
        } else {
          timeoutMs = n;
        }
        break;
      }
      case "--keep-on-failure":
        keepOnFailure = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        if (a.startsWith("--")) {
          error = `Unknown flag: ${a}`;
        } else {
          prompts.push(a);
        }
    }
  }

  return {
    prompts,
    maxConcurrency,
    onConflict,
    autoMerge,
    timeoutMs,
    keepOnFailure,
    dryRun,
    help,
    error,
  };
}

function printHelp(): void {
  console.log(`Usage: lunacode parallel <prompt1> [prompt2 ...] [options]

Run multiple AgentLoops in parallel, each in an isolated workspace.
After each task finishes, the workspace is merged back to origin
(unless --no-auto-merge is specified).

Options:
  --max-concurrency <n>          Max concurrent tasks (default: 3)
  --on-conflict <policy>         Merge conflict policy when origin changed
                                 during task execution (default: abort)
                                 Values: abort | skip-conflicted | force
  --no-auto-merge                Do not merge back; workspaces remain on disk
  --timeout <ms>                 Per-task timeout in milliseconds
  --keep-on-failure              Keep workspace for failed/timeout tasks
  --dry-run                      Print parsed plan and exit without running
  -h, --help                     Show this help

Examples:
  lunacode parallel "add docstring to foo" "fix typo in README"
  lunacode parallel "p1" "p2" "p3" --max-concurrency 2
  lunacode parallel "p" --timeout 60000 --on-conflict skip-conflicted
  lunacode parallel "p1" "p2" --no-auto-merge --keep-on-failure
`);
}
