/**
 * Phase 31: `lunacode parallel` CLI の smoke test。
 *
 * 範囲:
 *   1. `parseParallelArgs()` の引数パース (positional / フラグ / エラー)
 *   2. `handleParallelCommand()` の --help 出力
 *   3. `handleParallelCommand()` の --dry-run 動作 (coordinator を動かさずプラン表示)
 *   4. --on-conflict の検証
 *
 * 実際の並列実行は parallel-coordinator.test.ts で担保済み。ここは
 * CLI dispatch と引数 plumbing の smoke のみ。
 */

import { describe, test, expect } from "bun:test";

import {
  handleParallelCommand,
  parseParallelArgs,
} from "../src/agents/parallelCli.js";

// ────────────────────────────────────────────────────────────────────────────
// 共通ヘルパ: console.log / console.error を捕まえる
// ────────────────────────────────────────────────────────────────────────────

function captureConsole<T>(fn: () => Promise<T>): Promise<{
  out: string;
  err: string;
  value: T;
  exitCode: number | string | undefined;
}> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExitCode = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    err.push(args.map(String).join(" "));
  };
  return (async () => {
    try {
      const value = await fn();
      return {
        out: out.join("\n"),
        err: err.join("\n"),
        value,
        exitCode: process.exitCode,
      };
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.exitCode = origExitCode;
    }
  })();
}

// ────────────────────────────────────────────────────────────────────────────
// parseParallelArgs
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 31: parseParallelArgs", () => {
  test("positional 引数は prompts に入る", () => {
    const p = parseParallelArgs(["p1", "p2", "p3"]);
    expect(p.prompts).toEqual(["p1", "p2", "p3"]);
    expect(p.help).toBe(false);
    expect(p.error).toBeUndefined();
  });

  test("--max-concurrency <n> が数値になる", () => {
    const p = parseParallelArgs(["p", "--max-concurrency", "5"]);
    expect(p.maxConcurrency).toBe(5);
    expect(p.prompts).toEqual(["p"]);
  });

  test("--max-concurrency に非数を渡すと error", () => {
    const p = parseParallelArgs(["p", "--max-concurrency", "abc"]);
    expect(p.error).toBeDefined();
    expect(p.error).toContain("--max-concurrency");
  });

  test("--on-conflict 3 値がそれぞれ受理される", () => {
    for (const v of ["abort", "skip-conflicted", "force"] as const) {
      const p = parseParallelArgs(["p", "--on-conflict", v]);
      expect(p.onConflict).toBe(v);
      expect(p.error).toBeUndefined();
    }
  });

  test("--on-conflict に不正値を渡すと error", () => {
    const p = parseParallelArgs(["p", "--on-conflict", "bogus"]);
    expect(p.error).toBeDefined();
    expect(p.error).toContain("--on-conflict");
  });

  test("--no-auto-merge で autoMerge=false", () => {
    const p = parseParallelArgs(["p", "--no-auto-merge"]);
    expect(p.autoMerge).toBe(false);
  });

  test("--timeout <ms> が数値になる", () => {
    const p = parseParallelArgs(["p", "--timeout", "60000"]);
    expect(p.timeoutMs).toBe(60000);
  });

  test("--keep-on-failure / --dry-run フラグ", () => {
    const p = parseParallelArgs(["p", "--keep-on-failure", "--dry-run"]);
    expect(p.keepOnFailure).toBe(true);
    expect(p.dryRun).toBe(true);
  });

  test("--help / -h は help=true", () => {
    expect(parseParallelArgs(["--help"]).help).toBe(true);
    expect(parseParallelArgs(["-h"]).help).toBe(true);
  });

  test("未知のフラグは error", () => {
    const p = parseParallelArgs(["p", "--bogus"]);
    expect(p.error).toBeDefined();
    expect(p.error).toContain("--bogus");
  });

  test("既定値: maxConcurrency=3, onConflict=abort, autoMerge=true", () => {
    const p = parseParallelArgs(["p"]);
    expect(p.maxConcurrency).toBe(3);
    expect(p.onConflict).toBe("abort");
    expect(p.autoMerge).toBe(true);
    expect(p.keepOnFailure).toBe(false);
    expect(p.dryRun).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// handleParallelCommand
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 31: handleParallelCommand", () => {
  test("--help で usage を出力する", async () => {
    const { out } = await captureConsole(() =>
      handleParallelCommand({ origin: process.cwd() }, ["--help"]),
    );
    expect(out).toContain("lunacode parallel");
    expect(out).toContain("--max-concurrency");
    expect(out).toContain("--on-conflict");
    expect(out).toContain("--no-auto-merge");
    expect(out).toContain("--timeout");
  });

  test("引数 0 個だとエラーを出して exitCode=1", async () => {
    const { err, exitCode } = await captureConsole(() =>
      handleParallelCommand({ origin: process.cwd() }, []),
    );
    expect(err).toContain("at least one prompt");
    expect(exitCode).toBe(1);
  });

  test("不正な --on-conflict でエラーを出して exitCode=1", async () => {
    const { err, exitCode } = await captureConsole(() =>
      handleParallelCommand({ origin: process.cwd() }, [
        "p",
        "--on-conflict",
        "bogus",
      ]),
    );
    expect(err).toContain("--on-conflict");
    expect(exitCode).toBe(1);
  });

  test("--dry-run で coordinator を起動せず plan を JSON 出力", async () => {
    const { out, exitCode } = await captureConsole(() =>
      handleParallelCommand({ origin: process.cwd() }, [
        "task one",
        "task two",
        "--max-concurrency",
        "2",
        "--on-conflict",
        "skip-conflicted",
        "--timeout",
        "1000",
        "--dry-run",
      ]),
    );
    expect(out).toContain("Dry-run");
    expect(out).toContain("task one");
    expect(out).toContain("task two");
    expect(out).toContain("skip-conflicted");
    // JSON ブロック内に maxConcurrency: 2 が入っている
    expect(out).toMatch(/"maxConcurrency":\s*2/);
    // id が自動採番されている
    expect(out).toContain("parallel-task-1");
    expect(out).toContain("parallel-task-2");
    expect(exitCode).toBe(0);
  });
});
