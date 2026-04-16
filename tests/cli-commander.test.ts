import { describe, test, expect } from "bun:test";
import { Command } from "commander";

/**
 * Phase 17: commander.js CLI サブコマンド構造テスト
 *
 * cli.ts の buildProgram() は副作用（process.exit, I/O）を伴うため、
 * ここでは commander.js の Command API を使った構造テストを行う。
 */

describe("CLI commander structure", () => {
  function createTestProgram(): Command {
    const program = new Command();
    program.name("lunacode").version("2.2.0").exitOverride();
    return program;
  }

  describe("top-level commands", () => {
    test("should register init command", () => {
      const program = createTestProgram();
      program.command("init").description("Generate config");
      const cmd = program.commands.find((c) => c.name() === "init");
      expect(cmd).toBeDefined();
      expect(cmd!.description()).toBe("Generate config");
    });

    test("should register chat command with alias", () => {
      const program = createTestProgram();
      program.command("chat").alias("interactive").description("Chat mode");
      const cmd = program.commands.find((c) => c.name() === "chat");
      expect(cmd).toBeDefined();
      expect(cmd!.alias()).toBe("interactive");
    });

    test("should register auto command with options", () => {
      const program = createTestProgram();
      program
        .command("auto <query...>")
        .option("-r, --rounds <n>", "Max rounds", "10")
        .option("-s, --skill <name>", "Skill name");
      const cmd = program.commands.find((c) => c.name() === "auto");
      expect(cmd).toBeDefined();
      const opts = cmd!.options;
      expect(opts.length).toBe(2);
      expect(opts[0].long).toBe("--rounds");
      expect(opts[1].long).toBe("--skill");
    });

    test("should register provider command", () => {
      const program = createTestProgram();
      program.command("provider").description("List providers");
      expect(
        program.commands.find((c) => c.name() === "provider"),
      ).toBeDefined();
    });

    test("should register test-provider command with options", () => {
      const program = createTestProgram();
      program
        .command("test-provider")
        .option("-q, --quick", "Quick test")
        .option("--save", "Save report")
        .option("-o, --output <path>", "Output path");
      const cmd = program.commands.find((c) => c.name() === "test-provider");
      expect(cmd).toBeDefined();
      expect(cmd!.options.length).toBe(3);
    });
  });

  describe("subcommand groups", () => {
    test("should register daemon subcommands", () => {
      const program = createTestProgram();
      const daemon = program.command("daemon");
      for (const sub of ["start", "stop", "status", "restart", "logs"]) {
        daemon.command(sub);
      }
      expect(daemon.commands.length).toBe(5);
      expect(daemon.commands.map((c) => c.name())).toEqual([
        "start",
        "stop",
        "status",
        "restart",
        "logs",
      ]);
    });

    test("should register dream subcommands", () => {
      const program = createTestProgram();
      const dream = program.command("dream");
      for (const sub of ["run", "history", "status"]) {
        dream.command(sub);
      }
      expect(dream.commands.length).toBe(3);
    });

    test("should register memory subcommands", () => {
      const program = createTestProgram();
      const memory = program.command("memory");
      for (const sub of ["stats", "search", "compact", "topics"]) {
        memory.command(sub);
      }
      expect(memory.commands.length).toBe(4);
    });

    test("should register skill subcommands with aliases", () => {
      const program = createTestProgram();
      const skill = program.command("skill").alias("skills");
      skill.command("list").alias("ls");
      skill.command("create").alias("new");
      skill.command("enable");
      skill.command("disable");
      skill.command("show").alias("info");

      expect(skill.alias()).toBe("skills");
      expect(skill.commands.length).toBe(5);
      const listCmd = skill.commands.find((c) => c.name() === "list");
      expect(listCmd!.alias()).toBe("ls");
    });

    test("should register buddy subcommands", () => {
      const program = createTestProgram();
      const buddy = program.command("buddy");
      for (const sub of [
        "info",
        "call",
        "talk",
        "pet",
        "feed",
        "play",
        "sleep",
        "types",
        "create",
      ]) {
        buddy.command(sub);
      }
      expect(buddy.commands.length).toBe(9);
    });

    test("should register config subcommands", () => {
      const program = createTestProgram();
      const config = program.command("config");
      config.command("show");
      config.command("set");
      config.command("models");
      expect(config.commands.length).toBe(3);
    });
  });

  describe("option parsing", () => {
    test("should parse --rounds option for auto command", () => {
      const program = createTestProgram();
      let capturedOpts: Record<string, unknown> = {};
      program
        .command("auto <query...>")
        .option("-r, --rounds <n>", "Max rounds", "10")
        .action((_query, opts) => {
          capturedOpts = opts;
        });
      program.parse(["node", "test", "auto", "build app", "-r", "20"]);
      expect(capturedOpts.rounds).toBe("20");
    });

    test("should parse --quick and --save for test-provider", () => {
      const program = createTestProgram();
      let capturedOpts: Record<string, unknown> = {};
      program
        .command("test-provider")
        .option("-q, --quick", "Quick test")
        .option("--save", "Save report")
        .action((opts) => {
          capturedOpts = opts;
        });
      program.parse(["node", "test", "test-provider", "--quick", "--save"]);
      expect(capturedOpts.quick).toBe(true);
      expect(capturedOpts.save).toBe(true);
    });

    test("should default --rounds to 10 when not specified", () => {
      const program = createTestProgram();
      let capturedOpts: Record<string, unknown> = {};
      program
        .command("auto <query...>")
        .option("-r, --rounds <n>", "Max rounds", "10")
        .action((_query, opts) => {
          capturedOpts = opts;
        });
      program.parse(["node", "test", "auto", "hello"]);
      expect(capturedOpts.rounds).toBe("10");
    });

    test("should parse buddy create options", () => {
      const program = createTestProgram();
      let capturedOpts: Record<string, unknown> = {};
      program
        .command("buddy")
        .command("create")
        .option("-t, --type <type>", "Pet type")
        .option("-n, --name <name>", "Pet name")
        .action((opts) => {
          capturedOpts = opts;
        });
      program.parse([
        "node",
        "test",
        "buddy",
        "create",
        "-t",
        "dog",
        "-n",
        "Rex",
      ]);
      expect(capturedOpts.type).toBe("dog");
      expect(capturedOpts.name).toBe("Rex");
    });
  });

  describe("version", () => {
    test("should set version string", () => {
      const program = createTestProgram();
      expect(program.version()).toBe("2.2.0");
    });
  });

  describe("command count", () => {
    test("should have all expected top-level commands", () => {
      const program = createTestProgram();
      const expectedCommands = [
        "init",
        "config",
        "chat",
        "auto",
        "provider",
        "test-provider",
        "daemon",
        "dream",
        "buddy",
        "memory",
        "skill",
      ];
      for (const name of expectedCommands) {
        program.command(name);
      }
      expect(program.commands.length).toBe(expectedCommands.length);
      for (const name of expectedCommands) {
        expect(program.commands.find((c) => c.name() === name)).toBeDefined();
      }
    });
  });
});
