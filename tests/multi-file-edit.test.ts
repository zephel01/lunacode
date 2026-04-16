import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { MultiFileEditTool } from "../src/tools/MultiFileEditTool.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";

describe("Phase 20: MultiFileEditTool", () => {
  let tmpDir: string;
  let tool: MultiFileEditTool;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "multi-edit-test-"));
    tool = new MultiFileEditTool();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── ToolRegistry 統合 ─────────────────────────────

  describe("ToolRegistry 統合", () => {
    it("multi_file_edit が登録されている", () => {
      const registry = new ToolRegistry();
      const t = registry.get("multi_file_edit");
      expect(t).toBeDefined();
      expect(t!.name).toBe("multi_file_edit");
    });

    it("デフォルトツールが13個登録されている", () => {
      const registry = new ToolRegistry();
      expect(registry.getAll().length).toBe(13);
    });
  });

  // ── メタデータ ─────────────────────────────────────

  describe("メタデータ", () => {
    it("name, description, riskLevel が正しい", () => {
      expect(tool.name).toBe("multi_file_edit");
      expect(tool.description).toContain("multiple files");
      expect(tool.riskLevel).toBe("MEDIUM");
    });

    it("edits パラメータが必須", () => {
      expect(tool.parameters.required).toContain("edits");
    });
  });

  // ── 単一ファイル編集 ───────────────────────────────

  describe("単一ファイル編集", () => {
    it("既存ファイルの文字列置換ができる", async () => {
      const filePath = path.join(tmpDir, "hello.txt");
      await fs.writeFile(filePath, "Hello World", "utf-8");

      const result = await tool.execute({
        edits: [{ path: filePath, oldString: "World", newString: "LunaCode" }],
      });

      expect(result.success).toBe(true);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("Hello LunaCode");
    });

    it("新規ファイルを作成できる", async () => {
      const filePath = path.join(tmpDir, "new-file.ts");

      const result = await tool.execute({
        edits: [{ path: filePath, newString: "export const x = 42;\n" }],
      });

      expect(result.success).toBe(true);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("export const x = 42;\n");
    });

    it("ネストしたディレクトリにファイルを作成できる", async () => {
      const filePath = path.join(tmpDir, "src", "utils", "helper.ts");

      const result = await tool.execute({
        edits: [{ path: filePath, newString: "export function help() {}\n" }],
      });

      expect(result.success).toBe(true);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("export function help() {}\n");
    });
  });

  // ── マルチファイル編集 ─────────────────────────────

  describe("マルチファイル編集", () => {
    it("複数ファイルを同時に編集できる", async () => {
      const file1 = path.join(tmpDir, "a.ts");
      const file2 = path.join(tmpDir, "b.ts");
      await fs.writeFile(file1, 'import { foo } from "./old";\n', "utf-8");
      await fs.writeFile(file2, 'import { foo } from "./old";\n', "utf-8");

      const result = await tool.execute({
        edits: [
          { path: file1, oldString: '"./old"', newString: '"./new"' },
          { path: file2, oldString: '"./old"', newString: '"./new"' },
        ],
      });

      expect(result.success).toBe(true);
      expect(await fs.readFile(file1, "utf-8")).toContain('"./new"');
      expect(await fs.readFile(file2, "utf-8")).toContain('"./new"');
    });

    it("同一ファイルへの複数編集を順序通り適用できる", async () => {
      const filePath = path.join(tmpDir, "multi.ts");
      await fs.writeFile(filePath, "const a = 1;\nconst b = 2;\n", "utf-8");

      const result = await tool.execute({
        edits: [
          { path: filePath, oldString: "const a = 1;", newString: "const a = 10;" },
          { path: filePath, oldString: "const b = 2;", newString: "const b = 20;" },
        ],
      });

      expect(result.success).toBe(true);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("const a = 10;\nconst b = 20;\n");
    });

    it("新規作成と編集を混在できる", async () => {
      const existing = path.join(tmpDir, "existing.ts");
      const newFile = path.join(tmpDir, "brand-new.ts");
      await fs.writeFile(existing, "const x = 1;\n", "utf-8");

      const result = await tool.execute({
        edits: [
          { path: existing, oldString: "const x = 1;", newString: "const x = 42;" },
          { path: newFile, newString: "export const y = 100;\n" },
        ],
      });

      expect(result.success).toBe(true);
      expect(await fs.readFile(existing, "utf-8")).toBe("const x = 42;\n");
      expect(await fs.readFile(newFile, "utf-8")).toBe("export const y = 100;\n");
    });
  });

  // ── ロールバック ───────────────────────────────────

  describe("ロールバック", () => {
    it("oldString が見つからない場合は全ファイルが変更されない", async () => {
      const file1 = path.join(tmpDir, "ok.ts");
      const file2 = path.join(tmpDir, "fail.ts");
      await fs.writeFile(file1, "original1", "utf-8");
      await fs.writeFile(file2, "original2", "utf-8");

      const result = await tool.execute({
        edits: [
          { path: file1, oldString: "original1", newString: "changed1" },
          { path: file2, oldString: "NOT_FOUND", newString: "changed2" },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("oldString not found");
      // file1 は編集されていないはず（検証フェーズで失敗するため書き込み前）
      expect(await fs.readFile(file1, "utf-8")).toBe("original1");
      expect(await fs.readFile(file2, "utf-8")).toBe("original2");
    });

    it("存在しないファイルに oldString を指定するとエラー", async () => {
      const result = await tool.execute({
        edits: [
          {
            path: path.join(tmpDir, "nonexistent.ts"),
            oldString: "foo",
            newString: "bar",
          },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("File not found");
    });
  });

  // ── dry_run モード ─────────────────────────────────

  describe("dry_run モード", () => {
    it("dry_run=true では変更を適用しない", async () => {
      const filePath = path.join(tmpDir, "dry.txt");
      await fs.writeFile(filePath, "original content", "utf-8");

      const result = await tool.execute({
        edits: [
          { path: filePath, oldString: "original", newString: "modified" },
        ],
        dry_run: true,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("DRY RUN");
      // ファイルは変更されていない
      expect(await fs.readFile(filePath, "utf-8")).toBe("original content");
    });

    it("dry_run でバリデーションエラーを検出できる", async () => {
      const filePath = path.join(tmpDir, "dry-fail.txt");
      await fs.writeFile(filePath, "hello", "utf-8");

      const result = await tool.execute({
        edits: [
          { path: filePath, oldString: "MISSING", newString: "world" },
        ],
        dry_run: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("oldString not found");
    });

    it("dry_run で description が出力に含まれる", async () => {
      const filePath = path.join(tmpDir, "desc.txt");
      await fs.writeFile(filePath, "test", "utf-8");

      const result = await tool.execute({
        edits: [{ path: filePath, oldString: "test", newString: "done" }],
        dry_run: true,
        description: "Fix import paths",
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("Fix import paths");
    });
  });

  // ── description ────────────────────────────────────

  describe("description", () => {
    it("description が出力に含まれる", async () => {
      const filePath = path.join(tmpDir, "desc.txt");
      await fs.writeFile(filePath, "old", "utf-8");

      const result = await tool.execute({
        edits: [{ path: filePath, oldString: "old", newString: "new" }],
        description: "Rename variable across files",
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("Rename variable across files");
    });
  });

  // ── バリデーション ─────────────────────────────────

  describe("バリデーション", () => {
    it("空配列を拒否する", async () => {
      const result = await tool.execute({ edits: [] });
      expect(result.success).toBe(false);
      expect(result.error).toContain("non-empty array");
    });

    it("50件を超える編集を拒否する", async () => {
      const edits = Array.from({ length: 51 }, (_, i) => ({
        path: path.join(tmpDir, `file${i}.ts`),
        newString: "content",
      }));
      const result = await tool.execute({ edits });
      expect(result.success).toBe(false);
      expect(result.error).toContain("maximum 50");
    });

    it("path が未指定の編集を拒否する", async () => {
      const result = await tool.execute({
        edits: [{ path: "", newString: "content" }],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("path is required");
    });

    it("newString が未指定の編集を拒否する", async () => {
      const result = await tool.execute({
        edits: [{ path: path.join(tmpDir, "test.ts") }],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("newString is required");
    });

    it("null byte を含むパスを拒否する", async () => {
      const result = await tool.execute({
        edits: [{ path: "/tmp/evil\0file.ts", newString: "x" }],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("null byte");
    });

    it("edits パラメータ未指定を拒否する", async () => {
      const result = await tool.execute({});
      expect(result.success).toBe(false);
    });
  });

  // ── 出力フォーマット ───────────────────────────────

  describe("出力フォーマット", () => {
    it("編集数とファイル数を報告する", async () => {
      const file1 = path.join(tmpDir, "x.ts");
      const file2 = path.join(tmpDir, "y.ts");
      await fs.writeFile(file1, "aaa", "utf-8");
      await fs.writeFile(file2, "bbb", "utf-8");

      const result = await tool.execute({
        edits: [
          { path: file1, oldString: "aaa", newString: "AAA" },
          { path: file2, oldString: "bbb", newString: "BBB" },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("2 edit(s)");
      expect(result.output).toContain("2 file(s)");
    });

    it("各編集の詳細を報告する", async () => {
      const filePath = path.join(tmpDir, "detail.ts");
      await fs.writeFile(filePath, "hello", "utf-8");

      const result = await tool.execute({
        edits: [{ path: filePath, oldString: "hello", newString: "world" }],
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("[0]");
      expect(result.output).toContain("replaced");
    });
  });
});
