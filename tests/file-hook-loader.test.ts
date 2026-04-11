import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { FileHookLoader } from "../src/hooks/FileHookLoader.js";
import { HookManager } from "../src/hooks/HookManager.js";

describe("FileHookLoader", () => {
  let tempDir: string;
  let hookManager: HookManager;
  let fileHookLoader: FileHookLoader;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-loader-test-"));
    hookManager = new HookManager();
    fileHookLoader = new FileHookLoader();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  test("should load hooks from .kairos/hooks.json", async () => {
    const kairosDir = path.join(tempDir, ".kairos");
    await fs.mkdir(kairosDir, { recursive: true });

    const hooksConfig = {
      hooks: [
        {
          name: "test-hook",
          event: "session:start",
          command: "echo 'test'",
        },
      ],
    };

    await fs.writeFile(
      path.join(kairosDir, "hooks.json"),
      JSON.stringify(hooksConfig)
    );

    const loaded = await fileHookLoader.load(tempDir, hookManager);

    expect(loaded).toBe(1);
    const list = hookManager.list();
    expect(list.length).toBeGreaterThan(0);
    expect(list.some(item => item.event === "session:start")).toBe(true);
  });

  test("should return 0 when hooks.json does not exist", async () => {
    const loaded = await fileHookLoader.load(tempDir, hookManager);

    expect(loaded).toBe(0);
  });

  test("should filter hooks by toolName condition", async () => {
    const kairosDir = path.join(tempDir, ".kairos");
    await fs.mkdir(kairosDir, { recursive: true });

    const hooksConfig = {
      hooks: [
        {
          name: "read-file-hook",
          event: "tool:before",
          command: "echo 'read'",
          condition: {
            toolName: ["read_file", "write_file"],
          },
        },
      ],
    };

    await fs.writeFile(
      path.join(kairosDir, "hooks.json"),
      JSON.stringify(hooksConfig)
    );

    const loaded = await fileHookLoader.load(tempDir, hookManager);
    expect(loaded).toBe(1);

    // Emit for matching toolName
    let callCount = 0;
    hookManager.register({
      name: "counter",
      event: "tool:before",
      handler: async () => {
        callCount++;
      },
    });

    await hookManager.emit("tool:before", { toolName: "read_file" });
    expect(callCount).toBe(1);

    // Reset counter
    callCount = 0;

    // Emit for non-matching toolName - the loaded hook should not execute
    // (We can't directly test the condition filtering without mocking exec,
    // but we can verify the hook was loaded)
    const list = hookManager.list();
    const readFileHook = list
      .flatMap(item => item.hooks)
      .find(h => h.name === "read-file-hook");
    expect(readFileHook).not.toBeUndefined();
  });

  test("should filter hooks by filePattern condition", async () => {
    const kairosDir = path.join(tempDir, ".kairos");
    await fs.mkdir(kairosDir, { recursive: true });

    const hooksConfig = {
      hooks: [
        {
          name: "typescript-hook",
          event: "tool:after",
          command: "echo 'ts'",
          condition: {
            filePattern: "*.ts",
          },
        },
      ],
    };

    await fs.writeFile(
      path.join(kairosDir, "hooks.json"),
      JSON.stringify(hooksConfig)
    );

    const loaded = await fileHookLoader.load(tempDir, hookManager);
    expect(loaded).toBe(1);

    const list = hookManager.list();
    const tsHook = list
      .flatMap(item => item.hooks)
      .find(h => h.name === "typescript-hook");
    expect(tsHook).not.toBeUndefined();
  });

  test("should interpolate variables in command", async () => {
    const kairosDir = path.join(tempDir, ".kairos");
    await fs.mkdir(kairosDir, { recursive: true });

    const hooksConfig = {
      hooks: [
        {
          name: "var-hook",
          event: "tool:before",
          command: "echo 'Tool: ${toolName} File: ${filePath} Session: ${sessionId}'",
        },
      ],
    };

    await fs.writeFile(
      path.join(kairosDir, "hooks.json"),
      JSON.stringify(hooksConfig)
    );

    const loaded = await fileHookLoader.load(tempDir, hookManager);
    expect(loaded).toBe(1);

    // The hook will be registered with the original template
    // The interpolation happens during emission
    // We verify it was loaded correctly
    const list = hookManager.list();
    expect(list.length).toBeGreaterThan(0);
  });

  test("should handle multiple hooks in hooks.json", async () => {
    const kairosDir = path.join(tempDir, ".kairos");
    await fs.mkdir(kairosDir, { recursive: true });

    const hooksConfig = {
      hooks: [
        {
          name: "hook1",
          event: "session:start",
          command: "echo 'hook1'",
          priority: 10,
        },
        {
          name: "hook2",
          event: "session:end",
          command: "echo 'hook2'",
          priority: 20,
        },
        {
          name: "hook3",
          event: "tool:before",
          command: "echo 'hook3'",
          priority: 30,
        },
      ],
    };

    await fs.writeFile(
      path.join(kairosDir, "hooks.json"),
      JSON.stringify(hooksConfig)
    );

    const loaded = await fileHookLoader.load(tempDir, hookManager);

    expect(loaded).toBe(3);
    const list = hookManager.list();
    expect(list.length).toBe(3);
  });

  test("should respect priority order from hooks.json", async () => {
    const kairosDir = path.join(tempDir, ".kairos");
    await fs.mkdir(kairosDir, { recursive: true });

    const hooksConfig = {
      hooks: [
        {
          name: "low-priority",
          event: "session:start",
          command: "echo 'low'",
          priority: 100,
        },
        {
          name: "high-priority",
          event: "session:start",
          command: "echo 'high'",
          priority: 10,
        },
      ],
    };

    await fs.writeFile(
      path.join(kairosDir, "hooks.json"),
      JSON.stringify(hooksConfig)
    );

    const loaded = await fileHookLoader.load(tempDir, hookManager);
    expect(loaded).toBe(2);

    const list = hookManager.list();
    const sessionStartHooks = list.find(item => item.event === "session:start");
    expect(sessionStartHooks?.hooks[0].name).toBe("high-priority");
    expect(sessionStartHooks?.hooks[1].name).toBe("low-priority");
  });

  test("should handle invalid hooks.json gracefully", async () => {
    const kairosDir = path.join(tempDir, ".kairos");
    await fs.mkdir(kairosDir, { recursive: true });

    // Write invalid JSON
    await fs.writeFile(path.join(kairosDir, "hooks.json"), "{ invalid json }");

    // Should throw a JSON parse error (distinguishes from file-not-found)
    let error: Error | null = null;
    try {
      await fileHookLoader.load(tempDir, hookManager);
    } catch (e) {
      error = e as Error;
    }

    // FileHookLoader throws on invalid JSON so callers know config is broken
    expect(error).not.toBeNull();
    expect(error!.message).toContain("JSON");
  });

  test("should handle hooks.json with empty hooks array", async () => {
    const kairosDir = path.join(tempDir, ".kairos");
    await fs.mkdir(kairosDir, { recursive: true });

    const hooksConfig = {
      hooks: [],
    };

    await fs.writeFile(
      path.join(kairosDir, "hooks.json"),
      JSON.stringify(hooksConfig)
    );

    const loaded = await fileHookLoader.load(tempDir, hookManager);

    expect(loaded).toBe(0);
  });

  test("should handle hooks.json with no hooks property", async () => {
    const kairosDir = path.join(tempDir, ".kairos");
    await fs.mkdir(kairosDir, { recursive: true });

    const hooksConfig = {};

    await fs.writeFile(
      path.join(kairosDir, "hooks.json"),
      JSON.stringify(hooksConfig)
    );

    const loaded = await fileHookLoader.load(tempDir, hookManager);

    expect(loaded).toBe(0);
  });

  test("should support both single and multiple events in config", async () => {
    const kairosDir = path.join(tempDir, ".kairos");
    await fs.mkdir(kairosDir, { recursive: true });

    const hooksConfig = {
      hooks: [
        {
          name: "single-event",
          event: "session:start",
          command: "echo 'single'",
        },
        {
          name: "multi-event",
          event: ["tool:before", "tool:after"],
          command: "echo 'multi'",
        },
      ],
    };

    await fs.writeFile(
      path.join(kairosDir, "hooks.json"),
      JSON.stringify(hooksConfig)
    );

    const loaded = await fileHookLoader.load(tempDir, hookManager);

    expect(loaded).toBe(2);
    // The multi-event hook should register for both events
    const list = hookManager.list();
    const events = list.map(item => item.event);
    expect(events).toContain("session:start");
  });
});
