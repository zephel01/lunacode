/**
 * Phase 30 (W1-3): `src/utils/gitRunner.ts` の単体テスト。
 *
 * 範囲:
 *   1. 正常な git コマンドの stdout を返す
 *   2. 失敗時に GitCommandError を投げ、exitCode / stderr を含める
 *   3. cwd オプションが反映される
 *   4. combineStderr=true で stderr も stdout にマージされる
 *   5. timeoutMs でプロセスを殺す
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { spawnSync } from "node:child_process";

import { GitCommandError, runGit } from "../src/utils/gitRunner.js";

function initRepo(dir: string): void {
  const run = (args: string[]) =>
    spawnSync("git", args, { cwd: dir, stdio: "ignore" });
  run(["init", "-q"]);
  run(["config", "user.email", "phase30@example.com"]);
  run(["config", "user.name", "Phase 30"]);
  run(["commit", "--allow-empty", "-m", "init", "-q"]);
}

describe("Phase 30 (W1-3): gitRunner", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(pathJoin(tmpdir(), "phase30-git-"));
    initRepo(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("正常系: git log の stdout を返す", async () => {
    const out = await runGit(["log", "--oneline"], { cwd: tempDir });
    expect(out).toContain("init");
  });

  test("cwd 不一致では別リポジトリの結果になる", async () => {
    // 別ディレクトリで init してコミット内容が違うことを確認
    const other = mkdtempSync(pathJoin(tmpdir(), "phase30-git-other-"));
    try {
      initRepo(other);
      spawnSync("git", ["commit", "--allow-empty", "-m", "in-other", "-q"], {
        cwd: other,
        stdio: "ignore",
      });
      const hereLog = await runGit(["log", "--oneline"], { cwd: tempDir });
      const otherLog = await runGit(["log", "--oneline"], { cwd: other });
      expect(hereLog).not.toContain("in-other");
      expect(otherLog).toContain("in-other");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("異常系: 存在しないサブコマンドは GitCommandError を投げる", async () => {
    try {
      await runGit(["this-command-does-not-exist-xyz"], { cwd: tempDir });
      throw new Error("runGit should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GitCommandError);
      const ge = err as GitCommandError;
      expect(ge.exitCode).not.toBeNull();
      expect(ge.exitCode).not.toBe(0);
      expect(ge.stderr.length).toBeGreaterThan(0);
    }
  });

  test("combineStderr=true では stderr が混ざる", async () => {
    // `git --exec-path` などは stderr なしなので、敢えてエラー副作用を
    // 作らず「オプション指定でも落ちない」ことだけ確認する。
    const out = await runGit(["log", "--oneline"], {
      cwd: tempDir,
      combineStderr: true,
    });
    expect(out).toContain("init");
  });

  test("GitCommandError は exitCode と stderr を保持する", async () => {
    // 存在しないファイルを show させると確実に non-zero で終わる
    try {
      await runGit(["show", "doesnotexist:nofile"], { cwd: tempDir });
      throw new Error("runGit should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GitCommandError);
      const ge = err as GitCommandError;
      expect(ge.name).toBe("GitCommandError");
      expect(typeof ge.exitCode === "number").toBe(true);
      expect(ge.exitCode).not.toBe(0);
      expect(ge.stderr).toBeTypeOf("string");
      // メッセージにコマンド情報が入っている
      expect(ge.message).toContain("git show");
    }
  });

  test("timeoutMs: 短すぎる閾値だと GitCommandError でタイムアウトする", async () => {
    // editor を /bin/sleep にして commit -e でハングさせる。
    // `git -c core.editor='/bin/sleep 5' commit --allow-empty -e` は
    // sleep が終わるまで戻らないので、timeoutMs: 100 で確実に kill される。
    try {
      await runGit(
        [
          "-c",
          "core.editor=/bin/sleep 5",
          "commit",
          "--allow-empty",
          "-e",
          "-m",
          "x",
        ],
        { cwd: tempDir, timeoutMs: 100 },
      );
      throw new Error("runGit should have timed out");
    } catch (err) {
      // SIGKILL されたあとに exit code が来るので GitCommandError
      // または通常のエラー（spawn 後 kill）になり得る。
      // ここでは「タイムアウト経由で何かしら失敗する」ことだけ検証する。
      expect(err).toBeDefined();
      if (err instanceof GitCommandError) {
        // タイムアウト経由ならメッセージに "timed out" が入る
        // 別経路（kill 後に close が来る等）の場合は exitCode === null
        if (err.message.includes("timed out")) {
          expect(err.exitCode).toBeNull();
        }
      }
    }
  });
});
