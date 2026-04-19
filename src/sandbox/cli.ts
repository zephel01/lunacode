/**
 * `lunacode sandbox <sub>` コマンドの実装 (Phase 26, Phase 24.1.6 の残件)。
 *
 * `.kairos/sandbox/workspace/` 配下に残った workspace を列挙・差分表示・
 * マージ・削除するためのユーザー向け CLI。実際の diff/merge は Phase 24 で
 * 完成した `WorkspaceIsolator.open()` → `diff()` / `merge()` に委譲する。
 *
 * サブコマンド:
 *   list              workspace を列挙 (table / --json)
 *   diff <taskId>     workspace と origin の差分を表示
 *   merge <taskId>    workspace → origin にマージ (既定 dryRun, --apply で実反映)
 *   clean             削除。<taskId> / --all / --older-than <days> / --dry-run
 */

import { readdir, stat, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import * as path from "node:path";

import { WorkspaceIsolator } from "./WorkspaceIsolator.js";
import type { IsolatedWorkspace, MergeConflictPolicy } from "./types.js";

const DEFAULT_BASE_PATH = ".kairos/sandbox/workspace";

// ────────────────────────────────────────────────────────────────────────────
// 型
// ────────────────────────────────────────────────────────────────────────────

export interface SandboxCliOptions {
  /** origin (通常はプロジェクトルート) */
  origin: string;
  /** workspace の親ディレクトリを上書き (既定は <origin>/.kairos/sandbox/workspace) */
  basePathOverride?: string;
}

export interface WorkspaceInfo {
  taskId: string;
  path: string;
  sizeBytes: number;
  createdAt: Date;
  ageMs: number;
  /** `.git` ファイルがあれば git-worktree の可能性が高い */
  strategyHint: "git-worktree" | "copy-like" | "unknown";
}

// ────────────────────────────────────────────────────────────────────────────
// 公開エントリ
// ────────────────────────────────────────────────────────────────────────────

export async function handleSandboxCommand(
  opts: SandboxCliOptions,
  args: string[],
): Promise<void> {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list":
    case "ls":
      await runList(opts, args.slice(1));
      break;
    case "diff":
      await runDiff(opts, args.slice(1));
      break;
    case "merge":
      await runMerge(opts, args.slice(1));
      break;
    case "clean":
    case "rm":
      await runClean(opts, args.slice(1));
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(`Unknown sandbox subcommand: ${sub}`);
      printHelp();
      process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log(`Usage: lunacode sandbox <subcommand> [options]

Subcommands:
  list [--json]                    List workspaces under .kairos/sandbox/workspace
  diff <taskId> [--only <paths>]   Show diff between workspace and origin
  merge <taskId> [--apply] [--on-conflict abort|skip-conflicted|force]
                                   Merge workspace → origin (default: dry-run, abort on conflict)
  clean [<taskId>|--all|--older-than <days>] [--dry-run] [--yes]
                                   Delete workspaces

Examples:
  lunacode sandbox list
  lunacode sandbox list --json
  lunacode sandbox diff session_abc
  lunacode sandbox merge session_abc --apply
  lunacode sandbox merge session_abc --apply --on-conflict skip-conflicted
  lunacode sandbox clean session_abc
  lunacode sandbox clean --all --yes
  lunacode sandbox clean --older-than 7
`);
}

// ────────────────────────────────────────────────────────────────────────────
// list
// ────────────────────────────────────────────────────────────────────────────

async function runList(opts: SandboxCliOptions, args: string[]): Promise<void> {
  const json = args.includes("--json");
  const infos = await enumerateWorkspaces(opts);

  if (json) {
    const serializable = infos.map((w) => ({
      ...w,
      createdAt: w.createdAt.toISOString(),
    }));
    console.log(JSON.stringify(serializable, null, 2));
    return;
  }

  if (infos.length === 0) {
    console.log("No sandbox workspaces found.");
    console.log(`  basePath: ${resolveBasePath(opts)}`);
    return;
  }

  console.log(`📦 Sandbox workspaces (${infos.length})`);
  console.log("");
  const headers = ["TASK ID", "SIZE", "AGE", "CREATED", "STRATEGY"];
  const rows = infos.map((w) => [
    w.taskId,
    formatSize(w.sizeBytes),
    formatAge(w.ageMs),
    w.createdAt.toISOString().replace("T", " ").slice(0, 19),
    w.strategyHint,
  ]);
  console.log(renderTable(headers, rows));
  console.log("");
  console.log(`  basePath: ${resolveBasePath(opts)}`);
}

// ────────────────────────────────────────────────────────────────────────────
// diff
// ────────────────────────────────────────────────────────────────────────────

async function runDiff(opts: SandboxCliOptions, args: string[]): Promise<void> {
  const taskId = args[0];
  if (!taskId || taskId.startsWith("--")) {
    console.error("Usage: lunacode sandbox diff <taskId> [--only <paths...>]");
    process.exitCode = 1;
    return;
  }
  const onlyPaths = parseOnlyPaths(args.slice(1));

  const target = path.join(resolveBasePath(opts), taskId);
  if (!(await pathExists(target))) {
    console.error(`No such workspace: ${taskId} (${target})`);
    process.exitCode = 1;
    return;
  }

  const ws = await WorkspaceIsolator.open(target, opts.origin);
  const out = await ws.diff({ onlyPaths });
  process.stdout.write(out);
  if (!out.endsWith("\n")) process.stdout.write("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// merge
// ────────────────────────────────────────────────────────────────────────────

async function runMerge(
  opts: SandboxCliOptions,
  args: string[],
): Promise<void> {
  const taskId = args[0];
  if (!taskId || taskId.startsWith("--")) {
    console.error(
      "Usage: lunacode sandbox merge <taskId> [--apply] [--on-conflict abort|skip-conflicted|force] [--only <paths...>]",
    );
    process.exitCode = 1;
    return;
  }
  const apply = args.includes("--apply");
  const onlyPaths = parseOnlyPaths(args.slice(1));
  const onConflict = parseOnConflict(args);
  if (onConflict === "__invalid__") {
    console.error(
      "Invalid --on-conflict value. Expected one of: abort, skip-conflicted, force",
    );
    process.exitCode = 1;
    return;
  }

  const target = path.join(resolveBasePath(opts), taskId);
  if (!(await pathExists(target))) {
    console.error(`No such workspace: ${taskId} (${target})`);
    process.exitCode = 1;
    return;
  }

  const ws = await WorkspaceIsolator.open(target, opts.origin);
  const result = await ws.merge({
    dryRun: !apply,
    onlyPaths,
    onConflict,
  });

  if (!apply) {
    console.log(
      `🔍 Dry-run merge preview for ${taskId} (pass --apply to actually merge)`,
    );
  } else {
    console.log(`✅ Merged ${taskId} → origin (onConflict=${onConflict})`);
  }
  console.log("");
  console.log(`  applied    : ${result.applied.length}`);
  console.log(`  conflicted : ${result.conflicted.length}`);
  console.log(`  skipped    : ${result.skipped.length}`);
  if (result.applied.length > 0) {
    console.log("\n  files:");
    for (const f of result.applied) console.log(`    A ${f}`);
  }
  if (result.conflicted.length > 0) {
    for (const f of result.conflicted) console.log(`    C ${f}`);
  }
  if (result.preview) {
    console.log("");
    console.log(result.preview);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// clean
// ────────────────────────────────────────────────────────────────────────────

async function runClean(
  opts: SandboxCliOptions,
  args: string[],
): Promise<void> {
  const all = args.includes("--all");
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes") || args.includes("-y");
  const olderIdx = args.findIndex((a) => a === "--older-than");
  const olderDays =
    olderIdx >= 0 && args[olderIdx + 1] ? Number(args[olderIdx + 1]) : NaN;
  const positional = args.filter(
    (a, i) =>
      !a.startsWith("-") &&
      (olderIdx < 0 || i !== olderIdx + 1) &&
      !(olderIdx >= 0 && i === olderIdx),
  );
  const targetTaskId = positional[0];

  if (!all && !targetTaskId && !Number.isFinite(olderDays)) {
    console.error(
      "Usage: lunacode sandbox clean <taskId> | --all | --older-than <days> [--dry-run] [--yes]",
    );
    process.exitCode = 1;
    return;
  }

  const infos = await enumerateWorkspaces(opts);
  let toDelete: WorkspaceInfo[];
  if (all) {
    toDelete = infos;
  } else if (Number.isFinite(olderDays)) {
    const cutoff = Date.now() - olderDays * 24 * 60 * 60 * 1000;
    toDelete = infos.filter((w) => w.createdAt.getTime() <= cutoff);
  } else {
    toDelete = infos.filter((w) => w.taskId === targetTaskId);
    if (toDelete.length === 0) {
      console.error(`No such workspace: ${targetTaskId}`);
      process.exitCode = 1;
      return;
    }
  }

  if (toDelete.length === 0) {
    console.log("No workspaces matched. Nothing to do.");
    return;
  }

  console.log(`About to delete ${toDelete.length} workspace(s):`);
  for (const w of toDelete) {
    console.log(`  - ${w.taskId}  (${formatSize(w.sizeBytes)})  ${w.path}`);
  }

  if (dryRun) {
    console.log("\n(dry-run: no files removed)");
    return;
  }

  if (!yes && all && process.stdin.isTTY) {
    const answer = await prompt(`\nProceed? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("Aborted.");
      return;
    }
  }

  for (const w of toDelete) {
    await rm(w.path, { recursive: true, force: true });
    console.log(`  ✓ removed ${w.taskId}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ヘルパ
// ────────────────────────────────────────────────────────────────────────────

function resolveBasePath(opts: SandboxCliOptions): string {
  if (opts.basePathOverride) {
    return path.isAbsolute(opts.basePathOverride)
      ? opts.basePathOverride
      : path.join(opts.origin, opts.basePathOverride);
  }
  return path.join(opts.origin, DEFAULT_BASE_PATH);
}

export async function enumerateWorkspaces(
  opts: SandboxCliOptions,
): Promise<WorkspaceInfo[]> {
  const base = resolveBasePath(opts);
  if (!(await pathExists(base))) return [];

  const entries = await readdir(base, { withFileTypes: true });
  const now = Date.now();
  const infos: WorkspaceInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(base, e.name);
    let st;
    try {
      st = await stat(p);
    } catch {
      continue;
    }
    const size = await dirSize(p).catch(() => 0);
    const hint = await detectStrategyHint(p);
    infos.push({
      taskId: e.name,
      path: p,
      sizeBytes: size,
      createdAt: new Date(st.ctimeMs),
      ageMs: now - st.ctimeMs,
      strategyHint: hint,
    });
  }
  infos.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return infos;
}

async function detectStrategyHint(
  workspacePath: string,
): Promise<WorkspaceInfo["strategyHint"]> {
  try {
    const st = await stat(path.join(workspacePath, ".git"));
    if (st.isFile()) return "git-worktree";
    if (st.isDirectory()) return "copy-like";
  } catch {
    // .git が無い
  }
  return "unknown";
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile() || e.isSymbolicLink()) {
        try {
          const st = await stat(p);
          total += st.size;
        } catch {
          // ignore
        }
      }
    }
  }
  return total;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseOnlyPaths(args: string[]): string[] | undefined {
  const idx = args.indexOf("--only");
  if (idx < 0) return undefined;
  const rest = args.slice(idx + 1).filter((a) => !a.startsWith("--"));
  return rest.length > 0 ? rest : undefined;
}

/**
 * `--on-conflict <mode>` を解析する (Phase 28)。
 * 未指定なら `"abort"` を返す。不正値は `"__invalid__"`。
 */
function parseOnConflict(args: string[]): MergeConflictPolicy | "__invalid__" {
  const idx = args.indexOf("--on-conflict");
  if (idx < 0) return "abort";
  const v = args[idx + 1];
  if (v === "abort" || v === "skip-conflicted" || v === "force") return v;
  return "__invalid__";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatAge(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const pad = (s: string, w: number) =>
    s + " ".repeat(Math.max(0, w - s.length));
  const line = (cells: string[]) =>
    cells.map((c, i) => pad(c, widths[i]!)).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(headers), sep, ...rows.map(line)].join("\n");
}

async function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (chunk: Buffer | string) => {
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      resolve(String(chunk));
    };
    process.stdin.on("data", onData);
  });
}

// ついでに _IsolatedWorkspace の型を再エクスポート（テストからアクセスしやすく）
export type { IsolatedWorkspace };
