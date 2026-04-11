import { describe, test, expect, beforeEach } from "bun:test";
import { HookManager } from "../src/hooks/HookManager.js";
import { HookDefinition, HookContext } from "../src/types/index.js";

describe("HookManager", () => {
  let hookManager: HookManager;

  beforeEach(() => {
    hookManager = new HookManager("test-session");
  });

  test("should register a hook and list it", () => {
    const hook: HookDefinition = {
      name: "test-hook",
      event: "session:start",
      handler: async () => {},
    };

    hookManager.register(hook);
    const list = hookManager.list();

    expect(list.length).toBe(1);
    expect(list[0].event).toBe("session:start");
    expect(list[0].hooks.length).toBe(1);
    expect(list[0].hooks[0].name).toBe("test-hook");
  });

  test("should emit an event and call the handler", async () => {
    let handlerCalled = false;

    const hook: HookDefinition = {
      name: "test-hook",
      event: "tool:before",
      handler: async () => {
        handlerCalled = true;
      },
    };

    hookManager.register(hook);
    await hookManager.emit("tool:before", { toolName: "read_file" });

    expect(handlerCalled).toBe(true);
  });

  test("should respect hook priority order", async () => {
    const callOrder: string[] = [];

    const hook1: HookDefinition = {
      name: "low-priority",
      event: "tool:before",
      priority: 100,
      handler: async () => {
        callOrder.push("low");
      },
    };

    const hook2: HookDefinition = {
      name: "high-priority",
      event: "tool:before",
      priority: 10,
      handler: async () => {
        callOrder.push("high");
      },
    };

    const hook3: HookDefinition = {
      name: "mid-priority",
      event: "tool:before",
      priority: 50,
      handler: async () => {
        callOrder.push("mid");
      },
    };

    hookManager.register(hook1);
    hookManager.register(hook2);
    hookManager.register(hook3);

    await hookManager.emit("tool:before", {});

    expect(callOrder).toEqual(["high", "mid", "low"]);
  });

  test("should abort execution when hook calls context.abort()", async () => {
    const callOrder: string[] = [];

    const hook1: HookDefinition = {
      name: "abort-hook",
      event: "tool:before",
      priority: 10,
      handler: async (context) => {
        callOrder.push("hook1");
        context.abort?.();
      },
    };

    const hook2: HookDefinition = {
      name: "should-not-run",
      event: "tool:before",
      priority: 20,
      handler: async () => {
        callOrder.push("hook2");
      },
    };

    hookManager.register(hook1);
    hookManager.register(hook2);

    const result = await hookManager.emit("tool:before", {});

    expect(callOrder).toEqual(["hook1"]);
    expect(result.aborted).toBe(true);
  });

  test("should allow modifying args via context.modifyArgs()", async () => {
    const hook: HookDefinition = {
      name: "modify-hook",
      event: "tool:before",
      handler: async (context) => {
        context.modifyArgs?.({ newKey: "newValue", count: 42 });
      },
    };

    hookManager.register(hook);
    const result = await hookManager.emit("tool:before", {});

    expect(result.modifiedArgs).toEqual({ newKey: "newValue", count: 42 });
  });

  test("should unregister a hook by name", async () => {
    let called = false;

    const hook: HookDefinition = {
      name: "to-remove",
      event: "tool:before",
      handler: async () => {
        called = true;
      },
    };

    hookManager.register(hook);
    hookManager.unregister("to-remove");

    await hookManager.emit("tool:before", {});

    expect(called).toBe(false);
  });

  test("should skip disabled hooks", async () => {
    let called = false;

    const hook: HookDefinition = {
      name: "disabled-hook",
      event: "tool:before",
      enabled: false,
      handler: async () => {
        called = true;
      },
    };

    hookManager.register(hook);
    await hookManager.emit("tool:before", {});

    expect(called).toBe(false);
  });

  test("should isolate hook errors and continue execution", async () => {
    const callOrder: string[] = [];

    const hook1: HookDefinition = {
      name: "failing-hook",
      event: "tool:before",
      priority: 10,
      handler: async () => {
        callOrder.push("hook1");
        throw new Error("Hook error");
      },
    };

    const hook2: HookDefinition = {
      name: "should-still-run",
      event: "tool:before",
      priority: 20,
      handler: async () => {
        callOrder.push("hook2");
      },
    };

    hookManager.register(hook1);
    hookManager.register(hook2);

    // Should not throw
    const result = await hookManager.emit("tool:before", {});

    expect(callOrder).toEqual(["hook1", "hook2"]);
    expect(result.aborted).toBe(false);
  });

  test("should register a hook for multiple events", async () => {
    const callOrder: string[] = [];

    const hook: HookDefinition = {
      name: "multi-event-hook",
      event: ["tool:before", "tool:after"],
      handler: async (context) => {
        callOrder.push(context.event);
      },
    };

    hookManager.register(hook);

    await hookManager.emit("tool:before", {});
    await hookManager.emit("tool:after", {});

    expect(callOrder).toEqual(["tool:before", "tool:after"]);
  });

  test("should return correct hook count", () => {
    const hook1: HookDefinition = {
      name: "hook1",
      event: "session:start",
      handler: async () => {},
    };

    const hook2: HookDefinition = {
      name: "hook2",
      event: ["tool:before", "tool:after"],
      handler: async () => {},
    };

    hookManager.register(hook1);
    hookManager.register(hook2);

    expect(hookManager.getHookCount()).toBe(3); // 1 + 2
  });

  test("should include context data in handler", async () => {
    let receivedContext: HookContext | null = null;

    const hook: HookDefinition = {
      name: "context-hook",
      event: "tool:before",
      handler: async (context) => {
        receivedContext = context;
      },
    };

    hookManager.register(hook);

    await hookManager.emit("tool:before", {
      toolName: "read_file",
      toolArgs: { path: "/some/file.ts" },
      iteration: 5,
    });

    expect(receivedContext).not.toBeNull();
    expect(receivedContext?.event).toBe("tool:before");
    expect(receivedContext?.sessionId).toBe("test-session");
    expect(receivedContext?.toolName).toBe("read_file");
    expect(receivedContext?.iteration).toBe(5);
    expect(receivedContext?.toolArgs?.path).toBe("/some/file.ts");
    expect(receivedContext?.timestamp).toBeGreaterThan(0);
  });
});
