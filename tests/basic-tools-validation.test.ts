/**
 * FileWriteTool / FileEditTool / MultiFileEditTool の post-write 構文検証統合テスト。
 *
 * 設計方針（AskUserQuestion で確定済み）:
 *  - 警告だけ出してツール自体は success を維持
 *  - JSON / YAML は外部コマンド不要なのでここで確実に挙動確認
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import { FileWriteTool, FileEditTool } from "../src/tools/BasicTools.js";
import { MultiFileEditTool } from "../src/tools/MultiFileEditTool.js";
import { resetValidationConfigForTests } from "../src/tools/SyntaxValidator.js";

describe("FileWriteTool + SyntaxValidator", () => {
  let tempDir: string;

  beforeEach(() => {
    resetValidationConfigForTests();
    tempDir = mkdtempSync(pathJoin(tmpdir(), "basic-tools-val-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("正しい JSON を書くと警告なし", async () => {
    const tool = new FileWriteTool();
    const filePath = pathJoin(tempDir, "ok.json");
    const result = await tool.execute({
      path: filePath,
      content: '{"a": 1}',
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Successfully wrote");
    expect(result.output).not.toContain("Syntax check failed");
  });

  test("壊れた JSON を書いても success=true だが警告が付く", async () => {
    const tool = new FileWriteTool();
    const filePath = pathJoin(tempDir, "bad.json");
    const result = await tool.execute({
      path: filePath,
      content: "{bad json,,}",
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Successfully wrote");
    expect(result.output).toContain("Syntax check failed");
    expect(result.output).toContain("JSON.parse");
    // ファイルは保存されている
    expect(readFileSync(filePath, "utf-8")).toBe("{bad json,,}");
  });

  test("壊れた YAML でも success=true + 警告", async () => {
    const tool = new FileWriteTool();
    const filePath = pathJoin(tempDir, "bad.yml");
    const result = await tool.execute({
      path: filePath,
      content: "foo: [1, 2\nbar: baz\n",
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Syntax check failed");
    expect(result.output).toContain("js-yaml");
  });

  test("未対応拡張子では警告なし", async () => {
    const tool = new FileWriteTool();
    const filePath = pathJoin(tempDir, "README.md");
    const result = await tool.execute({
      path: filePath,
      content: "# Hello",
    });
    expect(result.success).toBe(true);
    expect(result.output).not.toContain("Syntax check failed");
  });

  test("append モードでも全体内容を検証", async () => {
    const filePath = pathJoin(tempDir, "partial.json");
    // 先に有効な JSON の先頭だけ書いておく
    writeFileSync(filePath, '{"a":');
    const tool = new FileWriteTool();
    // 続きを追記して完成させる
    const result = await tool.execute({
      path: filePath,
      content: " 1}",
      append: true,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Successfully appended");
    expect(result.output).not.toContain("Syntax check failed");
    expect(readFileSync(filePath, "utf-8")).toBe('{"a": 1}');
  });
});

describe("FileEditTool + SyntaxValidator", () => {
  let tempDir: string;

  beforeEach(() => {
    resetValidationConfigForTests();
    tempDir = mkdtempSync(pathJoin(tmpdir(), "basic-tools-val-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("正しい JSON の編集後は警告なし", async () => {
    const filePath = pathJoin(tempDir, "x.json");
    writeFileSync(filePath, '{"a": 1}');
    const tool = new FileEditTool();
    const result = await tool.execute({
      path: filePath,
      oldString: '"a": 1',
      newString: '"a": 2',
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Successfully edited");
    expect(result.output).not.toContain("Syntax check failed");
  });

  test("編集で JSON を壊した場合は警告", async () => {
    const filePath = pathJoin(tempDir, "x.json");
    writeFileSync(filePath, '{"a": 1}');
    const tool = new FileEditTool();
    const result = await tool.execute({
      path: filePath,
      oldString: '{"a": 1}',
      newString: "{bad,,}",
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Syntax check failed");
  });
});

describe("MultiFileEditTool + SyntaxValidator", () => {
  let tempDir: string;

  beforeEach(() => {
    resetValidationConfigForTests();
    tempDir = mkdtempSync(pathJoin(tmpdir(), "basic-tools-val-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("壊れた JSON を含む編集は success=true だが警告行が含まれる", async () => {
    const goodPath = pathJoin(tempDir, "good.json");
    const badPath = pathJoin(tempDir, "bad.json");
    const tool = new MultiFileEditTool();
    const result = await tool.execute({
      edits: [
        { path: goodPath, newString: '{"ok": true}' },
        { path: badPath, newString: "{not json,,}" },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("edit(s) applied");
    expect(result.output).toContain("bad.json");
    expect(result.output).toContain("Syntax check failed");
  });

  test("全ファイルが正しければ警告なし", async () => {
    const tool = new MultiFileEditTool();
    const result = await tool.execute({
      edits: [
        { path: pathJoin(tempDir, "a.json"), newString: "{}" },
        { path: pathJoin(tempDir, "b.yml"), newString: "key: value\n" },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.output).not.toContain("Syntax check failed");
  });

  test("dry_run では書き込まず警告も出さない", async () => {
    const tool = new MultiFileEditTool();
    const result = await tool.execute({
      edits: [{ path: pathJoin(tempDir, "x.json"), newString: "{bad,,}" }],
      dry_run: true,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("DRY RUN");
    expect(result.output).not.toContain("Syntax check failed");
  });
});
