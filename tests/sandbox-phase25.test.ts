/**
 * Phase 25: サンドボックス堅牢化の回帰テスト。
 *
 * - WorkspaceIsolator.diff(): 同一サイズ・同一 mtime でも内容が違えば検出する
 *   (mtime fast-path 削除の検証)
 * - ReflinkStrategy.isSupported(): プローブが origin にゴミを残さない
 * - GitWorktreeStrategy: ブランチ名に random suffix が入っている / 既存の
 *   `sandbox/<basename>` 同名ブランチは削除されない
 *
 * Phase 27 メモ: かつてこのファイルには「SandboxEnvironment のコンストラクタで
 * deprecation 警告が出る」テストが §4 としてあった。Phase 27 で
 * `src/security/SandboxEnvironment.ts` を物理削除したため、それに伴い §4 も削除
 * 済み。ファイル名 "phase25" は歴史的理由でそのまま。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  readdirSync,
  rmSync,
  existsSync,
  utimesSync,
  statSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { spawnSync } from "node:child_process";

import { WorkspaceIsolator } from "../src/sandbox/WorkspaceIsolator.js";
import {
  CopyStrategy,
  GitWorktreeStrategy,
  ReflinkStrategy,
} from "../src/sandbox/strategies.js";

// ────────────────────────────────────────────────────────────────────────────
// 1. filesDiffer: mtime fast-path 削除の検証
// ────────────────────────────────────────────────────────────────────────────

describe("WorkspaceIsolator.diff - Phase 25: mtime fast-path 削除", () => {
  let tempDir: string;
  let origin: string;

  beforeEach(() => {
    tempDir = mkdtempSync(pathJoin(tmpdir(), "phase25-mtime-"));
    origin = pathJoin(tempDir, "origin");
    const fs = require("node:fs");
    fs.mkdirSync(origin, { recursive: true });
    writeFileSync(pathJoin(origin, "hello.txt"), "abcdef"); // 6 bytes
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("同一サイズ・同一 mtime でも内容が違えば diff() で検出される", async () => {
    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "mtime-test",
      strategyOverride: CopyStrategy,
    });

    // workspace 側と origin 側を同じ長さで異なる内容に置き換え、mtime を同期させる。
    // Node の utimesSync はサブ秒精度に OS 依存のブレがあるため、両側を揃えるため
    // 整数秒 (Unix epoch) の固定値を使い、setTime も確実に行う。
    const wsFile = pathJoin(ws.path, "hello.txt");
    const originFile = pathJoin(origin, "hello.txt");
    writeFileSync(wsFile, "XYZxyz"); // 6 bytes (同一サイズ、異なる内容)
    const fixedSec = 1_700_000_000; // 2023-11-14 22:13:20 UTC
    const atime = new Date(fixedSec * 1000);
    const mtime = new Date(fixedSec * 1000);
    utimesSync(wsFile, atime, mtime);
    utimesSync(originFile, atime, mtime);

    const wsStat = statSync(wsFile);
    const originStat = statSync(originFile);
    // 前提: size は一致している（mtime はサブ秒のブレを許容するので確認のみ）
    expect(wsStat.size).toBe(originStat.size);
    // mtime は秒単位で一致しているはず (旧 fast-path が誤発動しうる条件)
    expect(Math.floor(wsStat.mtimeMs / 1000)).toBe(
      Math.floor(originStat.mtimeMs / 1000),
    );

    // Phase 25 以降は size 一致時も内容比較するので、これが "M hello.txt" を返すはず
    // (rsync がある場合の出力と walk fallback 両方に対応する判定)
    const diffText = await ws.diff();
    const detected =
      diffText.includes("hello.txt") && !diffText.includes("(no changes");
    expect(detected).toBe(true);

    await ws.cleanup();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. ReflinkStrategy.isSupported: プローブのゴミが残らない
// ────────────────────────────────────────────────────────────────────────────

describe("ReflinkStrategy.isSupported - Phase 25: プローブ後片付け", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(pathJoin(tmpdir(), "phase25-reflink-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("isSupported() 呼び出し後に origin へプローブのゴミが残らない", async () => {
    // Linux 以外では即 false を返して何も作らないはず
    await ReflinkStrategy.isSupported(tempDir);

    const entries = readdirSync(tempDir);
    const probes = entries.filter((e) => e.startsWith(".luna-reflink-probe"));
    expect(probes).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. GitWorktreeStrategy: ブランチ名 random suffix + 既存ブランチ保護
// ────────────────────────────────────────────────────────────────────────────

function initGitRepo(dir: string): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "t@e",
  };
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  spawnSync("git", ["config", "user.email", "t@e"], { cwd: dir, env });
  spawnSync("git", ["config", "user.name", "test"], { cwd: dir, env });
  writeFileSync(pathJoin(dir, "README.md"), "hello");
  spawnSync("git", ["add", "."], { cwd: dir, env });
  spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir, env });
}

function gitBranchExists(repo: string, branch: string): boolean {
  const res = spawnSync(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: repo },
  );
  return res.status === 0;
}

function gitCurrentBranchIn(worktreePath: string): string {
  const res = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: worktreePath,
  });
  return res.stdout.toString().trim();
}

describe("GitWorktreeStrategy - Phase 25: ブランチ名保護", () => {
  let tempDir: string;
  let origin: string;

  beforeEach(() => {
    tempDir = mkdtempSync(pathJoin(tmpdir(), "phase25-gwt-"));
    origin = pathJoin(tempDir, "origin");
    const fs = require("node:fs");
    fs.mkdirSync(origin, { recursive: true });
    initGitRepo(origin);
  });

  afterEach(() => {
    // ゴミが残っても tempDir ごと消す
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("生成されるブランチ名に random suffix が含まれる", async () => {
    if (!(await GitWorktreeStrategy.isSupported(origin))) {
      return; // git が無い環境では skip
    }
    const target = pathJoin(tempDir, "workspace-a", "task1");
    await GitWorktreeStrategy.clone({
      origin,
      target,
      excludePatterns: [],
    });

    const branch = gitCurrentBranchIn(target);
    // "sandbox/task1-<timestamp>-<random>" の形になっているはず
    expect(branch.startsWith("sandbox/task1-")).toBe(true);
    // suffix 部分が十分長い (timestamp + "-" + random ≥ 10 文字)
    const suffix = branch.slice("sandbox/task1-".length);
    expect(suffix.length).toBeGreaterThanOrEqual(10);

    // 後片付け
    const ws = {
      taskId: "task1",
      path: target,
      origin,
      strategy: "git-worktree" as const,
      createdAt: new Date(),
      cleanup: async () => {},
      merge: async () => ({ applied: [], conflicted: [], skipped: [] }),
      diff: async () => "",
    };
    await GitWorktreeStrategy.cleanup(ws);
  });

  test("ユーザーが既存 'sandbox/<taskId>' ブランチを持っていても削除されない", async () => {
    if (!(await GitWorktreeStrategy.isSupported(origin))) return;

    // ユーザー legitimate な既存ブランチを作る (Phase 24 時代の命名と偶然衝突する形)
    const userBranch = "sandbox/task2";
    const res = spawnSync("git", ["branch", userBranch], { cwd: origin });
    expect(res.status).toBe(0);
    expect(gitBranchExists(origin, userBranch)).toBe(true);

    // sandbox を task2 で作成・破棄
    const target = pathJoin(tempDir, "workspace-b", "task2");
    await GitWorktreeStrategy.clone({
      origin,
      target,
      excludePatterns: [],
    });
    const generated = gitCurrentBranchIn(target);
    expect(generated).not.toBe(userBranch); // random suffix があるので別物

    await GitWorktreeStrategy.cleanup({
      taskId: "task2",
      path: target,
      origin,
      strategy: "git-worktree",
      createdAt: new Date(),
      cleanup: async () => {},
      merge: async () => ({ applied: [], conflicted: [], skipped: [] }),
      diff: async () => "",
    });

    // ユーザーの legitimate ブランチが温存されている
    expect(gitBranchExists(origin, userBranch)).toBe(true);

    // sandbox が作った random suffix 付きブランチは削除されている
    expect(gitBranchExists(origin, generated)).toBe(false);
  });
});

// 旧 §4 (SandboxEnvironment deprecation 警告) は Phase 27 でファイル削除とともに除去。
