import { BaseTool } from "./BaseTool.js";
import { ToolResult } from "../types/index.js";

// ========================================
// Phase 18: Git ツール強化（SWE-bench 対応）
//
// 汎用 GitTool に加えて、安全で構造化された
// 専用ツールを提供する。各ツールは:
//  - パラメータ単位で入力を制限
//  - 危険操作のブロック
//  - 構造化された出力
// ========================================

/**
 * git_status — ワーキングツリーの状態取得
 *
 * `git status --porcelain=v1` を実行し、変更ファイル一覧を返す。
 * オプションで `git diff --stat` の統計情報も取得可能。
 */
export class GitStatusTool extends BaseTool {
  name = "git_status";
  description =
    "Show the working tree status. Returns changed, staged, and untracked files with optional diff stats.";
  riskLevel: "LOW" | "MEDIUM" | "HIGH" = "LOW";

  parameters = {
    type: "object" as const,
    properties: {
      include_stats: {
        type: "boolean",
        description:
          "Include diff stats (insertions/deletions per file). Default: false",
      },
    },
    required: [] as string[],
  };

  async execute(params: unknown): Promise<ToolResult> {
    try {
      const { include_stats = false } = (params || {}) as {
        include_stats?: boolean;
      };

      // Use git diff directly to avoid stat cache issues
      // Staged files (index vs HEAD)
      const staged: string[] = [];
      try {
        const stagedOut = await this.runCommandSafe(
          "git",
          ["diff", "--cached", "--name-only"],
          10000,
        );
        staged.push(
          ...stagedOut
            .trim()
            .split("\n")
            .filter((l) => l.length > 0),
        );
      } catch {
        // empty repo or no HEAD
      }

      // Modified files (working tree vs index)
      const modified: string[] = [];
      try {
        const modifiedOut = await this.runCommandSafe(
          "git",
          ["diff", "--name-only"],
          10000,
        );
        modified.push(
          ...modifiedOut
            .trim()
            .split("\n")
            .filter((l) => l.length > 0),
        );
      } catch {
        // no changes
      }

      // Untracked files
      const untracked: string[] = [];
      try {
        const untrackedOut = await this.runCommandSafe(
          "git",
          ["ls-files", "--others", "--exclude-standard"],
          10000,
        );
        untracked.push(
          ...untrackedOut
            .trim()
            .split("\n")
            .filter((l) => l.length > 0),
        );
      } catch {
        // no untracked
      }

      let output = `Staged: ${staged.length} file(s)\n`;
      if (staged.length > 0)
        output += staged.map((f) => `  + ${f}`).join("\n") + "\n";
      output += `Modified: ${modified.length} file(s)\n`;
      if (modified.length > 0)
        output += modified.map((f) => `  M ${f}`).join("\n") + "\n";
      output += `Untracked: ${untracked.length} file(s)\n`;
      if (untracked.length > 0)
        output += untracked.map((f) => `  ? ${f}`).join("\n") + "\n";

      if (include_stats) {
        try {
          const stats = await this.runCommandSafe(
            "git",
            ["diff", "--stat"],
            10000,
          );
          if (stats.trim()) {
            output += `\nDiff stats:\n${stats}`;
          }
        } catch {
          // diff --stat might fail if no changes
        }
      }

      // Current branch
      try {
        const branch = await this.runCommandSafe(
          "git",
          ["branch", "--show-current"],
          5000,
        );
        output = `Branch: ${branch.trim()}\n${output}`;
      } catch {
        // detached HEAD or no branch
      }

      return { success: true, output };
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/**
 * git_diff — 差分表示ツール
 *
 * ワーキングツリー / ステージ / コミット間の差分を取得。
 * unified diff 形式で出力。ファイル指定、コミット範囲指定に対応。
 */
export class GitDiffTool extends BaseTool {
  name = "git_diff";
  description =
    "Show changes between commits, commit and working tree, etc. Supports file filtering and staged diff.";
  riskLevel: "LOW" | "MEDIUM" | "HIGH" = "LOW";

  parameters = {
    type: "object" as const,
    properties: {
      target: {
        type: "string",
        description:
          'Diff target: "working" (unstaged changes, default), "staged" (staged changes), or a commit/range like "HEAD~3", "main..feature", "abc123"',
      },
      file: {
        type: "string",
        description: "Limit diff to a specific file path",
      },
      context_lines: {
        type: "number",
        description: "Number of context lines around changes (default: 3)",
      },
      stat_only: {
        type: "boolean",
        description:
          "Show only file-level stats (insertions/deletions) instead of full diff. Default: false",
      },
    },
    required: [] as string[],
  };

  async execute(params: unknown): Promise<ToolResult> {
    try {
      const {
        target = "working",
        file,
        context_lines = 3,
        stat_only = false,
      } = (params || {}) as {
        target?: string;
        file?: string;
        context_lines?: number;
        stat_only?: boolean;
      };

      // Validate context_lines
      const ctxLines = Math.max(0, Math.min(context_lines, 20));

      const args: string[] = ["diff"];

      // Target selection
      if (target === "staged") {
        args.push("--cached");
      } else if (target !== "working") {
        // Sanitize: allow only safe ref patterns
        if (!/^[a-zA-Z0-9_./~^@{}-]+$/.test(target)) {
          return {
            success: false,
            output: "",
            error: `Invalid target: "${target}". Use "working", "staged", or a valid git ref.`,
          };
        }
        args.push(target);
      }

      // Options
      if (stat_only) {
        args.push("--stat");
      } else {
        args.push(`-U${ctxLines}`);
      }

      // File path
      if (file) {
        args.push("--", file);
      }

      const output = await this.runCommandSafe("git", args, 15000);

      if (!output.trim()) {
        return {
          success: true,
          output: "No differences found.",
        };
      }

      return { success: true, output };
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/**
 * git_commit — 安全なコミットツール
 *
 * ステージング + コミットを実行。
 * 危険な操作（--amend --force 等）をブロック。
 * ファイル指定またはステージ済みファイルのコミット。
 */
export class GitCommitTool extends BaseTool {
  name = "git_commit";
  description =
    "Stage files and create a commit. Supports staging specific files or all changes. Blocks dangerous flags.";
  riskLevel: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM";

  parameters = {
    type: "object" as const,
    properties: {
      message: {
        type: "string",
        description: "Commit message (required)",
      },
      files: {
        type: "array",
        description:
          'Files to stage before committing. Use ["."] for all files. If omitted, commits already-staged files.',
        items: { type: "string" },
      },
      amend: {
        type: "boolean",
        description:
          "Amend the last commit (message only, no force push). Default: false",
      },
    },
    required: ["message"],
  };

  async execute(params: unknown): Promise<ToolResult> {
    try {
      this.validateParams(params, ["message"]);

      const {
        message,
        files,
        amend = false,
      } = params as {
        message: string;
        files?: string[];
        amend?: boolean;
      };

      // Validate commit message
      if (!message || message.trim().length === 0) {
        return {
          success: false,
          output: "",
          error: "Commit message cannot be empty",
        };
      }

      // Block dangerous patterns in message
      if (message.includes("`") || message.includes("$(")) {
        return {
          success: false,
          output: "",
          error: "Commit message contains potentially dangerous characters",
        };
      }

      // Stage files if specified
      if (files && files.length > 0) {
        // Sanitize file paths
        for (const f of files) {
          if (f.includes("..") || f.includes("`") || f.includes("$(")) {
            return {
              success: false,
              output: "",
              error: `Invalid file path: "${f}"`,
            };
          }
        }
        await this.runCommandSafe("git", ["add", ...files], 10000);
      }

      // Check if there's anything staged to commit
      const stagedOut = await this.runCommandSafe(
        "git",
        ["diff", "--cached", "--name-only"],
        10000,
      );
      const stagedFiles = stagedOut
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);

      if (stagedFiles.length === 0 && !amend) {
        return {
          success: false,
          output: "",
          error:
            "No staged changes to commit. Stage files first or use files parameter.",
        };
      }

      // Build commit command
      const commitArgs = ["commit", "-m", message];
      if (amend) {
        commitArgs.push("--amend", "--no-edit");
        // When amending, the message replaces the old one
        // Remove --no-edit since we're providing a message
        commitArgs.pop();
      }

      const output = await this.runCommandSafe("git", commitArgs, 15000);

      // Get the commit hash
      let commitHash = "";
      try {
        commitHash = (
          await this.runCommandSafe(
            "git",
            ["rev-parse", "--short", "HEAD"],
            5000,
          )
        ).trim();
      } catch {
        // ignore
      }

      return {
        success: true,
        output: `${output.trim()}\nCommit: ${commitHash}`,
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

/**
 * git_apply — パッチ適用ツール
 *
 * unified diff 形式のパッチをワーキングツリーに適用。
 * `git apply` を使用し、安全に差分を適用する。
 * --check による事前検証オプション付き。
 */
export class GitApplyTool extends BaseTool {
  name = "git_apply";
  description =
    "Apply a unified diff patch to the working tree. Supports dry-run check and reverse apply.";
  riskLevel: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM";

  parameters = {
    type: "object" as const,
    properties: {
      patch: {
        type: "string",
        description: "The unified diff patch content to apply",
      },
      check: {
        type: "boolean",
        description:
          "Dry-run: check if the patch can be applied without actually applying. Default: false",
      },
      reverse: {
        type: "boolean",
        description: "Apply the patch in reverse (undo). Default: false",
      },
    },
    required: ["patch"],
  };

  async execute(params: unknown): Promise<ToolResult> {
    try {
      this.validateParams(params, ["patch"]);

      const {
        patch,
        check = false,
        reverse = false,
      } = params as {
        patch: string;
        check?: boolean;
        reverse?: boolean;
      };

      if (!patch || patch.trim().length === 0) {
        return {
          success: false,
          output: "",
          error: "Patch content cannot be empty",
        };
      }

      // Write patch to temp file
      const { writeFileSync, unlinkSync } = await import("fs");
      const { tmpdir } = await import("os");
      const { join } = await import("path");

      const tempPath = join(
        tmpdir(),
        `lunacode-patch-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`,
      );

      try {
        writeFileSync(tempPath, patch, "utf-8");

        const args = ["apply"];
        if (check) args.push("--check");
        if (reverse) args.push("--reverse");
        args.push(tempPath);

        const output = await this.runCommandSafe("git", args, 15000);

        if (check) {
          return {
            success: true,
            output: "Patch can be applied cleanly.",
          };
        }

        return {
          success: true,
          output: output.trim() || "Patch applied successfully.",
        };
      } finally {
        try {
          unlinkSync(tempPath);
        } catch {
          // cleanup best-effort
        }
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

/**
 * git_log — コミット履歴表示ツール
 *
 * `git log` の構造化出力。件数制限・フォーマット指定・
 * ファイルフィルタリングに対応。
 */
export class GitLogTool extends BaseTool {
  name = "git_log";
  description =
    "Show commit history with formatting options. Supports file filtering and count limit.";
  riskLevel: "LOW" | "MEDIUM" | "HIGH" = "LOW";

  parameters = {
    type: "object" as const,
    properties: {
      count: {
        type: "number",
        description: "Maximum number of commits to show (default: 10, max: 50)",
      },
      file: {
        type: "string",
        description: "Show commits that modified this file",
      },
      oneline: {
        type: "boolean",
        description: "Show compact one-line format. Default: false",
      },
      since: {
        type: "string",
        description:
          'Show commits since date (e.g. "2024-01-01", "1 week ago")',
      },
    },
    required: [] as string[],
  };

  async execute(params: unknown): Promise<ToolResult> {
    try {
      const {
        count = 10,
        file,
        oneline = false,
        since,
      } = (params || {}) as {
        count?: number;
        file?: string;
        oneline?: boolean;
        since?: string;
      };

      const n = Math.max(1, Math.min(count, 50));

      const args = ["log", `-${n}`];

      if (oneline) {
        args.push("--oneline");
      } else {
        args.push("--format=%H%n%an <%ae>%n%ai%n%s%n%b%n---");
      }

      if (since) {
        // Sanitize since
        if (!/^[a-zA-Z0-9 ./-]+$/.test(since)) {
          return {
            success: false,
            output: "",
            error: `Invalid since value: "${since}"`,
          };
        }
        args.push(`--since=${since}`);
      }

      if (file) {
        if (file.includes("..") || file.includes("`") || file.includes("$(")) {
          return {
            success: false,
            output: "",
            error: `Invalid file path: "${file}"`,
          };
        }
        args.push("--", file);
      }

      const output = await this.runCommandSafe("git", args, 15000);

      if (!output.trim()) {
        return {
          success: true,
          output: "No commits found.",
        };
      }

      return { success: true, output };
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
