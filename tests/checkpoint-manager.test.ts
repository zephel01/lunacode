import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CheckpointManager, Checkpoint } from "../src/agents/CheckpointManager.js";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

let tempDir: string;

/**
 * Initialize a temporary directory with git repo for testing
 */
function initGitRepo(dir: string): void {
  // Initialize git repo
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@example.com"', {
    cwd: dir,
    stdio: "pipe",
  });
  execSync('git config user.name "Test User"', {
    cwd: dir,
    stdio: "pipe",
  });

  // Create initial commit
  const readmePath = path.join(dir, "README.md");
  fs.writeFileSync(readmePath, "# Test Project\n");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "Initial commit"', {
    cwd: dir,
    stdio: "pipe",
  });
}

/**
 * Create a test file and write content
 */
function createTestFile(dir: string, filename: string, content: string): void {
  const filePath = path.join(dir, filename);
  const fileDir = path.dirname(filePath);
  if (!fs.existsSync(fileDir)) {
    fs.mkdirSync(fileDir, { recursive: true });
  }
  fs.writeFileSync(filePath, content);
}

describe("CheckpointManager", () => {
  beforeEach(() => {
    // Create temporary directory for testing
    tempDir = fs.mkdtempSync(path.join("/tmp", "lunacode-checkpoint-"));
    initGitRepo(tempDir);
  });

  afterEach(() => {
    // Clean up temporary directory
    try {
      execSync("rm -rf " + tempDir, { stdio: "pipe" });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  test("constructor with default config", () => {
    const manager = new CheckpointManager(tempDir);
    expect(manager).toBeDefined();
    const stats = manager.getStats();
    expect(stats.total).toBe(0);
  });

  test("constructor with custom config", () => {
    const manager = new CheckpointManager(tempDir, {
      enabled: true,
      strategy: "stash",
      maxCheckpoints: 10,
      autoCheckpoint: false,
    });
    expect(manager).toBeDefined();
  });

  test("initialize creates .git if needed", async () => {
    // Create a new directory without git
    const noGitDir = fs.mkdtempSync(
      path.join("/tmp", "lunacode-no-git-")
    );

    try {
      const manager = new CheckpointManager(noGitDir);
      await manager.initialize();

      // Verify .git was created
      const gitPath = path.join(noGitDir, ".git");
      expect(fs.existsSync(gitPath)).toBe(true);
    } finally {
      try {
        execSync("rm -rf " + noGitDir, { stdio: "pipe" });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  test("initialize works with existing git repo", async () => {
    const manager = new CheckpointManager(tempDir);
    await manager.initialize();
    expect(manager).toBeDefined();
  });

  test("create checkpoint with file changes", async () => {
    const manager = new CheckpointManager(tempDir);
    await manager.initialize();

    // Create a test file
    createTestFile(tempDir, "test.txt", "Hello World");

    // Create checkpoint
    const checkpoint = await manager.create("Initial checkpoint");

    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.id).toMatch(/^cp-1-\d+$/);
    expect(checkpoint?.description).toBe("Initial checkpoint");
    expect(checkpoint?.commitHash).toBeDefined();
    expect(checkpoint?.filesChanged.length).toBeGreaterThan(0);
  });

  test("create skips when no changes", async () => {
    const manager = new CheckpointManager(tempDir);
    await manager.initialize();

    // Try to create checkpoint without changes
    const checkpoint = await manager.create("No changes");

    expect(checkpoint).toBeNull();
  });

  test("list returns created checkpoints", async () => {
    const manager = new CheckpointManager(tempDir);
    await manager.initialize();

    // Create multiple checkpoints
    createTestFile(tempDir, "file1.txt", "Content 1");
    await manager.create("First checkpoint");

    createTestFile(tempDir, "file2.txt", "Content 2");
    await manager.create("Second checkpoint");

    const checkpoints = manager.list();
    expect(checkpoints.length).toBe(2);
    expect(checkpoints[0].description).toBe("First checkpoint");
    expect(checkpoints[1].description).toBe("Second checkpoint");
  });

  test("rollback restores files", async () => {
    const manager = new CheckpointManager(tempDir);
    await manager.initialize();

    // Create first checkpoint
    createTestFile(tempDir, "file1.txt", "Version 1");
    const cp1 = await manager.create("Checkpoint 1");

    // Modify file and create second checkpoint
    createTestFile(tempDir, "file1.txt", "Version 2");
    const cp2 = await manager.create("Checkpoint 2");

    expect(cp1).not.toBeNull();
    expect(cp2).not.toBeNull();

    // Verify current state
    let content = fs.readFileSync(path.join(tempDir, "file1.txt"), "utf-8");
    expect(content).toBe("Version 2");

    // Rollback to checkpoint 1
    const success = await manager.rollback(cp1!.id);
    expect(success).toBe(true);

    // Verify file was restored
    content = fs.readFileSync(path.join(tempDir, "file1.txt"), "utf-8");
    expect(content).toBe("Version 1");
  });

  test("undo restores to last checkpoint", async () => {
    const manager = new CheckpointManager(tempDir);
    await manager.initialize();

    // Create checkpoints
    createTestFile(tempDir, "file1.txt", "Version 1");
    const cp1 = await manager.create("Checkpoint 1");

    createTestFile(tempDir, "file1.txt", "Version 2");
    await manager.create("Checkpoint 2");

    // Modify file after checkpoint
    createTestFile(tempDir, "file1.txt", "Version 3");

    // Undo to checkpoint 2
    const success = await manager.undo();
    expect(success).toBe(true);

    const content = fs.readFileSync(path.join(tempDir, "file1.txt"), "utf-8");
    expect(content).toBe("Version 2");
  });

  test("diff shows changes between checkpoints", async () => {
    const manager = new CheckpointManager(tempDir);
    await manager.initialize();

    // Create first checkpoint
    createTestFile(tempDir, "file1.txt", "Hello World");
    const cp1 = await manager.create("Checkpoint 1");

    // Create second checkpoint with changes
    createTestFile(tempDir, "file1.txt", "Hello Universe");
    const cp2 = await manager.create("Checkpoint 2");

    expect(cp1).not.toBeNull();
    expect(cp2).not.toBeNull();

    // Get diff
    const diff = manager.diff(cp1!.id, cp2!.id);
    expect(diff).toBeDefined();
    expect(diff.length).toBeGreaterThan(0);
  });

  test("maxCheckpoints prunes old ones", async () => {
    const manager = new CheckpointManager(tempDir, {
      maxCheckpoints: 3,
    });
    await manager.initialize();

    // Create more checkpoints than maxCheckpoints
    for (let i = 1; i <= 5; i++) {
      createTestFile(tempDir, `file${i}.txt`, `Content ${i}`);
      await manager.create(`Checkpoint ${i}`);
    }

    const checkpoints = manager.list();
    expect(checkpoints.length).toBeLessThanOrEqual(3);
    // Most recent checkpoints should be kept
    expect(checkpoints[checkpoints.length - 1].description).toMatch(
      /Checkpoint [345]/
    );
  });

  test("multiple checkpoints in sequence", async () => {
    const manager = new CheckpointManager(tempDir);
    await manager.initialize();

    const checkpoints: Checkpoint[] = [];

    for (let i = 1; i <= 5; i++) {
      createTestFile(tempDir, `file${i}.txt`, `Content ${i}`);
      const cp = await manager.create(`Checkpoint ${i}`);
      expect(cp).not.toBeNull();
      checkpoints.push(cp!);
    }

    const listed = manager.list();
    expect(listed.length).toBe(5);
    expect(listed.map((cp) => cp.description)).toEqual([
      "Checkpoint 1",
      "Checkpoint 2",
      "Checkpoint 3",
      "Checkpoint 4",
      "Checkpoint 5",
    ]);
  });

  test("rollback removes later checkpoints", async () => {
    const manager = new CheckpointManager(tempDir);
    await manager.initialize();

    // Create 3 checkpoints
    createTestFile(tempDir, "file1.txt", "V1");
    const cp1 = await manager.create("CP 1");

    createTestFile(tempDir, "file2.txt", "V2");
    const cp2 = await manager.create("CP 2");

    createTestFile(tempDir, "file3.txt", "V3");
    const cp3 = await manager.create("CP 3");

    expect(manager.list().length).toBe(3);

    // Rollback to CP 1
    await manager.rollback(cp1!.id);

    // Should only have CP 1
    const listed = manager.list();
    expect(listed.length).toBe(1);
    expect(listed[0].id).toBe(cp1!.id);
  });

  test("cleanup doesn't throw", async () => {
    const manager = new CheckpointManager(tempDir, {
      strategy: "branch",
    });
    await manager.initialize();

    // Should not throw
    expect(await manager.cleanup()).toBeUndefined();
  });

  test("disabled checkpoint manager returns null on create", async () => {
    const manager = new CheckpointManager(tempDir, {
      enabled: false,
    });

    createTestFile(tempDir, "file1.txt", "Content");
    const checkpoint = await manager.create("Test");

    expect(checkpoint).toBeNull();
  });

  test("getStats returns correct information", async () => {
    const manager = new CheckpointManager(tempDir);
    await manager.initialize();

    // Initially empty
    let stats = manager.getStats();
    expect(stats.total).toBe(0);
    expect(stats.oldest).toBeNull();
    expect(stats.newest).toBeNull();

    // After creating checkpoints
    createTestFile(tempDir, "file1.txt", "V1");
    const cp1 = await manager.create("CP 1");

    createTestFile(tempDir, "file2.txt", "V2");
    const cp2 = await manager.create("CP 2");

    stats = manager.getStats();
    expect(stats.total).toBe(2);
    expect(stats.oldest?.id).toBe(cp1!.id);
    expect(stats.newest?.id).toBe(cp2!.id);
  });

  test("checkpoint with special characters in description", async () => {
    const manager = new CheckpointManager(tempDir);
    await manager.initialize();

    createTestFile(tempDir, "file1.txt", "Content");
    const checkpoint = await manager.create(
      "Checkpoint with special chars: @#$%"
    );

    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.description).toContain("@#$%");
  });

  test("diff returns empty string for invalid checkpoint", () => {
    const manager = new CheckpointManager(tempDir);
    const diff = manager.diff("invalid-cp");

    expect(diff).toBe("");
  });

  test("rollback returns false for invalid checkpoint", async () => {
    const manager = new CheckpointManager(tempDir);
    await manager.initialize();

    const success = await manager.rollback("invalid-cp");
    expect(success).toBe(false);
  });

  test("undo returns false when less than 2 checkpoints", async () => {
    const manager = new CheckpointManager(tempDir);
    await manager.initialize();

    const success = await manager.undo();
    expect(success).toBe(false);
  });
});
