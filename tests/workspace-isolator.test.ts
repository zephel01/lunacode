/**
 * WorkspaceIsolator と各ストラテジーのテスト。
 *
 * - detectBestStrategy: 環境依存なので、CopyStrategy が常に isSupported()=true
 *   であることだけ保証し、他は返却値の型が正しいことのみ確認
 * - CopyStrategy: ポータブル実装なので CI 環境でも確実に動く (メインの検証)
 * - git-worktree / reflink / apfs-clone: 環境があれば動くことを確認、
 *   無ければスキップされる設計であることを確認
 * - WorkspaceIsolator.create(): copy 強制で create → 編集 → diff → merge → cleanup
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import { WorkspaceIsolator } from "../src/sandbox/WorkspaceIsolator.js";
import {
  ApfsCloneStrategy,
  CopyStrategy,
  GitWorktreeStrategy,
  ReflinkStrategy,
  detectBestStrategy,
  ALL_STRATEGIES,
} from "../src/sandbox/strategies.js";

// ────────────────────────────────────────────────────────────────────────────
// Strategy レジストリ
// ────────────────────────────────────────────────────────────────────────────

describe("strategies - レジストリ", () => {
  test("ALL_STRATEGIES に 4 種類含まれる", () => {
    const names = ALL_STRATEGIES.map((s) => s.name);
    expect(names).toContain("apfs-clone");
    expect(names).toContain("reflink");
    expect(names).toContain("git-worktree");
    expect(names).toContain("copy");
  });

  test("CopyStrategy は常に isSupported=true", async () => {
    expect(await CopyStrategy.isSupported("/tmp")).toBe(true);
  });

  test("ApfsCloneStrategy は macOS 以外では false", async () => {
    if (process.platform !== "darwin") {
      expect(await ApfsCloneStrategy.isSupported("/tmp")).toBe(false);
    }
  });

  test("ReflinkStrategy は Linux 以外では false", async () => {
    if (process.platform !== "linux") {
      expect(await ReflinkStrategy.isSupported("/tmp")).toBe(false);
    }
  });
});

describe("detectBestStrategy", () => {
  test("何らかのストラテジーを返す", async () => {
    const strategy = await detectBestStrategy("/tmp");
    expect(strategy).toBeDefined();
    expect(ALL_STRATEGIES).toContain(strategy);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// CopyStrategy 直接テスト
// ────────────────────────────────────────────────────────────────────────────

describe("CopyStrategy", () => {
  let tempDir: string;
  let origin: string;
  let target: string;

  beforeEach(() => {
    tempDir = mkdtempSync(pathJoin(tmpdir(), "copy-strategy-"));
    origin = pathJoin(tempDir, "origin");
    target = pathJoin(tempDir, "target");
    mkdirSync(origin, { recursive: true });
    writeFileSync(pathJoin(origin, "a.txt"), "hello");
    mkdirSync(pathJoin(origin, "sub"), { recursive: true });
    writeFileSync(pathJoin(origin, "sub", "b.txt"), "world");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("ファイル・サブディレクトリを全コピーする", async () => {
    await CopyStrategy.clone({ origin, target, excludePatterns: [] });
    expect(readFileSync(pathJoin(target, "a.txt"), "utf-8")).toBe("hello");
    expect(readFileSync(pathJoin(target, "sub", "b.txt"), "utf-8")).toBe(
      "world",
    );
  });

  test("excludePatterns に含まれるディレクトリはコピーしない", async () => {
    mkdirSync(pathJoin(origin, "node_modules"), { recursive: true });
    writeFileSync(pathJoin(origin, "node_modules", "deep.js"), "// deep");

    await CopyStrategy.clone({
      origin,
      target,
      excludePatterns: ["node_modules"],
    });
    expect(existsSync(pathJoin(target, "node_modules"))).toBe(false);
    expect(existsSync(pathJoin(target, "a.txt"))).toBe(true);
  });

  test("コピー後の編集は origin に波及しない", async () => {
    await CopyStrategy.clone({ origin, target, excludePatterns: [] });
    writeFileSync(pathJoin(target, "a.txt"), "modified");
    expect(readFileSync(pathJoin(origin, "a.txt"), "utf-8")).toBe("hello");
    expect(readFileSync(pathJoin(target, "a.txt"), "utf-8")).toBe("modified");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// WorkspaceIsolator のフルフロー
// ────────────────────────────────────────────────────────────────────────────

describe("WorkspaceIsolator - 基本フロー", () => {
  let tempDir: string;
  let origin: string;

  beforeEach(() => {
    tempDir = mkdtempSync(pathJoin(tmpdir(), "workspace-isolator-"));
    origin = pathJoin(tempDir, "project");
    mkdirSync(origin, { recursive: true });
    writeFileSync(pathJoin(origin, "README.md"), "# original");
    mkdirSync(pathJoin(origin, "src"), { recursive: true });
    writeFileSync(pathJoin(origin, "src", "index.ts"), "export const x = 1;");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("create() で workspace が作られ origin と分離されている", async () => {
    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "t1",
      config: { strategy: "copy" },
      strategyOverride: CopyStrategy,
    });
    expect(ws.path).not.toBe(origin);
    expect(existsSync(pathJoin(ws.path, "README.md"))).toBe(true);
    expect(readFileSync(pathJoin(ws.path, "src", "index.ts"), "utf-8")).toBe(
      "export const x = 1;",
    );
    await ws.cleanup();
  });

  test("workspace 内の編集は origin に影響しない", async () => {
    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "t2",
      strategyOverride: CopyStrategy,
    });
    writeFileSync(pathJoin(ws.path, "README.md"), "# modified");
    writeFileSync(pathJoin(ws.path, "new.txt"), "fresh");
    expect(readFileSync(pathJoin(origin, "README.md"), "utf-8")).toBe(
      "# original",
    );
    expect(existsSync(pathJoin(origin, "new.txt"))).toBe(false);
    await ws.cleanup();
  });

  test("diff() が変更ファイルを検出する", async () => {
    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "t3",
      strategyOverride: CopyStrategy,
    });
    // ファイル更新 (ただし size が同じだと mtime 比較に失敗しうるので内容を変える)
    writeFileSync(pathJoin(ws.path, "README.md"), "# MODIFIED CONTENT");
    const diff = await ws.diff();
    expect(typeof diff).toBe("string");
    // rsync がある環境なら README.md が入る、無くても fallback walk が検出する
    expect(diff.toLowerCase()).toContain("readme.md");
    await ws.cleanup();
  });

  test("merge({ dryRun: true }) は origin を変更しない", async () => {
    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "t4",
      strategyOverride: CopyStrategy,
    });
    writeFileSync(pathJoin(ws.path, "README.md"), "# dry-run-test");
    const plan = await ws.merge({ dryRun: true });
    expect(plan.applied).toEqual([]);
    expect(plan.skipped.length).toBeGreaterThan(0);
    expect(plan.preview).toContain("README.md");
    expect(readFileSync(pathJoin(origin, "README.md"), "utf-8")).toBe(
      "# original",
    );
    await ws.cleanup();
  });

  test("merge() が実際に origin へ反映する", async () => {
    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "t5",
      strategyOverride: CopyStrategy,
    });
    writeFileSync(pathJoin(ws.path, "README.md"), "# merged-content");
    writeFileSync(pathJoin(ws.path, "src", "new.ts"), "export const y = 2;");
    const result = await ws.merge();
    expect(result.applied).toContain("README.md");
    expect(result.applied.some((p) => p.includes("new.ts"))).toBe(true);
    expect(readFileSync(pathJoin(origin, "README.md"), "utf-8")).toBe(
      "# merged-content",
    );
    expect(readFileSync(pathJoin(origin, "src", "new.ts"), "utf-8")).toBe(
      "export const y = 2;",
    );
    await ws.cleanup();
  });

  test("cleanup() で workspace ディレクトリが消える", async () => {
    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "t6",
      strategyOverride: CopyStrategy,
    });
    expect(existsSync(ws.path)).toBe(true);
    await ws.cleanup();
    expect(existsSync(ws.path)).toBe(false);
  });

  test("cleanup() は冪等 (二度呼んでも例外を投げない)", async () => {
    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "t7",
      strategyOverride: CopyStrategy,
    });
    await ws.cleanup();
    await ws.cleanup(); // 例外を投げない
    expect(existsSync(ws.path)).toBe(false);
  });
});

describe("WorkspaceIsolator - 設定", () => {
  let tempDir: string;
  let origin: string;

  beforeEach(() => {
    tempDir = mkdtempSync(pathJoin(tmpdir(), "workspace-isolator-cfg-"));
    origin = pathJoin(tempDir, "project");
    mkdirSync(origin, { recursive: true });
    writeFileSync(pathJoin(origin, "a.txt"), "a");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("既定で node_modules 等は除外される", async () => {
    mkdirSync(pathJoin(origin, "node_modules", "lib"), { recursive: true });
    writeFileSync(pathJoin(origin, "node_modules", "lib", "x.js"), "// x");
    mkdirSync(pathJoin(origin, "dist"), { recursive: true });
    writeFileSync(pathJoin(origin, "dist", "y.js"), "// y");

    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "cfg1",
      strategyOverride: CopyStrategy,
    });
    expect(existsSync(pathJoin(ws.path, "a.txt"))).toBe(true);
    expect(existsSync(pathJoin(ws.path, "node_modules"))).toBe(false);
    expect(existsSync(pathJoin(ws.path, "dist"))).toBe(false);
    await ws.cleanup();
  });

  test("config.basePath でカスタムパスを指定できる", async () => {
    const customBase = pathJoin(tempDir, "custom-sandbox");
    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "cfg2",
      config: { basePath: customBase },
      strategyOverride: CopyStrategy,
    });
    expect(ws.path).toBe(pathJoin(customBase, "cfg2"));
    await ws.cleanup();
  });

  test("同じ taskId を二度 create すると例外", async () => {
    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "cfg3",
      strategyOverride: CopyStrategy,
    });
    await expect(
      WorkspaceIsolator.create({
        origin,
        taskId: "cfg3",
        strategyOverride: CopyStrategy,
      }),
    ).rejects.toThrow(/already exists/);
    await ws.cleanup();
  });

  test("origin がディレクトリでないと例外", async () => {
    const notDir = pathJoin(tempDir, "not-a-dir.txt");
    writeFileSync(notDir, "file");
    await expect(
      WorkspaceIsolator.create({
        origin: notDir,
        taskId: "cfg4",
        strategyOverride: CopyStrategy,
      }),
    ).rejects.toThrow(/not a directory/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// git-worktree ストラテジー (環境依存)
// ────────────────────────────────────────────────────────────────────────────

describe("GitWorktreeStrategy", () => {
  test("非 git ディレクトリでは isSupported=false", async () => {
    const tempDir = mkdtempSync(pathJoin(tmpdir(), "git-worktree-nogit-"));
    try {
      expect(await GitWorktreeStrategy.isSupported(tempDir)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
