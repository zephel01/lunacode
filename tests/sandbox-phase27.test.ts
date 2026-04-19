/**
 * Phase 27: 除外パターンの glob 化と `.gitignore` 連携の回帰テスト。
 *
 * ここでは大きく 3 軸を検証する:
 *  1. `patternMatch.ts` の単体マッチング (gitignore 互換セマンティクス)
 *  2. `WorkspaceIsolator` が glob パターンで除外する (CopyStrategy 経由)
 *  3. `WorkspaceIsolator` が `origin/.gitignore` を自動取り込みする
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import {
  compilePattern,
  compileAll,
  matchAny,
  matchOne,
  parseGitignore,
} from "../src/sandbox/patternMatch.js";
import { WorkspaceIsolator } from "../src/sandbox/WorkspaceIsolator.js";

// ────────────────────────────────────────────────────────────────────────────
// 1. patternMatch ユニット
// ────────────────────────────────────────────────────────────────────────────

describe("patternMatch.compilePattern - Phase 27", () => {
  test("空 / コメントは null", () => {
    expect(compilePattern("")).toBeNull();
    expect(compilePattern("   ")).toBeNull();
    expect(compilePattern("# comment")).toBeNull();
  });

  test("単純名はあらゆる深さの basename にマッチ", () => {
    const c = compilePattern("node_modules")!;
    expect(c).not.toBeNull();
    expect(c.pathy).toBe(false);
    expect(matchOne(c, { relPath: "node_modules", isDirectory: true })).toBe(
      true,
    );
    expect(
      matchOne(c, { relPath: "src/node_modules", isDirectory: true }),
    ).toBe(true);
    expect(
      matchOne(c, { relPath: "a/b/c/node_modules", isDirectory: true }),
    ).toBe(true);
    expect(
      matchOne(c, { relPath: "node_modules/foo", isDirectory: false }),
    ).toBe(false);
  });

  test("先頭 `/` は root anchored", () => {
    const c = compilePattern("/build")!;
    expect(c.anchored).toBe(true);
    expect(matchOne(c, { relPath: "build", isDirectory: true })).toBe(true);
    expect(matchOne(c, { relPath: "src/build", isDirectory: true })).toBe(
      false,
    );
  });

  test("末尾 `/` は dirOnly", () => {
    const c = compilePattern("tmp/")!;
    expect(c.dirOnly).toBe(true);
    expect(matchOne(c, { relPath: "tmp", isDirectory: true })).toBe(true);
    expect(matchOne(c, { relPath: "tmp", isDirectory: false })).toBe(false);
  });

  test("`*.log` は basename のワイルドカード", () => {
    const c = compilePattern("*.log")!;
    expect(matchOne(c, { relPath: "foo.log", isDirectory: false })).toBe(true);
    expect(matchOne(c, { relPath: "src/foo.log", isDirectory: false })).toBe(
      true,
    );
    expect(matchOne(c, { relPath: "foo.txt", isDirectory: false })).toBe(false);
    // `*` は `/` を跨がない
    expect(matchOne(c, { relPath: "a/b.log", isDirectory: false })).toBe(true);
    expect(matchOne(c, { relPath: "a.log/file", isDirectory: false })).toBe(
      false,
    );
  });

  test("末尾 `/**` はサブツリー全体", () => {
    const c = compilePattern("dist/**")!;
    expect(matchOne(c, { relPath: "dist", isDirectory: true })).toBe(true);
    expect(matchOne(c, { relPath: "dist/foo", isDirectory: false })).toBe(true);
    expect(matchOne(c, { relPath: "dist/a/b/c", isDirectory: false })).toBe(
      true,
    );
    expect(matchOne(c, { relPath: "src/dist", isDirectory: true })).toBe(false);
  });

  test("先頭 `**/` は任意深さの接頭辞", () => {
    const c = compilePattern("**/foo.txt")!;
    expect(matchOne(c, { relPath: "foo.txt", isDirectory: false })).toBe(true);
    expect(matchOne(c, { relPath: "a/foo.txt", isDirectory: false })).toBe(
      true,
    );
    expect(matchOne(c, { relPath: "a/b/foo.txt", isDirectory: false })).toBe(
      true,
    );
  });

  test("中間 `/**/` は任意の中間パス", () => {
    const c = compilePattern("a/**/z")!;
    expect(matchOne(c, { relPath: "a/z", isDirectory: false })).toBe(true);
    expect(matchOne(c, { relPath: "a/b/z", isDirectory: false })).toBe(true);
    expect(matchOne(c, { relPath: "a/b/c/z", isDirectory: false })).toBe(true);
    expect(matchOne(c, { relPath: "x/a/z", isDirectory: false })).toBe(false);
  });

  test("`?` は 1 文字 (スラッシュ除く)", () => {
    const c = compilePattern("file?.ts")!;
    expect(matchOne(c, { relPath: "file1.ts", isDirectory: false })).toBe(true);
    expect(matchOne(c, { relPath: "filex.ts", isDirectory: false })).toBe(true);
    expect(matchOne(c, { relPath: "file12.ts", isDirectory: false })).toBe(
      false,
    );
    expect(matchOne(c, { relPath: "file/.ts", isDirectory: false })).toBe(
      false,
    );
  });

  test("`!negation` フラグが立つ", () => {
    const c = compilePattern("!keep.log")!;
    expect(c.negated).toBe(true);
    // matchOne 自体は論理マッチを返す (極性は呼び出し側責務)
    expect(matchOne(c, { relPath: "keep.log", isDirectory: false })).toBe(true);
  });
});

describe("patternMatch.matchAny - Phase 27", () => {
  test("マッチ無し → 含める (false)", () => {
    const compiled = compileAll(["node_modules", "*.log"]);
    expect(
      matchAny(compiled, { relPath: "src/main.ts", isDirectory: false }),
    ).toBe(false);
  });

  test("ポジティブマッチ → 除外 (true)", () => {
    const compiled = compileAll(["node_modules", "*.log"]);
    expect(
      matchAny(compiled, { relPath: "node_modules", isDirectory: true }),
    ).toBe(true);
    expect(matchAny(compiled, { relPath: "x.log", isDirectory: false })).toBe(
      true,
    );
  });

  test("否定パターンが後勝ちで上書きする", () => {
    const compiled = compileAll(["*.log", "!keep.log"]);
    expect(
      matchAny(compiled, { relPath: "trash.log", isDirectory: false }),
    ).toBe(true);
    expect(
      matchAny(compiled, { relPath: "keep.log", isDirectory: false }),
    ).toBe(false);
  });

  test("極性は宣言順で決まる (最後にマッチしたパターン)", () => {
    // 順序が逆: 否定が先 → 後の `*.log` が再マッチして除外
    const compiled = compileAll(["!keep.log", "*.log"]);
    expect(
      matchAny(compiled, { relPath: "keep.log", isDirectory: false }),
    ).toBe(true);
  });
});

describe("patternMatch.parseGitignore - Phase 27", () => {
  test("空行 / コメント / 末尾空白を除去する", () => {
    const text = [
      "# top comment",
      "",
      "node_modules   ",
      "  ",
      "*.log",
      "# trailing comment",
      "/build",
    ].join("\n");
    const lines = parseGitignore(text);
    expect(lines).toEqual(["node_modules", "*.log", "/build"]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. WorkspaceIsolator: glob 除外
// ────────────────────────────────────────────────────────────────────────────

describe("WorkspaceIsolator excludePatterns glob - Phase 27", () => {
  let tempDir: string;
  let origin: string;

  beforeEach(() => {
    tempDir = mkdtempSync(pathJoin(tmpdir(), "phase27-iso-"));
    origin = pathJoin(tempDir, "origin");
    mkdirSync(origin, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("`*.log` で全ての .log ファイルが除外される", async () => {
    writeFileSync(pathJoin(origin, "keep.txt"), "ok");
    writeFileSync(pathJoin(origin, "drop.log"), "x");
    mkdirSync(pathJoin(origin, "src"));
    writeFileSync(pathJoin(origin, "src", "deep.log"), "y");

    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "task-glob",
      config: {
        strategy: "copy",
        excludePatterns: ["*.log"],
        respectGitignore: false,
      },
    });
    try {
      expect(existsSync(pathJoin(ws.path, "keep.txt"))).toBe(true);
      expect(existsSync(pathJoin(ws.path, "drop.log"))).toBe(false);
      expect(existsSync(pathJoin(ws.path, "src", "deep.log"))).toBe(false);
    } finally {
      await ws.cleanup();
    }
  });

  test("`dist/**` で dist 配下が丸ごと除外される", async () => {
    writeFileSync(pathJoin(origin, "main.ts"), "1");
    mkdirSync(pathJoin(origin, "dist"), { recursive: true });
    writeFileSync(pathJoin(origin, "dist", "bundle.js"), "2");
    mkdirSync(pathJoin(origin, "dist", "nested"), { recursive: true });
    writeFileSync(pathJoin(origin, "dist", "nested", "x.map"), "3");

    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "task-subtree",
      config: {
        strategy: "copy",
        excludePatterns: ["dist/**"],
        respectGitignore: false,
      },
    });
    try {
      expect(existsSync(pathJoin(ws.path, "main.ts"))).toBe(true);
      expect(existsSync(pathJoin(ws.path, "dist"))).toBe(false);
    } finally {
      await ws.cleanup();
    }
  });

  test("否定パターンで除外を例外にできる", async () => {
    writeFileSync(pathJoin(origin, "drop.log"), "x");
    writeFileSync(pathJoin(origin, "keep.log"), "y");

    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "task-negation",
      config: {
        strategy: "copy",
        excludePatterns: ["*.log", "!keep.log"],
        respectGitignore: false,
      },
    });
    try {
      expect(existsSync(pathJoin(ws.path, "drop.log"))).toBe(false);
      expect(existsSync(pathJoin(ws.path, "keep.log"))).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. WorkspaceIsolator: .gitignore 連携
// ────────────────────────────────────────────────────────────────────────────

describe("WorkspaceIsolator respectGitignore - Phase 27", () => {
  let tempDir: string;
  let origin: string;

  beforeEach(() => {
    tempDir = mkdtempSync(pathJoin(tmpdir(), "phase27-gi-"));
    origin = pathJoin(tempDir, "origin");
    mkdirSync(origin, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("origin/.gitignore のパターンを自動で取り込む (既定 true)", async () => {
    writeFileSync(
      pathJoin(origin, ".gitignore"),
      ["*.tmp", "secrets/"].join("\n"),
    );
    writeFileSync(pathJoin(origin, "main.ts"), "1");
    writeFileSync(pathJoin(origin, "scratch.tmp"), "2");
    mkdirSync(pathJoin(origin, "secrets"), { recursive: true });
    writeFileSync(pathJoin(origin, "secrets", "key.pem"), "3");

    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "task-gi-on",
      config: { strategy: "copy" },
    });
    try {
      expect(existsSync(pathJoin(ws.path, "main.ts"))).toBe(true);
      // .gitignore 自体は除外対象ではない
      expect(existsSync(pathJoin(ws.path, ".gitignore"))).toBe(true);
      expect(existsSync(pathJoin(ws.path, "scratch.tmp"))).toBe(false);
      expect(existsSync(pathJoin(ws.path, "secrets"))).toBe(false);
    } finally {
      await ws.cleanup();
    }
  });

  test("respectGitignore=false なら .gitignore は無視される", async () => {
    writeFileSync(pathJoin(origin, ".gitignore"), "*.tmp\n");
    writeFileSync(pathJoin(origin, "scratch.tmp"), "1");

    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "task-gi-off",
      config: { strategy: "copy", respectGitignore: false },
    });
    try {
      expect(existsSync(pathJoin(ws.path, "scratch.tmp"))).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });

  test("origin に .gitignore が無くても落ちない", async () => {
    writeFileSync(pathJoin(origin, "main.ts"), "1");
    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "task-no-gi",
      config: { strategy: "copy" },
    });
    try {
      expect(existsSync(pathJoin(ws.path, "main.ts"))).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });
});
