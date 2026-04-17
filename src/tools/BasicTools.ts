import { BaseTool } from "./BaseTool.js";
import { ToolResult } from "../types/index.js";
import { validateSyntax, formatValidationWarning } from "./SyntaxValidator.js";

export class BashTool extends BaseTool {
  name = "bash";
  description = "Execute a bash command in the terminal";
  riskLevel: "LOW" | "MEDIUM" | "HIGH" = "HIGH";

  parameters = {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description: "The bash command to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default: 15000)",
      },
    },
    required: ["command"],
  };

  async execute(params: unknown): Promise<ToolResult> {
    try {
      this.validateParams(params, ["command"]);

      const { command, timeout = 15000 } = params as {
        command: string;
        timeout?: number;
      };

      // セキュリティチェック: 危険なパターンを正規表現で検出
      const dangerousPatterns: Array<{ pattern: RegExp; reason: string }> = [
        {
          pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/(\s|$|\*)/,
          reason: "Recursive delete on root",
        },
        {
          pattern: /rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+-[a-zA-Z]*f/,
          reason: "Forced recursive delete",
        },
        {
          pattern: /rm\s+-[a-zA-Z]*f[a-zA-Z]*\s+-[a-zA-Z]*r/,
          reason: "Forced recursive delete",
        },
        {
          pattern: /dd\s+.*if=\/dev\/(zero|random|urandom)/,
          reason: "Disk overwrite via dd",
        },
        { pattern: /mkfs(\.\w+)?(\s|$)/, reason: "Filesystem format" },
        {
          pattern: /chmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?777\s+\//,
          reason: "Recursive permission change on root",
        },
        { pattern: />\s*\/dev\/[sh]d[a-z]/, reason: "Direct device write" },
        { pattern: /:(){ :|:& };:/, reason: "Fork bomb" },
        { pattern: /\bsudo\b/, reason: "Privileged execution" },
        {
          pattern: /\bcurl\b.*\|\s*(ba)?sh/,
          reason: "Remote code execution via pipe",
        },
        {
          pattern: /\bwget\b.*\|\s*(ba)?sh/,
          reason: "Remote code execution via pipe",
        },
        { pattern: />\s*\/etc\//, reason: "Writing to system config" },
        {
          pattern: /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/,
          reason: "System shutdown/reboot",
        },
      ];

      const normalizedCommand = command.replace(/\s+/g, " ").trim();
      for (const { pattern, reason } of dangerousPatterns) {
        if (pattern.test(normalizedCommand)) {
          return {
            success: false,
            output: "",
            error: `Command blocked: ${reason}`,
          };
        }
      }

      const output = await this.runCommand(command, timeout);

      return {
        success: true,
        output,
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export class FileReadTool extends BaseTool {
  name = "read_file";
  description = "Read the contents of a file";
  riskLevel: "LOW" | "MEDIUM" | "HIGH" = "LOW";

  parameters = {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "The path to the file to read",
      },
      offset: {
        type: "number",
        description:
          "The line number to start reading from (1-indexed, default: 1)",
      },
      limit: {
        type: "number",
        description: "The maximum number of lines to read (default: 2000)",
      },
    },
    required: ["path"],
  };

  async execute(params: unknown): Promise<ToolResult> {
    try {
      this.validateParams(params, ["path"]);

      const {
        path,
        offset = 1,
        limit = 2000,
      } = params as {
        path: string;
        offset?: number;
        limit?: number;
      };

      const fs = await import("fs/promises");
      const content = await fs.readFile(path, "utf-8");
      const lines = content.split("\n");

      const start = Math.max(0, offset - 1);
      const end = Math.min(lines.length, start + limit);
      const selectedLines = lines.slice(start, end);

      return {
        success: true,
        output: selectedLines
          .map((line, i) => `${start + i + 1}: ${line}`)
          .join("\n"),
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export class FileWriteTool extends BaseTool {
  name = "write_file";
  description = `Write content to a file (creates or overwrites). Write the COMPLETE content in one call whenever possible. Use append=true only if appending additional content to an existing file.`;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM";

  parameters = {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "The path to the file to write",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
      append: {
        type: "boolean",
        description:
          "If true, append content to the existing file instead of overwriting. Use this for writing large files in multiple parts.",
      },
    },
    required: ["path", "content"],
  };

  async execute(params: unknown): Promise<ToolResult> {
    try {
      this.validateParams(params, ["path", "content"]);

      const {
        path,
        content,
        append = false,
      } = params as {
        path: string;
        content: string;
        append?: boolean;
      };

      const fs = await import("fs/promises");
      if (append) {
        await fs.appendFile(path, content, "utf-8");
        const stat = await fs.stat(path);
        // append 時は書き込み後のファイル全体を読み直して検証する
        let fullContent = "";
        try {
          fullContent = await fs.readFile(path, "utf-8");
        } catch {
          fullContent = content;
        }
        const validation = await validateSyntax(path, fullContent);
        const warning = formatValidationWarning(validation);
        return {
          success: true,
          output: `Successfully appended to ${path} [verified: ${stat.size} bytes on disk]${warning}`,
        };
      } else {
        await fs.writeFile(path, content, "utf-8");
        const stat = await fs.stat(path);
        const validation = await validateSyntax(path, content);
        const warning = formatValidationWarning(validation);
        return {
          success: true,
          output: `Successfully wrote ${path} [verified: ${stat.size} bytes on disk]${warning}`,
        };
      }
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export class FileEditTool extends BaseTool {
  name = "edit_file";
  description = `Edit a file by replacing a specific string with new content. Use this to modify existing files instead of rewriting them entirely.`;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM";

  parameters = {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "The path to the file to edit",
      },
      oldString: {
        type: "string",
        description: "The string to replace",
      },
      newString: {
        type: "string",
        description: "The new string to replace with",
      },
      replaceAll: {
        type: "boolean",
        description: "Replace all occurrences (default: false)",
      },
    },
    required: ["path", "oldString", "newString"],
  };

  async execute(params: unknown): Promise<ToolResult> {
    try {
      this.validateParams(params, ["path", "oldString", "newString"]);

      const {
        path,
        oldString,
        newString,
        replaceAll = false,
      } = params as {
        path: string;
        oldString: string;
        newString: string;
        replaceAll?: boolean;
      };

      const fs = await import("fs/promises");
      let content = await fs.readFile(path, "utf-8");

      if (replaceAll) {
        content = content.replaceAll(oldString, newString);
      } else {
        if (!content.includes(oldString)) {
          return {
            success: false,
            output: "",
            error: "Old string not found in content",
          };
        }
        content = content.replace(oldString, newString);
      }

      await fs.writeFile(path, content, "utf-8");
      const stat = await fs.stat(path);

      const validation = await validateSyntax(path, content);
      const warning = formatValidationWarning(validation);

      return {
        success: true,
        output: `Successfully edited ${path} [verified: ${stat.size} bytes on disk]${warning}`,
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export class GlobTool extends BaseTool {
  name = "glob";
  description = "Find files matching a pattern";
  riskLevel: "LOW" | "MEDIUM" | "HIGH" = "LOW";

  parameters = {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string",
        description: "The glob pattern to match files against",
      },
      path: {
        type: "string",
        description: "The directory to search in (default: current directory)",
      },
    },
    required: ["pattern"],
  };

  async execute(params: unknown): Promise<ToolResult> {
    try {
      this.validateParams(params, ["pattern"]);

      const { pattern, path = process.cwd() } = params as {
        pattern: string;
        path?: string;
      };

      const fg = await import("fast-glob");
      const files = await fg.glob(pattern, {
        cwd: path,
        absolute: true,
        onlyFiles: true,
      });

      return {
        success: true,
        output: files.join("\n"),
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export class GrepTool extends BaseTool {
  name = "grep";
  description = "Search for a pattern in file contents";
  riskLevel: "LOW" | "MEDIUM" | "HIGH" = "LOW";

  parameters = {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string",
        description: "The regex pattern to search for",
      },
      path: {
        type: "string",
        description: "The directory to search in (default: current directory)",
      },
      include: {
        type: "string",
        description: "File pattern to include (e.g., *.js, *.ts)",
      },
    },
    required: ["pattern"],
  };

  async execute(params: unknown): Promise<ToolResult> {
    try {
      this.validateParams(params, ["pattern"]);

      const {
        pattern,
        path = process.cwd(),
        include,
      } = params as {
        pattern: string;
        path?: string;
        include?: string;
      };

      // シェルインジェクション対策: 引数配列方式で実行
      const args = [
        pattern,
        path,
        "--no-heading",
        "--line-number",
        "--color",
        "never",
      ];

      if (include) {
        args.push("-g", include);
      }

      const output = await this.runCommandSafe("rg", args);

      return {
        success: true,
        output,
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export class GitTool extends BaseTool {
  name = "git";
  description = "Execute a git command";
  riskLevel: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM";

  parameters = {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description: 'The git command to execute (without "git" prefix)',
      },
    },
    required: ["command"],
  };

  async execute(params: unknown): Promise<ToolResult> {
    try {
      this.validateParams(params, ["command"]);

      const { command } = params as {
        command: string;
      };

      const output = await this.runCommand(`git ${command}`);

      return {
        success: true,
        output,
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
