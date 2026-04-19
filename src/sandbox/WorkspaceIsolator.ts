/**
 * WorkspaceIsolator (Sandbox Tier 1)
 *
 * プロジェクトを `.kairos/sandbox/workspace/<taskId>/` に複製し、
 * LLM が触るファイル操作をそこに閉じ込める。
 *
 * 使用例:
 *   const ws = await WorkspaceIsolator.create({
 *     origin: "/Users/h/proj",
 *     taskId: "session_123",
 *     config: { strategy: "auto", excludePatterns: ["node_modules"] },
 *   });
 *   process.chdir(ws.path);
 *   // ... LLM がツールで編集 ...
 *   await ws.diff();                    // 変更を可視化
 *   await ws.merge({ dryRun: true });   // 適用プランだけ見る
 *   await ws.cleanup();                 // workspace を消す
 */

import { mkdir, rm, access, readdir, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";

import type {
  DiffOptions,
  IsolatedWorkspace,
  MergeOptions,
  MergeResult,
  WorkspaceSandboxConfig,
  WorkspaceStrategy,
  WorkspaceStrategyImpl,
} from "./types.js";
import {
  ALL_STRATEGIES,
  CopyStrategy,
  detectBestStrategy,
  getStrategy,
  runCommand,
} from "./strategies.js";

// ────────────────────────────────────────────────────────────────────────────
// 定数
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_PATH = ".kairos/sandbox/workspace";
const DEFAULT_EXCLUDE: string[] = [
  "node_modules",
  ".kairos/sandbox",
  "dist",
  "build",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".next",
  ".turbo",
  ".cache",
];

// ────────────────────────────────────────────────────────────────────────────
// 公開 create() パラメータ
// ────────────────────────────────────────────────────────────────────────────

export interface CreateWorkspaceParams {
  /** 本体プロジェクトの絶対パス */
  origin: string;
  /** 一意 ID (通常は session ID) */
  taskId: string;
  /** 設定 (`.kairos/config.json` の `sandbox.workspace` 相当) */
  config?: WorkspaceSandboxConfig;
  /** ストラテジーを差し替えたい場合 (テスト用) */
  strategyOverride?: WorkspaceStrategyImpl;
}

// ────────────────────────────────────────────────────────────────────────────
// WorkspaceIsolator
// ────────────────────────────────────────────────────────────────────────────

export class WorkspaceIsolator {
  /**
   * 隔離作業ツリーを作成する。
   * ストラテジーは `config.strategy` または自動検出で決める。
   * 選んだストラテジーが失敗した場合は `copy` にフォールバックする。
   */
  static async create(
    params: CreateWorkspaceParams,
  ): Promise<IsolatedWorkspace> {
    const origin = path.resolve(params.origin);
    if (!(await isDirectory(origin))) {
      throw new Error(
        `WorkspaceIsolator: origin is not a directory: ${origin}`,
      );
    }

    const config = params.config ?? {};
    const basePath = path.isAbsolute(config.basePath ?? "")
      ? (config.basePath as string)
      : path.join(origin, config.basePath ?? DEFAULT_BASE_PATH);
    const target = path.join(basePath, params.taskId);
    const excludePatterns = mergeExclude(config.excludePatterns);

    // 既に存在すれば事故防止で失敗させる (呼び出し側が意識してクリーンアップする)
    if (await pathExists(target)) {
      throw new Error(
        `WorkspaceIsolator: target already exists: ${target}. Call cleanup() first.`,
      );
    }

    const strategy = await selectStrategy(
      origin,
      config.strategy ?? "auto",
      params.strategyOverride,
    );

    try {
      await mkdir(basePath, { recursive: true });
      await strategy.clone({
        origin,
        target,
        excludePatterns,
      });
    } catch (err) {
      // 失敗時は掃除して copy にフォールバック (copy 自体が失敗した場合のみ例外を投げる)
      await rm(target, { recursive: true, force: true }).catch(() => {});
      if (strategy.name === "copy") {
        throw err;
      }
      await CopyStrategy.clone({
        origin,
        target,
        excludePatterns,
      });
    }

    return new WorkspaceHandle({
      taskId: params.taskId,
      path: target,
      origin,
      strategy: strategy.name,
      strategyImpl: strategy,
    });
  }

  /** 既存の workspace を読み込む (診断/クリーンアップ用) */
  static async open(
    targetPath: string,
    origin: string,
  ): Promise<IsolatedWorkspace> {
    const absTarget = path.resolve(targetPath);
    if (!(await isDirectory(absTarget))) {
      throw new Error(`WorkspaceIsolator: not a directory: ${absTarget}`);
    }
    return new WorkspaceHandle({
      taskId: path.basename(absTarget),
      path: absTarget,
      origin: path.resolve(origin),
      strategy: "copy",
      strategyImpl: CopyStrategy,
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// WorkspaceHandle (IsolatedWorkspace 実体)
// ────────────────────────────────────────────────────────────────────────────

interface HandleParams {
  taskId: string;
  path: string;
  origin: string;
  strategy: WorkspaceStrategy;
  strategyImpl: WorkspaceStrategyImpl;
}

class WorkspaceHandle implements IsolatedWorkspace {
  readonly taskId: string;
  readonly path: string;
  readonly origin: string;
  readonly strategy: WorkspaceStrategy;
  readonly createdAt: Date;
  private readonly strategyImpl: WorkspaceStrategyImpl;
  private cleaned = false;

  constructor(p: HandleParams) {
    this.taskId = p.taskId;
    this.path = p.path;
    this.origin = p.origin;
    this.strategy = p.strategy;
    this.strategyImpl = p.strategyImpl;
    this.createdAt = new Date();
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    await this.strategyImpl.cleanup(this);
  }

  async diff(opts: DiffOptions = {}): Promise<string> {
    return diffWorkspace(this, opts);
  }

  async merge(opts: MergeOptions = {}): Promise<MergeResult> {
    return mergeWorkspace(this, opts);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ストラテジー選択
// ────────────────────────────────────────────────────────────────────────────

async function selectStrategy(
  origin: string,
  name: "auto" | WorkspaceStrategy,
  override?: WorkspaceStrategyImpl,
): Promise<WorkspaceStrategyImpl> {
  if (override) return override;
  if (name === "none") {
    throw new Error(
      `WorkspaceIsolator: strategy="none" means no isolation. Caller should skip create().`,
    );
  }
  if (name === "auto") {
    return detectBestStrategy(origin);
  }
  const impl = getStrategy(name);
  if (!impl) {
    throw new Error(`WorkspaceIsolator: unknown strategy: ${name}`);
  }
  if (!(await impl.isSupported(origin))) {
    // 指定されたがこの環境では使えない → copy にフォールバック
    return CopyStrategy;
  }
  return impl;
}

// ────────────────────────────────────────────────────────────────────────────
// 除外パターン結合
// ────────────────────────────────────────────────────────────────────────────

function mergeExclude(userPatterns?: string[]): string[] {
  const combined = new Set<string>(DEFAULT_EXCLUDE);
  for (const p of userPatterns ?? []) {
    combined.add(p);
  }
  return Array.from(combined);
}

// ────────────────────────────────────────────────────────────────────────────
// diff / merge 実装 (rsync ベースの薄い実装)
// ────────────────────────────────────────────────────────────────────────────

/**
 * workspace と origin の差分を rsync --dry-run で出力する。
 * rsync が無い場合は簡易的な walk で変更ファイルを列挙する。
 */
async function diffWorkspace(
  ws: IsolatedWorkspace,
  opts: DiffOptions,
): Promise<string> {
  const rsyncAvailable = await isCommandAvailable("rsync");
  if (rsyncAvailable) {
    const result = await runCommand(
      "rsync",
      [
        "-avn", // archive, verbose, dry-run
        "--checksum",
        "--delete",
        ...buildRsyncIncludes(opts.onlyPaths),
        `${ws.path}/`,
        `${ws.origin}/`,
      ],
      { timeoutMs: 30000 },
    );
    return result.stdout || result.stderr || "(no changes detected)";
  }
  // フォールバック: 浅い walk
  const changed = await listChangedFiles(ws);
  return changed.length === 0
    ? "(no changes detected)"
    : changed.map((p) => `M ${p}`).join("\n");
}

/**
 * workspace → origin に変更を適用する。
 * - dryRun=true: 変更予定のパスを preview に詰めて返す
 * - 通常: rsync (あれば) か file-by-file copy で適用
 *
 * **注意**: 現状は単純な「後勝ち」適用で、本体側での同時変更との衝突検知は
 * していない。git-worktree ストラテジーでは別途 `git diff | git apply` を
 * 使う実装を将来追加する予定。
 */
async function mergeWorkspace(
  ws: IsolatedWorkspace,
  opts: MergeOptions,
): Promise<MergeResult> {
  const changed = await listChangedFiles(ws);
  const filtered =
    opts.onlyPaths && opts.onlyPaths.length > 0
      ? changed.filter((p) =>
          opts.onlyPaths!.some(
            (only) => p === only || p.startsWith(`${only}/`),
          ),
        )
      : changed;

  if (opts.dryRun) {
    return {
      applied: [],
      conflicted: [],
      skipped: filtered,
      preview:
        filtered.length === 0
          ? "(no changes to merge)"
          : filtered.map((p) => `would apply: ${p}`).join("\n"),
    };
  }

  const applied: string[] = [];
  const conflicted: string[] = [];
  const skipped: string[] = [];

  for (const rel of filtered) {
    const src = path.join(ws.path, rel);
    const dst = path.join(ws.origin, rel);
    try {
      const srcStat = await stat(src).catch(() => null);
      if (!srcStat) {
        skipped.push(rel);
        continue;
      }
      if (srcStat.isDirectory()) {
        await mkdir(dst, { recursive: true });
        applied.push(rel);
        continue;
      }
      await mkdir(path.dirname(dst), { recursive: true });
      const { cp } = await import("node:fs/promises");
      await cp(src, dst, { force: true, preserveTimestamps: true });
      applied.push(rel);
    } catch (err) {
      conflicted.push(
        `${rel}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { applied, conflicted, skipped };
}

/**
 * 軽量な変更検出。内容が違うファイルを workspace 基点の相対パスで列挙する。
 * 大きなツリーでは遅いが、サンドボックスのスコープでは許容範囲と判断。
 */
async function listChangedFiles(ws: IsolatedWorkspace): Promise<string[]> {
  const changed: string[] = [];
  await walkAndCompare(ws.path, ws.origin, "", changed);
  return changed.sort();
}

async function walkAndCompare(
  wsRoot: string,
  originRoot: string,
  rel: string,
  out: string[],
): Promise<void> {
  const wsPath = path.join(wsRoot, rel);
  let entries;
  try {
    entries = await readdir(wsPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relChild = rel ? path.join(rel, entry.name) : entry.name;
    const wsChild = path.join(wsRoot, relChild);
    const originChild = path.join(originRoot, relChild);
    if (entry.isDirectory()) {
      await walkAndCompare(wsRoot, originRoot, relChild, out);
      continue;
    }
    if (entry.isFile()) {
      const different = await filesDiffer(wsChild, originChild);
      if (different) out.push(relChild);
    }
  }
}

async function filesDiffer(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([
    stat(a).catch(() => null),
    stat(b).catch(() => null),
  ]);
  if (!sb) return true; // origin に存在しない = 新規
  if (!sa) return false; // workspace 側に無い = 処理不要
  if (sa.size !== sb.size) return true;

  // Phase 25: mtime fast-path は削除。
  // APFS clone / reflink / CopyStrategy の utimes は mtime を保存するため、
  // 「size 一致 && mtime 一致 → 同一」とすると、ファイルサイズを変えない置換
  // （同一長の文字列差し替えなど）を見落とす。size 一致時は必ず内容を比較する。
  const { readFile } = await import("node:fs/promises");
  const [ca, cb] = await Promise.all([readFile(a), readFile(b)]);
  return !ca.equals(cb);
}

function buildRsyncIncludes(onlyPaths?: string[]): string[] {
  if (!onlyPaths || onlyPaths.length === 0) return [];
  const args: string[] = [];
  for (const p of onlyPaths) {
    args.push("--include", p);
  }
  args.push("--exclude", "*");
  return args;
}

// ────────────────────────────────────────────────────────────────────────────
// 小さなヘルパー
// ────────────────────────────────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function isCommandAvailable(cmd: string): Promise<boolean> {
  const result = await runCommand(cmd, ["--version"], { timeoutMs: 3000 });
  return !result.notFound;
}

// ────────────────────────────────────────────────────────────────────────────
// テスト用: 実装中で使うものを exports
// ────────────────────────────────────────────────────────────────────────────

export {
  ALL_STRATEGIES,
  DEFAULT_EXCLUDE,
  DEFAULT_BASE_PATH,
  listChangedFiles as _listChangedFiles,
};
