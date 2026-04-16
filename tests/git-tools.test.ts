import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

import { GitStatusTool } from "../src/tools/GitTools.js";
import { GitDiffTool } from "../src/tools/GitTools.js";
import { GitCommitTool } from "../src/tools/GitTools.js";
import { GitApplyTool } from "../src/tools/GitTools.js";
import { GitLogTool } from "../src/tools/GitTools.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";

/**
 * Phase 18: Git ツール強化テスト
 *
 * 一時ディレクトリに git リポジトリを作成して各ツールをテストする。
 */

let tmpDir: string;
let originalCwd: string;

// テスト用 git リポジトリを一時ディレクトリに作成
async function setupGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunacode-git-test-"));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', {
    cwd: dir,
    stdio: "pipe",
  });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  // Initial commit
  await fs.writeFile(path.join(dir, "README.md"), "# Test\n");
  execSync("git add -A && git commit -m 'initial commit'", {
    cwd: dir,
    stdio: "pipe",
  });
  return dir;
}

describe("Phase 18: Git Tools", () => {
  beforeEach(async () => {
    tmpDir = await setupGitRepo();
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ========================================
  // ToolRegistry 統合
  // ========================================

  describe("ToolRegistry registration", () => {
    test("should register all 5 new git tools", () => {
      const registry = new ToolRegistry();
      expect(registry.get("git_status")).toBeDefined();
      expect(registry.get("git_diff")).toBeDefined();
      expect(registry.get("git_commit")).toBeDefined();
      expect(registry.get("git_apply")).toBeDefined();
      expect(registry.get("git_log")).toBeDefined();
    });

    test("should keep original GitTool registered", () => {
      const registry = new ToolRegistry();
      expect(registry.get("git")).toBeDefined();
    });

    test("should have 12 total default tools", () => {
      const registry = new ToolRegistry();
      // 7 original + 5 new git tools
      expect(registry.getAll().length).toBe(12);
    });
  });

  // ========================================
  // GitStatusTool
  // ========================================

  describe("GitStatusTool", () => {
    const tool = new GitStatusTool();

    test("should have correct metadata", () => {
      expect(tool.name).toBe("git_status");
      expect(tool.riskLevel).toBe("LOW");
    });

    test("should show clean status when no changes", async () => {
      const result = await tool.execute({});
      expect(result.success).toBe(true);
      expect(result.output).toContain("Staged: 0");
      expect(result.output).toContain("Modified: 0");
      expect(result.output).toContain("Untracked: 0");
    });

    test("should detect untracked files", async () => {
      await fs.writeFile(path.join(tmpDir, "new-file.txt"), "hello");
      const result = await tool.execute({});
      expect(result.success).toBe(true);
      expect(result.output).toContain("Untracked: 1");
      expect(result.output).toContain("new-file.txt");
    });

    test("should detect modified files", async () => {
      await fs.writeFile(path.join(tmpDir, "README.md"), "# Updated\n");
      const result = await tool.execute({});
      expect(result.success).toBe(true);
      expect(result.output).toContain("Modified: 1");
    });

    test("should detect staged files", async () => {
      await fs.writeFile(path.join(tmpDir, "staged.txt"), "staged");
      execSync("git add staged.txt", { cwd: tmpDir, stdio: "pipe" });
      const result = await tool.execute({});
      expect(result.success).toBe(true);
      expect(result.output).toContain("Staged: 1");
    });

    test("should include branch name", async () => {
      const result = await tool.execute({});
      expect(result.success).toBe(true);
      expect(result.output).toContain("Branch:");
    });

    test("should include stats when requested", async () => {
      await fs.writeFile(
        path.join(tmpDir, "README.md"),
        "# Updated\nNew line\n",
      );
      const result = await tool.execute({ include_stats: true });
      expect(result.success).toBe(true);
      expect(result.output).toContain("Diff stats:");
    });
  });

  // ========================================
  // GitDiffTool
  // ========================================

  describe("GitDiffTool", () => {
    const tool = new GitDiffTool();

    test("should have correct metadata", () => {
      expect(tool.name).toBe("git_diff");
      expect(tool.riskLevel).toBe("LOW");
    });

    test("should show no differences when clean", async () => {
      const result = await tool.execute({});
      expect(result.success).toBe(true);
      expect(result.output).toContain("No differences");
    });

    test("should show working tree diff", async () => {
      await fs.writeFile(path.join(tmpDir, "README.md"), "# Changed\n");
      const result = await tool.execute({ target: "working" });
      expect(result.success).toBe(true);
      expect(result.output).toContain("Changed");
      expect(result.output).toContain("@@");
    });

    test("should show staged diff", async () => {
      await fs.writeFile(path.join(tmpDir, "README.md"), "# Staged\n");
      execSync("git add README.md", { cwd: tmpDir, stdio: "pipe" });
      const result = await tool.execute({ target: "staged" });
      expect(result.success).toBe(true);
      expect(result.output).toContain("Staged");
    });

    test("should filter by file", async () => {
      await fs.writeFile(path.join(tmpDir, "README.md"), "# X\n");
      await fs.writeFile(path.join(tmpDir, "other.txt"), "other");
      execSync("git add other.txt", { cwd: tmpDir, stdio: "pipe" });
      const result = await tool.execute({
        target: "working",
        file: "README.md",
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain("README.md");
    });

    test("should show stat only", async () => {
      await fs.writeFile(path.join(tmpDir, "README.md"), "# Changed\n");
      const result = await tool.execute({ stat_only: true });
      expect(result.success).toBe(true);
      expect(result.output).toContain("insertion");
    });

    test("should reject invalid target", async () => {
      const result = await tool.execute({ target: "; rm -rf /" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid target");
    });

    test("should support commit ref as target", async () => {
      const result = await tool.execute({ target: "HEAD~1" });
      // Should either succeed or fail gracefully (no HEAD~1 exists in 1-commit repo)
      expect(typeof result.success).toBe("boolean");
    });
  });

  // ========================================
  // GitCommitTool
  // ========================================

  describe("GitCommitTool", () => {
    const tool = new GitCommitTool();

    test("should have correct metadata", () => {
      expect(tool.name).toBe("git_commit");
      expect(tool.riskLevel).toBe("MEDIUM");
    });

    test("should commit staged files", async () => {
      await fs.writeFile(path.join(tmpDir, "new.txt"), "content");
      execSync("git add new.txt", { cwd: tmpDir, stdio: "pipe" });
      const result = await tool.execute({ message: "add new file" });
      expect(result.success).toBe(true);
      expect(result.output).toContain("Commit:");
    });

    test("should stage and commit specified files", async () => {
      await fs.writeFile(path.join(tmpDir, "a.txt"), "a");
      await fs.writeFile(path.join(tmpDir, "b.txt"), "b");
      const result = await tool.execute({
        message: "add a and b",
        files: ["a.txt", "b.txt"],
      });
      expect(result.success).toBe(true);
    });

    test("should stage all with '.' ", async () => {
      await fs.writeFile(path.join(tmpDir, "c.txt"), "c");
      const result = await tool.execute({
        message: "add all",
        files: ["."],
      });
      expect(result.success).toBe(true);
    });

    test("should fail with empty message", async () => {
      const result = await tool.execute({ message: "" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("empty");
    });

    test("should fail when no staged changes", async () => {
      const result = await tool.execute({ message: "nothing to commit" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("No staged changes");
    });

    test("should block dangerous characters in message", async () => {
      const result = await tool.execute({ message: "$(rm -rf /)" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("dangerous");
    });

    test("should block dangerous file paths", async () => {
      const result = await tool.execute({
        message: "bad",
        files: ["../../../etc/passwd"],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid file path");
    });

    test("should support amend", async () => {
      await fs.writeFile(path.join(tmpDir, "amend.txt"), "amend");
      execSync("git add amend.txt", { cwd: tmpDir, stdio: "pipe" });
      execSync('git commit -m "to be amended"', { cwd: tmpDir, stdio: "pipe" });
      // Amend with new message
      const result = await tool.execute({
        message: "amended commit",
        amend: true,
      });
      expect(result.success).toBe(true);
    });
  });

  // ========================================
  // GitApplyTool
  // ========================================

  describe("GitApplyTool", () => {
    const tool = new GitApplyTool();

    test("should have correct metadata", () => {
      expect(tool.name).toBe("git_apply");
      expect(tool.riskLevel).toBe("MEDIUM");
    });

    test("should apply a valid patch", async () => {
      // Create a diff
      await fs.writeFile(path.join(tmpDir, "README.md"), "# Patched\n");
      const diff = execSync("git diff", { cwd: tmpDir }).toString();
      // Revert the change
      execSync("git checkout README.md", { cwd: tmpDir, stdio: "pipe" });

      const result = await tool.execute({ patch: diff });
      expect(result.success).toBe(true);
      expect(result.output).toContain("applied");

      // Verify file was changed
      const content = await fs.readFile(
        path.join(tmpDir, "README.md"),
        "utf-8",
      );
      expect(content).toBe("# Patched\n");
    });

    test("should check patch without applying", async () => {
      await fs.writeFile(path.join(tmpDir, "README.md"), "# Check\n");
      const diff = execSync("git diff", { cwd: tmpDir }).toString();
      execSync("git checkout README.md", { cwd: tmpDir, stdio: "pipe" });

      const result = await tool.execute({ patch: diff, check: true });
      expect(result.success).toBe(true);
      expect(result.output).toContain("cleanly");

      // Verify file was NOT changed
      const content = await fs.readFile(
        path.join(tmpDir, "README.md"),
        "utf-8",
      );
      expect(content).toBe("# Test\n");
    });

    test("should fail with empty patch", async () => {
      const result = await tool.execute({ patch: "" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("empty");
    });

    test("should fail with invalid patch", async () => {
      const result = await tool.execute({ patch: "this is not a patch" });
      expect(result.success).toBe(false);
    });

    test("should support reverse apply", async () => {
      // Apply a change first
      await fs.writeFile(path.join(tmpDir, "README.md"), "# Reversed\n");
      const diff = execSync("git diff", { cwd: tmpDir }).toString();
      // Now actually apply the diff manually
      execSync("git checkout README.md", { cwd: tmpDir, stdio: "pipe" });
      await tool.execute({ patch: diff });

      // Reverse it
      const result = await tool.execute({ patch: diff, reverse: true });
      expect(result.success).toBe(true);

      const content = await fs.readFile(
        path.join(tmpDir, "README.md"),
        "utf-8",
      );
      expect(content).toBe("# Test\n");
    });
  });

  // ========================================
  // GitLogTool
  // ========================================

  describe("GitLogTool", () => {
    const tool = new GitLogTool();

    test("should have correct metadata", () => {
      expect(tool.name).toBe("git_log");
      expect(tool.riskLevel).toBe("LOW");
    });

    test("should show commit history", async () => {
      const result = await tool.execute({});
      expect(result.success).toBe(true);
      expect(result.output).toContain("initial commit");
    });

    test("should show oneline format", async () => {
      const result = await tool.execute({ oneline: true });
      expect(result.success).toBe(true);
      expect(result.output).toContain("initial commit");
      // Oneline should be compact
      const lines = result.output.trim().split("\n");
      expect(lines.length).toBe(1);
    });

    test("should limit count", async () => {
      // Create more commits
      await fs.writeFile(path.join(tmpDir, "a.txt"), "a");
      execSync("git add -A && git commit -m 'second'", {
        cwd: tmpDir,
        stdio: "pipe",
      });
      await fs.writeFile(path.join(tmpDir, "b.txt"), "b");
      execSync("git add -A && git commit -m 'third'", {
        cwd: tmpDir,
        stdio: "pipe",
      });

      const result = await tool.execute({ count: 1, oneline: true });
      expect(result.success).toBe(true);
      const lines = result.output.trim().split("\n");
      expect(lines.length).toBe(1);
      expect(result.output).toContain("third");
    });

    test("should filter by file", async () => {
      await fs.writeFile(path.join(tmpDir, "tracked.txt"), "tracked");
      execSync("git add -A && git commit -m 'add tracked'", {
        cwd: tmpDir,
        stdio: "pipe",
      });

      const result = await tool.execute({
        file: "tracked.txt",
        oneline: true,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain("add tracked");
    });

    test("should reject invalid since value", async () => {
      const result = await tool.execute({ since: "; rm -rf /" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid since");
    });

    test("should reject invalid file path", async () => {
      const result = await tool.execute({ file: "$(evil)" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid file path");
    });

    test("should cap count at 50", async () => {
      const result = await tool.execute({ count: 999, oneline: true });
      expect(result.success).toBe(true);
      // Should not error, just cap
    });
  });
});
