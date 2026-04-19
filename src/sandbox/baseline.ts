/**
 * Origin ベースラインスナップショット (Phase 28)。
 *
 * `WorkspaceIsolator.create()` で origin をクローンした直後に
 * origin のファイル一覧と `{size, mtime}` を記録し、後の
 * `merge()` で「この workspace が生きている間に origin が外部変更
 * されていないか」を判定するために使う。
 *
 * 保存場所:
 *   `<basePath>/<taskId>.baseline.json`
 *   (workspace ディレクトリと同階層。workspace 内に置かないのは
 *    diff/merge の比較対象から外すため)
 *
 * 設計上の割り切り:
 *   - size + mtime のみ記録。内容ハッシュは取らない
 *     (APFS clone 直後は origin と workspace は同 mtime を共有するが、
 *      ここで比較しているのは「baseline 時の origin」と
 *      「merge 時の origin」なので、外部編集が起これば mtime は必ず動く)。
 *   - ルート 1 枚の origin のみ対象。ネストした `.gitignore` や
 *     サブリポジトリは対象外 (Phase 27 の方針を踏襲)。
 *   - symlink / special file は扱わない (`isFile()` のみ対象)。
 */

import { readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { type CompiledPattern, compileAll, matchAny } from "./patternMatch.js";

// ────────────────────────────────────────────────────────────────────────────
// 型定義
// ────────────────────────────────────────────────────────────────────────────

export interface BaselineFileEntry {
  /** ファイルサイズ (bytes) */
  size: number;
  /** UNIX time in ms (Math.trunc で丸める) */
  mtime: number;
}

export interface OriginBaseline {
  /** スキーマバージョン (将来の後方互換用) */
  version: 1;
  /** 一意 ID (taskId と同じ) */
  taskId: string;
  /** origin の絶対パス */
  origin: string;
  /** ISO8601 のキャプチャ時刻 */
  createdAt: string;
  /** origin 基点の相対パス (POSIX) → メタ情報 */
  files: Record<string, BaselineFileEntry>;
}

export type OriginConflictKind =
  | "externally-modified"
  | "externally-deleted"
  | "externally-added";

export interface OriginConflict {
  /** origin 基点の相対パス (POSIX) */
  relPath: string;
  /** 何が起きたか */
  kind: OriginConflictKind;
  /** 人間可読な理由 */
  reason: string;
}

// ────────────────────────────────────────────────────────────────────────────
// ファイルパス
// ────────────────────────────────────────────────────────────────────────────

/**
 * baseline JSON のファイルパスを返す。
 * workspace と同階層の `<basePath>/<taskId>.baseline.json` とする。
 */
export function baselinePathFor(basePath: string, taskId: string): string {
  return path.join(basePath, `${taskId}.baseline.json`);
}

// ────────────────────────────────────────────────────────────────────────────
// キャプチャ
// ────────────────────────────────────────────────────────────────────────────

export interface CaptureBaselineParams {
  origin: string;
  taskId: string;
  /** origin を複製しなかった除外パターン (clone 側と同じ) */
  excludePatterns: string[];
  /** 保存先ファイルパス (省略時は `baselinePathFor` で計算) */
  outPath?: string;
  /** 保存先を計算するための basePath (outPath 指定時は無視) */
  basePath?: string;
}

/**
 * origin をウォークしてベースラインを作成し、JSON ファイルとして書き出す。
 * 戻り値はメモリ上の `OriginBaseline` オブジェクト。
 */
export async function captureBaseline(
  params: CaptureBaselineParams,
): Promise<OriginBaseline> {
  const origin = path.resolve(params.origin);
  const compiled = compileAll(params.excludePatterns ?? []);
  const files: Record<string, BaselineFileEntry> = {};
  await walk(origin, "", compiled, files);
  const baseline: OriginBaseline = {
    version: 1,
    taskId: params.taskId,
    origin,
    createdAt: new Date().toISOString(),
    files,
  };
  const outPath =
    params.outPath ??
    baselinePathFor(params.basePath ?? path.dirname(origin), params.taskId);
  await writeFile(outPath, JSON.stringify(baseline, null, 2), "utf8");
  return baseline;
}

async function walk(
  root: string,
  rel: string,
  compiled: CompiledPattern[],
  out: Record<string, BaselineFileEntry>,
): Promise<void> {
  const abs = rel ? path.join(root, rel) : root;
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relChild = rel ? `${rel}/${entry.name}` : entry.name;
    const isDir = entry.isDirectory();
    if (
      matchAny(compiled, {
        relPath: relChild,
        isDirectory: isDir,
      })
    ) {
      continue; // 除外パターンにマッチしたディレクトリは再帰しない
    }
    if (isDir) {
      await walk(root, relChild, compiled, out);
      continue;
    }
    if (!entry.isFile()) continue; // symlink / special は無視
    const absChild = path.join(root, relChild);
    try {
      const s = await stat(absChild);
      out[relChild] = {
        size: s.size,
        mtime: Math.trunc(s.mtimeMs),
      };
    } catch {
      // 取得できないファイルは baseline に含めない
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ロード
// ────────────────────────────────────────────────────────────────────────────

/**
 * baseline JSON を読み出す。ファイル不在・パース失敗は `null`。
 */
export async function loadBaseline(
  baselinePath: string,
): Promise<OriginBaseline | null> {
  try {
    const text = await readFile(baselinePath, "utf8");
    const parsed = JSON.parse(text) as Partial<OriginBaseline>;
    if (
      parsed &&
      parsed.version === 1 &&
      typeof parsed.taskId === "string" &&
      typeof parsed.origin === "string" &&
      typeof parsed.createdAt === "string" &&
      parsed.files &&
      typeof parsed.files === "object"
    ) {
      return parsed as OriginBaseline;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * baseline ファイルを削除する。不在時は無視。
 */
export async function removeBaseline(baselinePath: string): Promise<void> {
  try {
    await unlink(baselinePath);
  } catch {
    // 存在しない、既に消されている等は無視
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 衝突検出
// ────────────────────────────────────────────────────────────────────────────

/**
 * `mergeTargets` の各パスについて、origin が baseline 取得時から
 * 外部変更されているかを判定する。
 *
 * - baseline にあった & 今も存在し、size/mtime が違う → externally-modified
 * - baseline にあった & 今は存在しない → externally-deleted
 * - baseline に無かった & 今は存在する → externally-added
 *   (= workspace 側で新規作成した同名パスがぶつかる恐れ)
 */
export async function detectOriginConflicts(
  baseline: OriginBaseline,
  mergeTargets: string[],
): Promise<OriginConflict[]> {
  const conflicts: OriginConflict[] = [];
  for (const rel of mergeTargets) {
    const entry = baseline.files[rel];
    const abs = path.join(baseline.origin, rel);
    const current = await stat(abs).catch(() => null);
    if (entry && !current) {
      conflicts.push({
        relPath: rel,
        kind: "externally-deleted",
        reason: `origin から外部削除されています (baseline size=${entry.size})`,
      });
      continue;
    }
    if (!entry && current && current.isFile()) {
      conflicts.push({
        relPath: rel,
        kind: "externally-added",
        reason: `origin に外部追加されています (size=${current.size})`,
      });
      continue;
    }
    if (entry && current && current.isFile()) {
      const curMtime = Math.trunc(current.mtimeMs);
      if (current.size !== entry.size || curMtime !== entry.mtime) {
        conflicts.push({
          relPath: rel,
          kind: "externally-modified",
          reason:
            `origin が外部変更されています ` +
            `(baseline size=${entry.size} mtime=${entry.mtime}, ` +
            `current size=${current.size} mtime=${curMtime})`,
        });
      }
    }
  }
  return conflicts;
}

/**
 * `OriginConflict` を `MergeResult.conflicted` 用の `"path: reason"` 文字列に
 * 整形する (既存の文字列形式との互換性維持)。
 */
export function formatConflict(c: OriginConflict): string {
  return `${c.relPath}: ${c.reason}`;
}
