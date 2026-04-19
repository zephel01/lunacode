/**
 * Phase 28: `autoMerge` の衝突検知（origin 並行変更の detect）テスト。
 *
 *  1. `baseline.ts` の単体 (captureBaseline / loadBaseline / detectOriginConflicts)
 *  2. `WorkspaceIsolator.create()` が baseline を保存する
 *  3. `merge()` が origin 外部変更を検知して 3 つの onConflict モードで動作する
 *  4. CLI `sandbox merge --on-conflict` smoke
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import {
  captureBaseline,
  loadBaseline,
  detectOriginConflicts,
  baselinePathFor,
  removeBaseline,
  type OriginBaseline,
} from "../src/sandbox/baseline.js";
import { WorkspaceIsolator } from "../src/sandbox/WorkspaceIsolator.js";
import { handleSandboxCommand } from "../src/sandbox/cli.js";

// ────────────────────────────────────────────────────────────────────────────
// テスト用ヘルパ
// ────────────────────────────────────────────────────────────────────────────

/** file の mtime を 1 秒進める (秒未満の精度を食うプラットフォームでも検知できるように) */
function bumpMtime(file: string, deltaSec = 2): void {
  const now = Date.now() / 1000;
  utimesSync(file, now + deltaSec, now + deltaSec);
}

// ────────────────────────────────────────────────────────────────────────────
// 1. baseline.ts 単体
// ────────────────────────────────────────────────────────────────────────────

describe("baseline.ts - Phase 28", () => {
  let tempDir: string;
  let origin: string;

  beforeEach(() => {
    tempDir = mkdtempSync(pathJoin(tmpdir(), "phase28-baseline-"));
    origin = pathJoin(tempDir, "origin");
    mkdirSync(origin, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("captureBaseline は origin 全ファイルを size/mtime で記録する", async () => {
    writeFileSync(pathJoin(origin, "a.txt"), "hello");
    mkdirSync(pathJoin(origin, "sub"), { recursive: true });
    writeFileSync(pathJoin(origin, "sub", "b.txt"), "world!");

    const outPath = pathJoin(tempDir, "bl.json");
    const b = await captureBaseline({
      origin,
      taskId: "t1",
      excludePatterns: [],
      outPath,
    });

    expect(b.version).toBe(1);
    expect(b.taskId).toBe("t1");
    expect(Object.keys(b.files).sort()).toEqual(["a.txt", "sub/b.txt"]);
    expect(b.files["a.txt"]!.size).toBe(5);
    expect(b.files["sub/b.txt"]!.size).toBe(6);
    expect(existsSync(outPath)).toBe(true);

    const reloaded = await loadBaseline(outPath);
    expect(reloaded?.taskId).toBe("t1");
    expect(reloaded?.files["a.txt"]?.size).toBe(5);
  });

  test("excludePatterns にマッチするファイルは baseline に含まれない", async () => {
    writeFileSync(pathJoin(origin, "keep.ts"), "1");
    writeFileSync(pathJoin(origin, "drop.log"), "2");
    mkdirSync(pathJoin(origin, "node_modules"), { recursive: true });
    writeFileSync(
      pathJoin(origin, "node_modules", "m.js"),
      "should-be-excluded",
    );

    const outPath = pathJoin(tempDir, "bl.json");
    const b = await captureBaseline({
      origin,
      taskId: "t2",
      excludePatterns: ["*.log", "node_modules"],
      outPath,
    });
    expect(Object.keys(b.files).sort()).toEqual(["keep.ts"]);
  });

  test("loadBaseline は不正な JSON では null", async () => {
    const p = pathJoin(tempDir, "bad.json");
    writeFileSync(p, "not json");
    expect(await loadBaseline(p)).toBeNull();

    const p2 = pathJoin(tempDir, "missing.json");
    expect(await loadBaseline(p2)).toBeNull();
  });

  test("loadBaseline は version !== 1 を拒否", async () => {
    const p = pathJoin(tempDir, "v2.json");
    writeFileSync(
      p,
      JSON.stringify({
        version: 2,
        taskId: "x",
        origin: "/tmp",
        createdAt: "now",
        files: {},
      }),
    );
    expect(await loadBaseline(p)).toBeNull();
  });

  test("detectOriginConflicts: 変更なしなら空配列", async () => {
    writeFileSync(pathJoin(origin, "a.txt"), "hello");
    const outPath = pathJoin(tempDir, "bl.json");
    const baseline = await captureBaseline({
      origin,
      taskId: "t",
      excludePatterns: [],
      outPath,
    });
    const conflicts = await detectOriginConflicts(baseline, ["a.txt"]);
    expect(conflicts).toEqual([]);
  });

  test("detectOriginConflicts: externally-modified を検出", async () => {
    writeFileSync(pathJoin(origin, "a.txt"), "hello");
    const baseline = await captureBaseline({
      origin,
      taskId: "t",
      excludePatterns: [],
      outPath: pathJoin(tempDir, "bl.json"),
    });
    // サイズも mtime も変える
    writeFileSync(pathJoin(origin, "a.txt"), "completely different content");
    bumpMtime(pathJoin(origin, "a.txt"), 5);

    const conflicts = await detectOriginConflicts(baseline, ["a.txt"]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe("externally-modified");
    expect(conflicts[0]!.relPath).toBe("a.txt");
  });

  test("detectOriginConflicts: externally-deleted を検出", async () => {
    writeFileSync(pathJoin(origin, "a.txt"), "hello");
    const baseline = await captureBaseline({
      origin,
      taskId: "t",
      excludePatterns: [],
      outPath: pathJoin(tempDir, "bl.json"),
    });
    rmSync(pathJoin(origin, "a.txt"));

    const conflicts = await detectOriginConflicts(baseline, ["a.txt"]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe("externally-deleted");
  });

  test("detectOriginConflicts: externally-added を検出", async () => {
    // baseline 時点では存在しない
    const baseline = await captureBaseline({
      origin,
      taskId: "t",
      excludePatterns: [],
      outPath: pathJoin(tempDir, "bl.json"),
    });
    // その後 origin に外部追加
    writeFileSync(pathJoin(origin, "new.txt"), "added externally");

    const conflicts = await detectOriginConflicts(baseline, ["new.txt"]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe("externally-added");
  });

  test("removeBaseline はファイルを削除し、存在しない場合は無視", async () => {
    const p = pathJoin(tempDir, "to-remove.json");
    writeFileSync(p, "{}");
    await removeBaseline(p);
    expect(existsSync(p)).toBe(false);
    // 二回目は例外を投げない
    await removeBaseline(p);
  });

  test("baselinePathFor は <basePath>/<taskId>.baseline.json を返す", () => {
    const p = baselinePathFor("/tmp/base", "session_abc");
    expect(p).toBe("/tmp/base/session_abc.baseline.json");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. WorkspaceIsolator: baseline 保存
// ────────────────────────────────────────────────────────────────────────────

describe("WorkspaceIsolator.create saves baseline - Phase 28", () => {
  let tempDir: string;
  let origin: string;

  beforeEach(() => {
    tempDir = mkdtempSync(pathJoin(tmpdir(), "phase28-create-"));
    origin = pathJoin(tempDir, "origin");
    mkdirSync(origin, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("create() 後に <basePath>/<taskId>.baseline.json が作られている", async () => {
    writeFileSync(pathJoin(origin, "a.ts"), "1");
    writeFileSync(pathJoin(origin, "b.ts"), "2");

    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "task-b1",
      config: { strategy: "copy", respectGitignore: false },
    });
    try {
      const expected = pathJoin(
        origin,
        ".kairos/sandbox/workspace",
        "task-b1.baseline.json",
      );
      expect(existsSync(expected)).toBe(true);
      const b = JSON.parse(readFileSync(expected, "utf8")) as OriginBaseline;
      expect(b.taskId).toBe("task-b1");
      expect(Object.keys(b.files).sort()).toEqual(["a.ts", "b.ts"]);
    } finally {
      await ws.cleanup();
    }
  });

  test("cleanup() で baseline ファイルも削除される", async () => {
    writeFileSync(pathJoin(origin, "a.ts"), "1");
    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "task-b2",
      config: { strategy: "copy", respectGitignore: false },
    });
    const blPath = pathJoin(
      origin,
      ".kairos/sandbox/workspace",
      "task-b2.baseline.json",
    );
    expect(existsSync(blPath)).toBe(true);
    await ws.cleanup();
    expect(existsSync(blPath)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. WorkspaceIsolator.merge: 3 モード
// ────────────────────────────────────────────────────────────────────────────

describe("WorkspaceIsolator.merge onConflict - Phase 28", () => {
  let tempDir: string;
  let origin: string;

  beforeEach(() => {
    tempDir = mkdtempSync(pathJoin(tmpdir(), "phase28-merge-"));
    origin = pathJoin(tempDir, "origin");
    mkdirSync(origin, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("onConflict 既定 'abort': 衝突があれば何も適用しない", async () => {
    writeFileSync(pathJoin(origin, "shared.ts"), "origin-v1");
    writeFileSync(pathJoin(origin, "free.ts"), "free-v1");

    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "task-abort",
      config: { strategy: "copy", respectGitignore: false },
    });
    try {
      // workspace 側で両方編集
      writeFileSync(pathJoin(ws.path, "shared.ts"), "ws-edited");
      writeFileSync(pathJoin(ws.path, "free.ts"), "ws-free-edit");
      // origin 側で shared.ts を並行変更
      writeFileSync(pathJoin(origin, "shared.ts"), "origin-external-edit");
      bumpMtime(pathJoin(origin, "shared.ts"));

      const result = await ws.merge({});

      expect(result.applied).toEqual([]);
      expect(result.conflicted.length).toBe(1);
      expect(result.conflicted[0]).toContain("shared.ts");
      expect(result.skipped).toContain("free.ts");
      // origin の内容は変更されない
      expect(readFileSync(pathJoin(origin, "shared.ts"), "utf8")).toBe(
        "origin-external-edit",
      );
      expect(readFileSync(pathJoin(origin, "free.ts"), "utf8")).toBe("free-v1");
    } finally {
      await ws.cleanup();
    }
  });

  test("onConflict 'skip-conflicted': 衝突分だけ飛ばし、他は適用", async () => {
    writeFileSync(pathJoin(origin, "shared.ts"), "origin-v1");
    writeFileSync(pathJoin(origin, "free.ts"), "free-v1");

    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "task-skip",
      config: { strategy: "copy", respectGitignore: false },
    });
    try {
      writeFileSync(pathJoin(ws.path, "shared.ts"), "ws-edited");
      writeFileSync(pathJoin(ws.path, "free.ts"), "ws-free-edit");
      writeFileSync(pathJoin(origin, "shared.ts"), "origin-external-edit");
      bumpMtime(pathJoin(origin, "shared.ts"));

      const result = await ws.merge({ onConflict: "skip-conflicted" });

      expect(result.applied).toContain("free.ts");
      expect(result.applied).not.toContain("shared.ts");
      expect(result.conflicted.some((c) => c.includes("shared.ts"))).toBe(true);
      expect(result.skipped).toContain("shared.ts");
      // origin: free.ts は workspace 版、shared.ts は外部変更のまま
      expect(readFileSync(pathJoin(origin, "free.ts"), "utf8")).toBe(
        "ws-free-edit",
      );
      expect(readFileSync(pathJoin(origin, "shared.ts"), "utf8")).toBe(
        "origin-external-edit",
      );
    } finally {
      await ws.cleanup();
    }
  });

  test("onConflict 'force': 衝突無視で全件上書き (従来挙動)", async () => {
    writeFileSync(pathJoin(origin, "shared.ts"), "origin-v1");

    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "task-force",
      config: { strategy: "copy", respectGitignore: false },
    });
    try {
      writeFileSync(pathJoin(ws.path, "shared.ts"), "ws-edited");
      writeFileSync(pathJoin(origin, "shared.ts"), "origin-external-edit");
      bumpMtime(pathJoin(origin, "shared.ts"));

      const result = await ws.merge({ onConflict: "force" });

      expect(result.applied).toContain("shared.ts");
      expect(result.conflicted).toEqual([]);
      expect(readFileSync(pathJoin(origin, "shared.ts"), "utf8")).toBe(
        "ws-edited",
      );
    } finally {
      await ws.cleanup();
    }
  });

  test("衝突が無い場合は abort でも applied に入る", async () => {
    writeFileSync(pathJoin(origin, "free.ts"), "v1");

    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "task-clean",
      config: { strategy: "copy", respectGitignore: false },
    });
    try {
      writeFileSync(pathJoin(ws.path, "free.ts"), "v2");

      const result = await ws.merge({ onConflict: "abort" });

      expect(result.applied).toEqual(["free.ts"]);
      expect(result.conflicted).toEqual([]);
      expect(readFileSync(pathJoin(origin, "free.ts"), "utf8")).toBe("v2");
    } finally {
      await ws.cleanup();
    }
  });

  test("dryRun では常に preview に CONFLICT 行が出る", async () => {
    writeFileSync(pathJoin(origin, "shared.ts"), "origin-v1");

    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "task-dry",
      config: { strategy: "copy", respectGitignore: false },
    });
    try {
      writeFileSync(pathJoin(ws.path, "shared.ts"), "ws-edited");
      writeFileSync(pathJoin(origin, "shared.ts"), "origin-external-edit");
      bumpMtime(pathJoin(origin, "shared.ts"));

      const result = await ws.merge({ dryRun: true });

      expect(result.applied).toEqual([]);
      expect(result.conflicted.length).toBe(1);
      expect(result.preview).toContain("CONFLICT");
      // origin は手付かず
      expect(readFileSync(pathJoin(origin, "shared.ts"), "utf8")).toBe(
        "origin-external-edit",
      );
    } finally {
      await ws.cleanup();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. CLI smoke: --on-conflict
// ────────────────────────────────────────────────────────────────────────────

describe("CLI sandbox merge --on-conflict - Phase 28", () => {
  let tempDir: string;
  let origin: string;

  beforeEach(() => {
    tempDir = mkdtempSync(pathJoin(tmpdir(), "phase28-cli-"));
    origin = pathJoin(tempDir, "origin");
    mkdirSync(origin, { recursive: true });
    process.exitCode = 0;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  test("不正な --on-conflict 値は exit code 1", async () => {
    writeFileSync(pathJoin(origin, "a.ts"), "1");
    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "task-cli-bad",
      config: { strategy: "copy", respectGitignore: false },
    });
    try {
      await handleSandboxCommand({ origin }, [
        "merge",
        "task-cli-bad",
        "--apply",
        "--on-conflict",
        "nope",
      ]);
      expect(process.exitCode).toBe(1);
    } finally {
      await ws.cleanup();
    }
  });

  test("--on-conflict abort (既定) は dryRun で CONFLICT 表示", async () => {
    writeFileSync(pathJoin(origin, "a.ts"), "v1");
    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "task-cli-abort",
      config: { strategy: "copy", respectGitignore: false },
    });
    try {
      writeFileSync(pathJoin(ws.path, "a.ts"), "ws-v2");
      writeFileSync(pathJoin(origin, "a.ts"), "external-v2");
      bumpMtime(pathJoin(origin, "a.ts"));

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.map((a) => String(a)).join(" "));
      };
      try {
        await handleSandboxCommand({ origin }, ["merge", "task-cli-abort"]);
      } finally {
        console.log = origLog;
      }
      const joined = logs.join("\n");
      // dry-run なので origin は未変更
      expect(readFileSync(pathJoin(origin, "a.ts"), "utf8")).toBe(
        "external-v2",
      );
      expect(joined).toContain("Dry-run merge preview");
      expect(joined).toContain("conflicted");
    } finally {
      await ws.cleanup();
    }
  });

  test("--on-conflict force --apply で上書き", async () => {
    writeFileSync(pathJoin(origin, "a.ts"), "v1");
    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "task-cli-force",
      config: { strategy: "copy", respectGitignore: false },
    });
    try {
      writeFileSync(pathJoin(ws.path, "a.ts"), "ws-v2");
      writeFileSync(pathJoin(origin, "a.ts"), "external-v2");
      bumpMtime(pathJoin(origin, "a.ts"));

      const origLog = console.log;
      console.log = () => {};
      try {
        await handleSandboxCommand({ origin }, [
          "merge",
          "task-cli-force",
          "--apply",
          "--on-conflict",
          "force",
        ]);
      } finally {
        console.log = origLog;
      }
      expect(readFileSync(pathJoin(origin, "a.ts"), "utf8")).toBe("ws-v2");
    } finally {
      await ws.cleanup();
    }
  });
});
