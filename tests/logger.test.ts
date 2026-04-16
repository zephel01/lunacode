import { describe, test, expect, beforeEach } from "bun:test";
import { Logger } from "../src/utils/Logger.js";
import type { LoggingConfig } from "../src/utils/Logger.js";

describe("Logger", () => {
  beforeEach(() => {
    Logger.reset();
  });

  describe("configure", () => {
    test("should initialize with default config", () => {
      Logger.configure();
      const root = Logger.getRoot();
      expect(root).toBeDefined();
      expect(root.level).toBe("info");
    });

    test("should accept custom log level", () => {
      Logger.configure({ level: "debug" });
      const root = Logger.getRoot();
      expect(root.level).toBe("debug");
    });

    test("should accept trace level", () => {
      Logger.configure({ level: "trace" });
      const root = Logger.getRoot();
      expect(root.level).toBe("trace");
    });

    test("should accept warn level", () => {
      Logger.configure({ level: "warn" });
      const root = Logger.getRoot();
      expect(root.level).toBe("warn");
    });

    test("should store config", () => {
      const config: LoggingConfig = { level: "debug", json: true };
      Logger.configure(config);
      const stored = Logger.getConfig();
      expect(stored.level).toBe("debug");
      expect(stored.json).toBe(true);
    });

    test("should not mutate stored config", () => {
      const config: LoggingConfig = { level: "debug" };
      Logger.configure(config);
      const stored = Logger.getConfig();
      stored.level = "error";
      expect(Logger.getConfig().level).toBe("debug");
    });
  });

  describe("get (child logger)", () => {
    test("should return a child logger with component name", () => {
      Logger.configure();
      const child = Logger.get("AgentLoop");
      expect(child).toBeDefined();
      // pino child loggers have bindings
      expect(
        (
          child as unknown as { bindings: () => Record<string, unknown> }
        ).bindings().component,
      ).toBe("AgentLoop");
    });

    test("should auto-configure if not yet configured", () => {
      // No explicit configure() call
      const child = Logger.get("AutoInit");
      expect(child).toBeDefined();
    });

    test("should return different child loggers for different names", () => {
      Logger.configure();
      const a = Logger.get("ModuleA");
      const b = Logger.get("ModuleB");
      expect(
        (a as unknown as { bindings: () => Record<string, unknown> }).bindings()
          .component,
      ).toBe("ModuleA");
      expect(
        (b as unknown as { bindings: () => Record<string, unknown> }).bindings()
          .component,
      ).toBe("ModuleB");
    });
  });

  describe("getRoot", () => {
    test("should auto-configure if not yet configured", () => {
      const root = Logger.getRoot();
      expect(root).toBeDefined();
      expect(root.level).toBe("info");
    });

    test("should return same instance on multiple calls", () => {
      Logger.configure();
      const a = Logger.getRoot();
      const b = Logger.getRoot();
      expect(a).toBe(b);
    });
  });

  describe("reset", () => {
    test("should clear root logger and config", () => {
      Logger.configure({ level: "error" });
      Logger.reset();
      const config = Logger.getConfig();
      expect(config.level).toBeUndefined();
    });

    test("should allow re-configure after reset", () => {
      Logger.configure({ level: "error" });
      Logger.reset();
      Logger.configure({ level: "debug" });
      expect(Logger.getRoot().level).toBe("debug");
    });
  });

  describe("logging methods", () => {
    test("should have standard log methods", () => {
      Logger.configure({ level: "trace" });
      const log = Logger.get("Test");
      expect(typeof log.trace).toBe("function");
      expect(typeof log.debug).toBe("function");
      expect(typeof log.info).toBe("function");
      expect(typeof log.warn).toBe("function");
      expect(typeof log.error).toBe("function");
      expect(typeof log.fatal).toBe("function");
    });

    test("should not throw when logging at various levels", () => {
      Logger.configure({ level: "trace" });
      const log = Logger.get("Test");
      expect(() => log.trace("trace msg")).not.toThrow();
      expect(() => log.debug("debug msg")).not.toThrow();
      expect(() => log.info("info msg")).not.toThrow();
      expect(() => log.warn("warn msg")).not.toThrow();
      expect(() => log.error("error msg")).not.toThrow();
    });

    test("should support structured logging with object + message", () => {
      Logger.configure({ level: "trace" });
      const log = Logger.get("Test");
      expect(() =>
        log.info({ tool: "bash", iteration: 3 }, "Executing tool"),
      ).not.toThrow();
    });

    test("should support error object in structured log", () => {
      Logger.configure({ level: "trace" });
      const log = Logger.get("Test");
      const err = new Error("test error");
      expect(() => log.error({ err }, "Something went wrong")).not.toThrow();
    });
  });

  describe("json mode", () => {
    test("should configure without errors in json mode", () => {
      expect(() => Logger.configure({ json: true })).not.toThrow();
      const root = Logger.getRoot();
      expect(root).toBeDefined();
    });

    test("should configure with file output", () => {
      // Just ensure no errors — file writing is a side effect
      expect(() =>
        Logger.configure({ file: "/tmp/lunacode-test-logger.log" }),
      ).not.toThrow();
    });
  });
});
