/**
 * Sandbox Tier 1 のストラテジー実装。
 *
 * 各ストラテジーは共通インターフェース `WorkspaceStrategyImpl` に従い、
 * `origin` を `target` に「複製」する責務を持つ。
 *
 * 実装:
 *  - apfs-clone : macOS APFS の `cp -cR` (O(1) CoW)
 *  - reflink    : Linux btrfs/xfs の `cp --reflink=auto -R` (O(1) CoW)
 *  - git-worktree : `git worktree add` で新ブランチを別ディレクトリに展開
 *  - copy       : ポータブルな fs.cp (recursive)
 *
 * ストラテジーは失敗時に例外を投げ、呼び出し側の WorkspaceIsolator が次点に
 * フォールバックできるようにする。
 */

import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type {
  CloneParams,
  IsolatedWorkspace,
  WorkspaceStrategy,
  WorkspaceStrategyImpl,
} from "./types.js";

// ────────────────────────────────────────────────────────────────────────────
// 共通ヘルパー
// ────────────────────────────────────────────────────────────────────────────

/** 外部コマンドを実行。ok=true で正常終了、notFound=true で PATH に無い */
export interface RunOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  notFound: boolean;
  signal?: string;
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      shell: false,
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 30000,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    proc.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        resolve({ ok: false, stdout, stderr, notFound: true });
      } else {
        resolve({ ok: false, stdout, stderr, notFound: false });
      }
    });
    proc.on("close", (code: number | null, signal) => {
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        notFound: false,
        signal: signal ?? undefined,
      });
    });
  });
}

/** パスが存在すれば true */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** basename が除外パターンに含まれるか */
function isExcluded(relPath: string, excludePatterns: string[]): boolean {
  if (!relPath) return false;
  const normalized = relPath.split(path.sep).join("/");
  const base = path.basename(relPath);
  for (const pattern of excludePatterns) {
    const p = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!p) continue;
    if (base === p) return true;
    if (normalized === p) return true;
    if (normalized.startsWith(`${p}/`)) return true;
  }
  return false;
}

/** 除外パターンを考慮する fs.cp の filter */
export function makeExcludeFilter(
  origin: string,
  excludePatterns: string[],
): (src: string) => boolean {
  return (src) => {
    const rel = path.relative(origin, src);
    if (!rel || rel.startsWith("..")) return true; // origin 自身 / 外側は通す
    return !isExcluded(rel, excludePatterns);
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Strategy: apfs-clone (macOS)
// ────────────────────────────────────────────────────────────────────────────

export const ApfsCloneStrategy: WorkspaceStrategyImpl = {
  name: "apfs-clone",
  async isSupported(origin: string): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    // `cp -c` は macOS の cp が APFS clone を試みるオプション。
    // 実 FS が APFS でない場合は成功するが通常コピーになる。
    // ここでは dry run で小さなテストクローンを試す。
    try {
      const tmp = await mkdtemp(path.join(tmpdir(), "luna-apfs-probe-"));
      const src = path.join(tmp, "src");
      const dst = path.join(tmp, "dst");
      await mkdir(src, { recursive: true });
      const result = await runCommand("cp", ["-cR", src, dst], {
        timeoutMs: 5000,
      });
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      // cp -c は非 APFS でも成功しうるので、コマンド自体が動けば採用
      return result.ok;
    } catch {
      return false;
    }
  },
  async clone(params: CloneParams): Promise<void> {
    // `cp -cR` は除外指定ができないので、クローン後に除外パスを削除する。
    // 全体クローンは APFS なら O(1) なので、後から削除しても追加コストはほぼない。
    await mkdir(path.dirname(params.target), { recursive: true });
    const result = await runCommand(
      "cp",
      ["-cR", `${params.origin}/.`, params.target],
      { timeoutMs: 60000 },
    );
    if (!result.ok) {
      throw new Error(
        `apfs-clone failed: ${result.stderr || result.signal || "unknown"}`,
      );
    }
    await pruneExcluded(params.target, params.excludePatterns);
  },
  async cleanup(workspace: IsolatedWorkspace): Promise<void> {
    await rm(workspace.path, { recursive: true, force: true });
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Strategy: reflink (Linux btrfs / xfs)
// ────────────────────────────────────────────────────────────────────────────

export const ReflinkStrategy: WorkspaceStrategyImpl = {
  name: "reflink",
  async isSupported(origin: string): Promise<boolean> {
    if (process.platform !== "linux") return false;
    // origin と同じ FS 上で reflink が可能かを検証する。
    // `--reflink=always` は reflink できない FS では失敗するので判定に使える。
    //
    // Phase 25: プローブディレクトリ名をランダム化し、try/finally で必ず後片付け
    // する。以前は `.luna-reflink-probe` 固定で、プロセス死亡時にゴミが残り、
    // 並列起動では race が発生していた。
    const probeId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const probeDir = path.join(origin, `.luna-reflink-probe-${probeId}`);
    try {
      const { writeFile } = await import("node:fs/promises");
      await mkdir(probeDir, { recursive: true });
      const src = path.join(probeDir, "src");
      const dst = path.join(probeDir, "dst");
      await writeFile(src, "probe");
      const result = await runCommand("cp", ["--reflink=always", src, dst], {
        timeoutMs: 5000,
      });
      return result.ok;
    } catch {
      return false;
    } finally {
      // どのケースでも必ず削除する (例外で throw されていても)
      await rm(probeDir, { recursive: true, force: true }).catch(() => {});
    }
  },
  async clone(params: CloneParams): Promise<void> {
    await mkdir(path.dirname(params.target), { recursive: true });
    // --reflink=auto: 可能なら reflink、無理なら通常コピー
    const result = await runCommand(
      "cp",
      ["-a", "--reflink=auto", `${params.origin}/.`, params.target],
      { timeoutMs: 60000 },
    );
    if (!result.ok) {
      throw new Error(
        `reflink clone failed: ${result.stderr || result.signal || "unknown"}`,
      );
    }
    await pruneExcluded(params.target, params.excludePatterns);
  },
  async cleanup(workspace: IsolatedWorkspace): Promise<void> {
    await rm(workspace.path, { recursive: true, force: true });
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Strategy: git-worktree
// ────────────────────────────────────────────────────────────────────────────

export const GitWorktreeStrategy: WorkspaceStrategyImpl = {
  name: "git-worktree",
  async isSupported(origin: string): Promise<boolean> {
    // .git ディレクトリ または .git ファイル (submodule 等) を検出
    const gitPath = path.join(origin, ".git");
    if (!(await pathExists(gitPath))) return false;
    // git コマンドが使えるか
    const probe = await runCommand("git", ["--version"], { timeoutMs: 5000 });
    return probe.ok;
  },
  async clone(params: CloneParams): Promise<void> {
    // Phase 25: ブランチ名に random suffix を付け、予測可能性を排除する。
    // 以前は `sandbox/<basename>` 固定で、ユーザーが偶然同名のブランチを持って
    // いた場合に事前の `git branch -D` で黙って消えるリスクがあった。
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const branch = `sandbox/${path.basename(params.target)}-${suffix}`;
    await mkdir(path.dirname(params.target), { recursive: true });

    // 既存の worktree 登録を剥がす (パスが被った場合のみ。
    // WorkspaceIsolator.create() が事前に target 存在チェックしているので
    // 通常はここに入らないが、前回プロセスが異常終了して worktree 登録だけ
    // 残っているケースに備える)。
    await runCommand("git", ["worktree", "remove", "--force", params.target], {
      cwd: params.origin,
      timeoutMs: 10000,
    });

    const result = await runCommand(
      "git",
      ["worktree", "add", "-b", branch, params.target, "HEAD"],
      { cwd: params.origin, timeoutMs: 30000 },
    );
    if (!result.ok) {
      throw new Error(
        `git worktree add failed: ${result.stderr || result.signal || "unknown"}`,
      );
    }

    // git worktree は除外機構が無いので、後から削除する
    await pruneExcluded(params.target, params.excludePatterns);
  },
  async cleanup(workspace: IsolatedWorkspace): Promise<void> {
    // worktree remove の前に、`git worktree list --porcelain` からこの worktree に
    // 関連付けられたブランチ名を取得しておく。sentinel ファイル方式だと merge
    // 時にゴミが origin に伝播する恐れがあるため、git 自身の情報源を使う。
    const branch = await findWorktreeBranch(workspace.origin, workspace.path);

    // git worktree remove → 失敗時はディレクトリを手動削除
    const result = await runCommand(
      "git",
      ["worktree", "remove", "--force", workspace.path],
      { cwd: workspace.origin, timeoutMs: 30000 },
    );
    if (!result.ok) {
      await rm(workspace.path, { recursive: true, force: true });
    }

    // ブランチ削除は、`sandbox/` prefix で始まり show-ref で存在確認できた
    // ものだけを対象にする。sentinel 不在 / 外部 worktree などで特定できない
    // 場合は、ユーザーの legitimate branch を誤削除しないよう skip する。
    if (branch && branch.startsWith("sandbox/")) {
      const exists = await runCommand(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        { cwd: workspace.origin, timeoutMs: 5000 },
      );
      if (exists.ok) {
        await runCommand("git", ["branch", "-D", branch], {
          cwd: workspace.origin,
          timeoutMs: 5000,
        });
      }
    }
  },
};

/**
 * `git worktree list --porcelain` の出力から、指定 worktree path に関連付け
 * されたブランチ名を返す。見つからない / 取得失敗時は null。
 *
 * 出力フォーマット:
 *   worktree /path/to/wt
 *   HEAD <sha>
 *   branch refs/heads/<branch-name>   ← detach されていない場合のみ
 *   (空行)
 */
async function findWorktreeBranch(
  origin: string,
  workspacePath: string,
): Promise<string | null> {
  const res = await runCommand("git", ["worktree", "list", "--porcelain"], {
    cwd: origin,
    timeoutMs: 10000,
  });
  if (!res.ok) return null;

  const resolvedTarget = path.resolve(workspacePath);
  const blocks = res.stdout.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const wtLine = lines.find((l) => l.startsWith("worktree "));
    if (!wtLine) continue;
    const wtPath = path.resolve(wtLine.slice("worktree ".length).trim());
    if (wtPath !== resolvedTarget) continue;

    const brLine = lines.find((l) => l.startsWith("branch "));
    if (!brLine) return null; // detached HEAD
    // "branch refs/heads/<name>" → "<name>"
    const ref = brLine.slice("branch ".length).trim();
    return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Strategy: copy (ポータブル fallback)
// ────────────────────────────────────────────────────────────────────────────

export const CopyStrategy: WorkspaceStrategyImpl = {
  name: "copy",
  async isSupported(_origin: string): Promise<boolean> {
    return true; // 常に使える
  },
  async clone(params: CloneParams): Promise<void> {
    // Node の fs.cp は「dest が src のサブディレクトリ」だと filter を見ずに
    // エラーにする。.kairos/sandbox/workspace/... のように target を origin 内に
    // 置くのが正規ルートなので、手動で walk しながら target 配下をスキップする。
    await mkdir(params.target, { recursive: true });
    const targetResolved = path.resolve(params.target);
    await copyRecursive({
      src: params.origin,
      dst: params.target,
      origin: params.origin,
      excludePatterns: params.excludePatterns,
      targetResolved,
    });
  },
  async cleanup(workspace: IsolatedWorkspace): Promise<void> {
    await rm(workspace.path, { recursive: true, force: true });
  },
};

interface CopyWalkParams {
  src: string;
  dst: string;
  origin: string;
  excludePatterns: string[];
  targetResolved: string;
}

async function copyRecursive(p: CopyWalkParams): Promise<void> {
  const { readdir, copyFile, mkdir, symlink, readlink, lstat, utimes } =
    await import("node:fs/promises");
  const entries = await readdir(p.src, { withFileTypes: true });
  for (const entry of entries) {
    const srcChild = path.join(p.src, entry.name);
    const dstChild = path.join(p.dst, entry.name);
    const rel = path.relative(p.origin, srcChild);

    // 除外 & ターゲット自己ネスト回避
    if (isExcluded(rel, p.excludePatterns)) continue;
    if (path.resolve(srcChild) === p.targetResolved) continue;

    if (entry.isSymbolicLink()) {
      try {
        const link = await readlink(srcChild);
        await symlink(link, dstChild);
      } catch {
        // シンボリックリンクの再現に失敗したら無視
      }
      continue;
    }
    if (entry.isDirectory()) {
      await mkdir(dstChild, { recursive: true });
      await copyRecursive({ ...p, src: srcChild, dst: dstChild });
      continue;
    }
    if (entry.isFile()) {
      await copyFile(srcChild, dstChild);
      // mtime を揃えておくと diff の fast-path が効く
      try {
        const s = await lstat(srcChild);
        await utimes(dstChild, s.atime, s.mtime);
      } catch {
        // 失敗は致命的でない
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 除外パス削除ヘルパー
// ────────────────────────────────────────────────────────────────────────────

/** target 配下から excludePatterns にマッチするパスを削除する */
async function pruneExcluded(
  target: string,
  excludePatterns: string[],
): Promise<void> {
  for (const pattern of excludePatterns) {
    const cleaned = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!cleaned) continue;
    const absTarget = path.join(target, cleaned);
    if (await pathExists(absTarget)) {
      await rm(absTarget, { recursive: true, force: true });
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 統合: Strategy レジストリと検出
// ────────────────────────────────────────────────────────────────────────────

/** すべてのストラテジー実装 (優先順) */
export const ALL_STRATEGIES: WorkspaceStrategyImpl[] = [
  ApfsCloneStrategy,
  ReflinkStrategy,
  GitWorktreeStrategy,
  CopyStrategy,
];

export function getStrategy(
  name: WorkspaceStrategy,
): WorkspaceStrategyImpl | null {
  return ALL_STRATEGIES.find((s) => s.name === name) ?? null;
}

/**
 * 自動選択: APFS → reflink → git-worktree → copy の順で最初にサポートされるもの
 */
export async function detectBestStrategy(
  origin: string,
): Promise<WorkspaceStrategyImpl> {
  for (const strategy of ALL_STRATEGIES) {
    if (await strategy.isSupported(origin)) {
      return strategy;
    }
  }
  // copy は常に true なのでここには来ない
  return CopyStrategy;
}

/** 外部確認用: stat をエクスポート */
export async function ensureDirectory(p: string): Promise<void> {
  const s = await stat(p).catch(() => null);
  if (!s || !s.isDirectory()) {
    await mkdir(p, { recursive: true });
  }
}
