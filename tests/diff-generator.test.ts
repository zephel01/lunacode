import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { DiffGenerator } from "../src/agents/DiffGenerator.js";
import * as fs from "fs/promises";
import * as path from "path";

const TEST_DIR = "/tmp/lunacode-test-diff";

describe("DiffGenerator", () => {
  beforeAll(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  test("should generate unified diff with additions", () => {
    const oldContent = "line1\nline2\nline3\n";
    const newContent = "line1\nline2\nline2.5\nline3\n";

    const diff = DiffGenerator.generateUnifiedDiff(oldContent, newContent, "test.txt");

    expect(diff).toContain("--- a/test.txt");
    expect(diff).toContain("+++ b/test.txt");
    expect(diff).toContain("+line2.5");
  });

  test("should generate unified diff with deletions", () => {
    const oldContent = "line1\nline2\nline3\n";
    const newContent = "line1\nline3\n";

    const diff = DiffGenerator.generateUnifiedDiff(oldContent, newContent, "test.txt");

    expect(diff).toContain("--- a/test.txt");
    expect(diff).toContain("+++ b/test.txt");
    expect(diff).toContain("-line2");
  });

  test("should generate unified diff with modifications", () => {
    const oldContent = "function old() {\n  return 42;\n}\n";
    const newContent = "function new() {\n  return 100;\n}\n";

    const diff = DiffGenerator.generateUnifiedDiff(
      oldContent,
      newContent,
      "functions.ts",
    );

    expect(diff).toContain("--- a/functions.ts");
    expect(diff).toContain("+++ b/functions.ts");
    expect(diff).toContain("-function old()");
    expect(diff).toContain("+function new()");
    expect(diff).toContain("-  return 42;");
    expect(diff).toContain("+  return 100;");
  });

  test("should handle new file (all additions)", async () => {
    const filePath = path.join(TEST_DIR, "newfile.txt");
    const content = "new line 1\nnew line 2\n";

    const diff = await DiffGenerator.generateWriteDiff(filePath, content);

    expect(diff).toContain("--- /dev/null");
    expect(diff).toContain("+++ b/");
    expect(diff).toContain("+new line 1");
    expect(diff).toContain("+new line 2");
  });

  test("should handle empty to content transition", () => {
    const oldContent = "";
    const newContent = "new content\n";

    const diff = DiffGenerator.generateUnifiedDiff(oldContent, newContent, "empty.txt");

    expect(diff).toContain("+new content");
  });

  test("should handle content to empty transition", () => {
    const oldContent = "old content\n";
    const newContent = "";

    const diff = DiffGenerator.generateUnifiedDiff(oldContent, newContent, "content.txt");

    expect(diff).toContain("-old content");
  });

  test("should generate edit diff showing replacement in context", () => {
    const fileContent = "line 1\nline 2\nold text\nline 4\nline 5\n";
    const oldString = "old text";
    const newString = "new text";

    const diff = DiffGenerator.generateEditDiff(
      "test.txt",
      oldString,
      newString,
      fileContent,
    );

    expect(diff).toContain("-old text");
    expect(diff).toContain("+new text");
    expect(diff).toContain(" line 1");
    expect(diff).toContain(" line 2");
    expect(diff).toContain(" line 4");
  });

  test("should colorize diff with ANSI codes", () => {
    const diff = "--- a/test.txt\n+++ b/test.txt\n@@ -1,3 +1,4 @@\n line1\n-line2\n+line2.5\n line3\n";

    const colorized = DiffGenerator.colorize(diff);

    // Check for ANSI escape codes
    expect(colorized).toContain("\x1b[");
    expect(colorized).toContain("\x1b[36m"); // Cyan for headers
    expect(colorized).toContain("\x1b[31m"); // Red for -
    expect(colorized).toContain("\x1b[32m"); // Green for +
  });

  test("should return empty string when no changes", () => {
    const content = "same content\n";

    const diff = DiffGenerator.generateUnifiedDiff(content, content, "same.txt");

    expect(diff).toBe("");
  });

  test("should handle multiline changes with context", () => {
    const oldContent =
      "context 1\ncontext 2\nold line 1\nold line 2\ncontext 3\ncontext 4\n";
    const newContent =
      "context 1\ncontext 2\nnew line 1\nnew line 2\ncontext 3\ncontext 4\n";

    const diff = DiffGenerator.generateUnifiedDiff(
      oldContent,
      newContent,
      "multiline.txt",
    );

    expect(diff).toContain(" context 1");
    expect(diff).toContain(" context 2");
    expect(diff).toContain("-old line 1");
    expect(diff).toContain("-old line 2");
    expect(diff).toContain("+new line 1");
    expect(diff).toContain("+new line 2");
    expect(diff).toContain(" context 3");
    expect(diff).toContain(" context 4");
  });

  test("should handle existing file write diff", async () => {
    const filePath = path.join(TEST_DIR, "existing.txt");
    const oldContent = "old line 1\nold line 2\n";
    const newContent = "new line 1\nold line 2\n";

    await fs.writeFile(filePath, oldContent);

    const diff = await DiffGenerator.generateWriteDiff(filePath, newContent);

    expect(diff).toContain("--- a/");
    expect(diff).toContain("+++ b/");
    expect(diff).toContain("-old line 1");
    expect(diff).toContain("+new line 1");
  });

  test("should handle large diffs", () => {
    let oldContent = "";
    let newContent = "";

    for (let i = 0; i < 100; i++) {
      oldContent += `old line ${i}\n`;
      newContent += `new line ${i}\n`;
    }

    const diff = DiffGenerator.generateUnifiedDiff(
      oldContent,
      newContent,
      "large.txt",
    );

    expect(diff.length).toBeGreaterThan(0);
    expect(diff).toContain("-old line");
    expect(diff).toContain("+new line");
  });

  test("should handle special characters in content", () => {
    const oldContent = 'old: "string with <special> & characters"\n';
    const newContent = 'new: "string with <special> & characters"\n';

    const diff = DiffGenerator.generateUnifiedDiff(
      oldContent,
      newContent,
      "special.txt",
    );

    expect(diff).toContain("<special>");
    expect(diff).toContain("&");
  });

  test("should handle empty strings in edit diff", () => {
    const fileContent = "line 1\nold text\nline 3\n";
    const diff = DiffGenerator.generateEditDiff(
      "test.txt",
      "old text",
      "",
      fileContent,
    );

    expect(diff).toContain("-old text");
  });

  test("should handle multiline string replacement in edit diff", () => {
    const fileContent = "context\nline 1\nline 2\nline 3\ncontext\n";
    const oldString = "line 1\nline 2";
    const newString = "replacement line 1\nreplacement line 2\nreplacement line 3";

    const diff = DiffGenerator.generateEditDiff(
      "test.txt",
      oldString,
      newString,
      fileContent,
    );

    expect(diff.length).toBeGreaterThan(0);
  });
});
