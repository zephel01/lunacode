/**
 * Phase 26: `lunacode sandbox` CLI サブコマンドの smoke test。
 *
 * 実行ファイル (`src/cli.ts`) を spawn するとプロバイダ初期化などが
 * 入って重いので、ここでは `src/sandbox/cli.ts` の公開 API を直接叩く。
 * 範囲は「list / diff / clean の動作確認」と「--json 出力」「--dry-run」。
 * merge の実装網羅は workspace-isolator.test.ts / sandbox-phase25.test.ts で
 * 担保されているので、ここではコマンド dispatch の smoke だけ。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import {
  enumerateWorkspaces,
  handleSandboxCommand,
} from "../src/sandbox/cli.js";

function makeFakeWorkspace(
  origin: string,
  taskId: string,
  files: Record<string, string>,
): string {
  const wsPath = pathJoin(origin, ".kairos/sandbox/workspace", taskId);
  mkdirSync(wsPath, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = pathJoin(wsPath, rel);
    mkdirSync(pathJoin(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return wsPath;
}

describe("sandbox CLI - Phase 26", () => {
  let tempDir: string;
  let origin: string;

  beforeEach(() => {
    tempDir = mkdtempSync(pathJoin(tmpdir(), "phase26-cli-"));
    origin = pathJoin(tempDir, "origin");
    mkdirSync(origin, { recursive: true });
    // origin 本体にも同名ファイルを置いておく (diff の比較元)
    writeFileSync(pathJoin(origin, "hello.txt"), "origin-content");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("enumerateWorkspaces() 空 → 0 件", async () => {
    const infos = await enumerateWorkspaces({ origin });
    expect(infos).toEqual([]);
  });

  test("enumerateWorkspaces() 複数 workspace を列挙する", async () => {
    makeFakeWorkspace(origin, "task-a", { "hello.txt": "A" });
    makeFakeWorkspace(origin, "task-b", {
      "hello.txt": "B",
      "nested/file.ts": "export {}",
    });
    const infos = await enumerateWorkspaces({ origin });
    expect(infos.length).toBe(2);
    const ids = infos.map((i) => i.taskId).sort();
    expect(ids).toEqual(["task-a", "task-b"]);
    // strategy hint は `.git` がないので unknown / copy-like
    expect(
      infos.every((i) =>
        ["unknown", "copy-like", "git-worktree"].includes(i.strategyHint),
      ),
    ).toBe(true);
    // size > 0 (B は 2 ファイル入ってる)
    const b = infos.find((i) => i.taskId === "task-b")!;
    expect(b.sizeBytes).toBeGreaterThan(0);
  });

  test("sandbox list --json で JSON を標準出力する", async () => {
    makeFakeWorkspace(origin, "task-c", { "x.txt": "hi" });

    // console.log を捕まえる
    const captured: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      await handleSandboxCommand({ origin }, ["list", "--json"]);
    } finally {
      console.log = orig;
    }
    const joined = captured.join("\n");
    const parsed = JSON.parse(joined);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0].taskId).toBe("task-c");
    // createdAt は ISO string にシリアライズされているはず
    expect(typeof parsed[0].createdAt).toBe("string");
    expect(parsed[0].createdAt).toMatch(/T.*Z$/);
  });

  test("sandbox diff: workspace と origin で内容が違えば 'hello.txt' を含む出力", async () => {
    // workspace 側: origin と異なる内容
    makeFakeWorkspace(origin, "task-diff", {
      "hello.txt": "workspace-content",
    });

    const captured: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stdout.write;
    try {
      await handleSandboxCommand({ origin }, ["diff", "task-diff"]);
    } finally {
      process.stdout.write = origOut;
    }
    const out = captured.join("");
    expect(out).toContain("hello.txt");
  });

  test("sandbox diff: 存在しない taskId は exit code 1", async () => {
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      await handleSandboxCommand({ origin }, ["diff", "nonexistent"]);
      expect(process.exitCode).toBe(1);
      expect(errors.join("\n")).toMatch(/No such workspace/);
    } finally {
      console.error = origErr;
      // bun は一度セットされた process.exitCode を undefined への代入で消さないので、
      // テスト後は明示的に 0 に戻してテストランナー終了時の誤判定を防ぐ。
      process.exitCode = 0;
    }
  });

  test("sandbox clean --all --yes: 全 workspace を削除する", async () => {
    makeFakeWorkspace(origin, "task-1", { "a.txt": "1" });
    makeFakeWorkspace(origin, "task-2", { "a.txt": "2" });
    expect(
      readdirSync(pathJoin(origin, ".kairos/sandbox/workspace")).length,
    ).toBe(2);

    const captured: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      await handleSandboxCommand({ origin }, ["clean", "--all", "--yes"]);
    } finally {
      console.log = orig;
    }

    const infos = await enumerateWorkspaces({ origin });
    expect(infos.length).toBe(0);
    expect(captured.join("\n")).toContain("removed");
  });

  test("sandbox clean --all --dry-run: ファイルは消さない", async () => {
    makeFakeWorkspace(origin, "task-keep", { "a.txt": "1" });

    const captured: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      await handleSandboxCommand({ origin }, [
        "clean",
        "--all",
        "--dry-run",
        "--yes",
      ]);
    } finally {
      console.log = orig;
    }

    const infos = await enumerateWorkspaces({ origin });
    expect(infos.length).toBe(1);
    expect(captured.join("\n")).toMatch(/dry-run/);
  });

  test("sandbox clean <taskId>: 単独の workspace を削除", async () => {
    makeFakeWorkspace(origin, "task-kill", { "a.txt": "1" });
    makeFakeWorkspace(origin, "task-live", { "a.txt": "1" });

    const orig = console.log;
    console.log = () => {};
    try {
      await handleSandboxCommand({ origin }, ["clean", "task-kill", "--yes"]);
    } finally {
      console.log = orig;
    }

    const infos = await enumerateWorkspaces({ origin });
    expect(infos.map((i) => i.taskId).sort()).toEqual(["task-live"]);
  });

  test("sandbox clean --older-than 1000: 未来の cutoff は何も消さない", async () => {
    makeFakeWorkspace(origin, "task-new", { "a.txt": "1" });

    const orig = console.log;
    console.log = () => {};
    try {
      await handleSandboxCommand({ origin }, [
        "clean",
        "--older-than",
        "9999",
        "--yes",
      ]);
    } finally {
      console.log = orig;
    }
    const infos = await enumerateWorkspaces({ origin });
    expect(infos.length).toBe(1);
  });

  test("unknown subcommand → exit code 1", async () => {
    const origErr = console.error;
    const origLog = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      await handleSandboxCommand({ origin }, ["bogus"]);
      expect(process.exitCode).toBe(1);
    } finally {
      console.error = origErr;
      console.log = origLog;
      // bun は undefined への代入で exitCode をクリアしないので明示的に 0 に戻す。
      process.exitCode = 0;
    }
  });
});
