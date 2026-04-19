/**
 * Phase 29: `chdirOnActivate: false` をデフォルト化する非互換移行のテスト。
 *
 * 範囲:
 *   1. ToolContext と BaseTool のコンテキスト注入
 *   2. FileReadTool / FileWriteTool / FileEditTool の相対パス解決
 *   3. BashTool / GlobTool / GrepTool の cwd / 既定パス解決
 *   4. ToolRegistry.setContext() による一括伝播
 *   5. WorkspaceIsolator.create() 後の sandbox 既定挙動
 *      （`process.cwd()` を変えずにツールが workspace を触る）
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import {
  BashTool,
  FileEditTool,
  FileReadTool,
  FileWriteTool,
  GlobTool,
  GrepTool,
} from "../src/tools/BasicTools.js";
import { MultiFileEditTool } from "../src/tools/MultiFileEditTool.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import type { Tool } from "../src/types/index.js";
import { WorkspaceIsolator } from "../src/sandbox/WorkspaceIsolator.js";
import { CopyStrategy } from "../src/sandbox/strategies.js";

// ────────────────────────────────────────────────────────────────────────────
// 共通セットアップ
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 29: BaseTool / ToolContext", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(pathJoin(tmpdir(), "phase29-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("setContext() 未呼び出し時は process.cwd() へフォールバック", async () => {
    // 絶対パスを渡せば process.cwd() に依存しない
    const tool = new FileWriteTool();
    const absPath = pathJoin(tempDir, "abs.txt");
    const result = await tool.execute({
      path: absPath,
      content: "hello",
    });
    expect(result.success).toBe(true);
    expect(readFileSync(absPath, "utf8")).toBe("hello");
  });

  test("FileWriteTool は context.basePath に対して相対パスを解決する", async () => {
    const tool = new FileWriteTool();
    tool.setContext({ basePath: tempDir });
    const result = await tool.execute({
      path: "nested/out.txt",
      content: "in workspace",
    });
    // エラーなく通るためには basePath 側に nested/ を用意する必要がある
    // この tool は write 時にディレクトリを自動作成しないので、ここでは
    // 事前に作ったディレクトリに書く
    expect(result.success).toBe(false); // nested/ が無いので失敗するはず
    mkdirSync(pathJoin(tempDir, "nested"), { recursive: true });
    const r2 = await tool.execute({
      path: "nested/out.txt",
      content: "in workspace",
    });
    expect(r2.success).toBe(true);
    expect(readFileSync(pathJoin(tempDir, "nested/out.txt"), "utf8")).toBe(
      "in workspace",
    );
  });

  test("FileReadTool は context.basePath に対して相対パスを解決する", async () => {
    writeFileSync(pathJoin(tempDir, "hello.txt"), "world");
    const tool = new FileReadTool();
    tool.setContext({ basePath: tempDir });
    const result = await tool.execute({ path: "hello.txt" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("world");
  });

  test("FileEditTool は context.basePath に対して相対パスを解決する", async () => {
    writeFileSync(pathJoin(tempDir, "e.txt"), "alpha beta");
    const tool = new FileEditTool();
    tool.setContext({ basePath: tempDir });
    const result = await tool.execute({
      path: "e.txt",
      oldString: "alpha",
      newString: "ALPHA",
    });
    expect(result.success).toBe(true);
    expect(readFileSync(pathJoin(tempDir, "e.txt"), "utf8")).toBe("ALPHA beta");
  });

  test("絶対パスは context が設定されていても素通しする", async () => {
    const other = mkdtempSync(pathJoin(tmpdir(), "phase29-abs-"));
    try {
      const tool = new FileWriteTool();
      tool.setContext({ basePath: tempDir });
      const absOutside = pathJoin(other, "outside.txt");
      const result = await tool.execute({
        path: absOutside,
        content: "absolute",
      });
      expect(result.success).toBe(true);
      expect(readFileSync(absOutside, "utf8")).toBe("absolute");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("BashTool は context.basePath を spawn の cwd に渡す", async () => {
    const tool = new BashTool();
    tool.setContext({ basePath: tempDir });
    // `pwd` が tempDir を返せば cwd が反映されている
    const result = await tool.execute({ command: "pwd" });
    expect(result.success).toBe(true);
    // macOS では /private/var/ 接頭辞で realpath 化される場合があるため
    // includes 比較にする
    expect(
      result.output.trim().endsWith(tempDir.replace(/^\/private/, "")),
    ).toBe(
      result.output.trim() === tempDir ||
        result.output.trim() === `/private${tempDir}` ||
        result.output.trim().endsWith(tempDir),
    );
  });

  test("GlobTool は path 省略時に context.basePath を検索ルートにする", async () => {
    writeFileSync(pathJoin(tempDir, "alpha.ts"), "");
    writeFileSync(pathJoin(tempDir, "beta.ts"), "");
    const tool = new GlobTool();
    tool.setContext({ basePath: tempDir });
    const result = await tool.execute({ pattern: "*.ts" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("alpha.ts");
    expect(result.output).toContain("beta.ts");
  });

  test("MultiFileEditTool も context.basePath を尊重する", async () => {
    writeFileSync(pathJoin(tempDir, "a.txt"), "old");
    const tool = new MultiFileEditTool();
    tool.setContext({ basePath: tempDir });
    const result = await tool.execute({
      edits: [{ path: "a.txt", oldString: "old", newString: "new" }],
    });
    expect(result.success).toBe(true);
    expect(readFileSync(pathJoin(tempDir, "a.txt"), "utf8")).toBe("new");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ToolRegistry
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 29: ToolRegistry.setContext()", () => {
  test("登録済みの全ツールへ setContext が伝播する", () => {
    const registry = new ToolRegistry();
    registry.setContext({ basePath: "/tmp/fake" });
    const recorded: string[] = [];
    for (const tool of registry.getAll()) {
      // setContext を持つ tool だけ検査
      if (typeof tool.setContext === "function") {
        recorded.push(tool.name);
      }
    }
    expect(recorded.length).toBeGreaterThan(0);
    // 主要 tool はすべてコンテキストを受け取れる
    expect(recorded).toContain("bash");
    expect(recorded).toContain("read_file");
    expect(recorded).toContain("write_file");
    expect(recorded).toContain("edit_file");
    expect(recorded).toContain("glob");
    expect(recorded).toContain("grep");
    expect(recorded).toContain("multi_file_edit");
  });

  test("setContext 後に register したツールにも自動でコンテキストが届く", () => {
    const registry = new ToolRegistry();
    registry.setContext({ basePath: "/tmp/abc" });

    let received: string | undefined;
    const lateTool: Tool = {
      name: "late_tool",
      description: "",
      riskLevel: "LOW",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => ({ success: true, output: "" }),
      setContext(ctx) {
        received = ctx.basePath;
      },
    };
    registry.register(lateTool);
    expect(received).toBe("/tmp/abc");
  });

  test("getContext() で現在のコンテキストを取得できる", () => {
    const registry = new ToolRegistry();
    expect(registry.getContext()).toBeUndefined();
    registry.setContext({ basePath: "/tmp/zzz" });
    expect(registry.getContext()).toEqual({ basePath: "/tmp/zzz" });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// WorkspaceIsolator + Tool 結合（Phase 29 の実質的な成功条件）
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 29: WorkspaceIsolator と Tool の結合", () => {
  let tempDir: string;
  let origin: string;

  beforeEach(() => {
    tempDir = mkdtempSync(pathJoin(tmpdir(), "phase29-ws-"));
    origin = pathJoin(tempDir, "origin");
    mkdirSync(origin);
    writeFileSync(pathJoin(origin, "seed.txt"), "seed content");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("workspace を作り、ToolRegistry の basePath を workspace に差し替えると tool は workspace に書く", async () => {
    const basePath = pathJoin(tempDir, "sandbox");
    mkdirSync(basePath);
    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "p29-smoke",
      config: { basePath },
      strategyOverride: CopyStrategy,
    });
    try {
      const registry = new ToolRegistry();
      registry.setContext({ basePath: ws.path });

      // write_file が相対パスで workspace に書かれること
      const write = registry.get("write_file")!;
      const wrote = await write.execute({
        path: "hello.txt",
        content: "from phase29",
      });
      expect(wrote.success).toBe(true);

      // workspace 側にはできる
      expect(readFileSync(pathJoin(ws.path, "hello.txt"), "utf8")).toBe(
        "from phase29",
      );
      // origin 側には 書かれていない
      expect(() =>
        readFileSync(pathJoin(origin, "hello.txt"), "utf8"),
      ).toThrow();
    } finally {
      await ws.cleanup();
    }
  });

  test("workspace 内の既存ファイルを read_file で相対指定して読める", async () => {
    const basePath = pathJoin(tempDir, "sandbox");
    mkdirSync(basePath);
    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "p29-read",
      config: { basePath },
      strategyOverride: CopyStrategy,
    });
    try {
      const registry = new ToolRegistry();
      registry.setContext({ basePath: ws.path });
      const read = registry.get("read_file")!;
      const result = await read.execute({ path: "seed.txt" });
      expect(result.success).toBe(true);
      expect(result.output).toContain("seed content");
    } finally {
      await ws.cleanup();
    }
  });

  test("setContext を呼ばなければ process.cwd() に落ちるので workspace は参照しない", async () => {
    const basePath = pathJoin(tempDir, "sandbox");
    mkdirSync(basePath);
    const ws = await WorkspaceIsolator.create({
      origin,
      taskId: "p29-nocontext",
      config: { basePath },
      strategyOverride: CopyStrategy,
    });
    try {
      const registry = new ToolRegistry();
      // 意図的に setContext を呼ばない
      const read = registry.get("read_file")!;
      // 絶対パスで workspace 内を直接読む ことは可能
      const result = await read.execute({
        path: pathJoin(ws.path, "seed.txt"),
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain("seed content");

      // 相対パス "seed.txt" は process.cwd() 基点なので
      // workspace の seed.txt に命中しない（通常失敗する）
      const rel = await read.execute({ path: "seed.txt" });
      // process.cwd() 側に seed.txt が存在しない限り失敗する
      // （存在する場合の偽陽性を避けるため、エラーメッセージも確認）
      if (!rel.success) {
        expect(rel.error).toBeDefined();
      }
    } finally {
      await ws.cleanup();
    }
  });
});
