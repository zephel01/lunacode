/**
 * Phase 20: マルチファイル同時編集ツール
 *
 * SWE-bench のタスクは複数ファイルにまたがる修正が多い。
 * 全変更をアトミックに適用し、失敗時はロールバックする。
 */

import { BaseTool } from "./BaseTool.js";
import { ToolResult } from "../types/index.js";
import { validateSyntax, formatValidationWarning } from "./SyntaxValidator.js";

/** 1ファイル分の編集指示 */
export interface FileEdit {
  /** 対象ファイルパス */
  path: string;
  /** 置換元文字列（省略時は新規作成） */
  oldString?: string;
  /** 置換先文字列（oldString 省略時はファイル全体の内容） */
  newString: string;
}

/**
 * multi_file_edit — 複数ファイルへの一括編集をアトミックに適用
 *
 * - 全ファイルを事前に読み込みバックアップ
 * - 全編集を適用
 * - いずれか1つでも失敗したら全ファイルをロールバック
 * - dry_run モードで事前検証が可能
 */
export class MultiFileEditTool extends BaseTool {
  name = "multi_file_edit";
  description =
    "Apply edits to multiple files atomically. All changes succeed or all are rolled back. Supports creating new files and editing existing ones in a single operation.";
  riskLevel: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM";

  parameters = {
    type: "object" as const,
    properties: {
      edits: {
        type: "array",
        description: "Array of file edits to apply atomically",
        items: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "The file path to edit or create",
            },
            oldString: {
              type: "string",
              description:
                "The string to replace (omit to create a new file with newString as content)",
            },
            newString: {
              type: "string",
              description:
                "The replacement string, or full content for new files",
            },
          },
          required: ["path", "newString"],
        },
      },
      dry_run: {
        type: "boolean",
        description:
          "If true, validate all edits without applying them (default: false)",
      },
      description: {
        type: "string",
        description: "Optional description of what this batch edit does",
      },
    },
    required: ["edits"],
  };

  async execute(params: unknown): Promise<ToolResult> {
    try {
      this.validateParams(params, ["edits"]);

      const {
        edits,
        dry_run = false,
        description,
      } = params as {
        edits: FileEdit[];
        dry_run?: boolean;
        description?: string;
      };

      // ── バリデーション ──────────────────────────────
      if (!Array.isArray(edits) || edits.length === 0) {
        return {
          success: false,
          output: "",
          error: "edits must be a non-empty array",
        };
      }

      if (edits.length > 50) {
        return {
          success: false,
          output: "",
          error: "Too many edits: maximum 50 files per operation",
        };
      }

      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        if (!edit.path || typeof edit.path !== "string") {
          return {
            success: false,
            output: "",
            error: `Edit [${i}]: path is required and must be a string`,
          };
        }
        if (
          edit.newString === undefined ||
          typeof edit.newString !== "string"
        ) {
          return {
            success: false,
            output: "",
            error: `Edit [${i}]: newString is required and must be a string`,
          };
        }
        // パスのセキュリティチェック
        if (edit.path.includes("\0")) {
          return {
            success: false,
            output: "",
            error: `Edit [${i}]: path contains null byte`,
          };
        }
      }

      const fs = await import("fs/promises");
      const pathMod = await import("path");

      // ── Phase 1: 全ファイルのバックアップ読み込み ──────────
      type BackupEntry = {
        path: string;
        existed: boolean;
        content: string | null;
      };
      const backups: BackupEntry[] = [];
      const results: string[] = [];

      // 同一ファイルへの複数編集を順序通り処理するため、
      // 作業用にファイル内容をキャッシュ
      const contentCache = new Map<string, string>();

      for (const edit of edits) {
        // Phase 29: 相対パスは ToolContext.basePath 基準で解決
        const absPath = this.resolvePath(edit.path);
        if (!contentCache.has(absPath)) {
          try {
            const content = await fs.readFile(absPath, "utf-8");
            contentCache.set(absPath, content);
            backups.push({ path: absPath, existed: true, content });
          } catch {
            // ファイルが存在しない → 新規作成の可能性
            if (edit.oldString !== undefined) {
              return {
                success: false,
                output: "",
                error: `File not found: ${edit.path} (oldString specified but file does not exist)`,
              };
            }
            contentCache.set(absPath, "");
            backups.push({ path: absPath, existed: false, content: null });
          }
        }
      }

      // ── Phase 2: 全編集を検証（メモリ上で適用） ──────────
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        // Phase 29: 相対パスは ToolContext.basePath 基準で解決
        const absPath = this.resolvePath(edit.path);
        let content = contentCache.get(absPath) ?? "";

        if (edit.oldString !== undefined) {
          // 置換モード
          if (!content.includes(edit.oldString)) {
            return {
              success: false,
              output: results.join("\n"),
              error: `Edit [${i}] failed: oldString not found in ${edit.path}`,
            };
          }
          content = content.replace(edit.oldString, edit.newString);
          contentCache.set(absPath, content);
          results.push(
            `[${i}] ${edit.path}: replaced ${edit.oldString.length} chars → ${edit.newString.length} chars`,
          );
        } else {
          // 新規作成/上書きモード
          const backupEntry = backups.find((b) => b.path === absPath);
          if (backupEntry?.existed) {
            content = edit.newString;
            contentCache.set(absPath, content);
            results.push(
              `[${i}] ${edit.path}: overwrite (${edit.newString.length} chars)`,
            );
          } else {
            contentCache.set(absPath, edit.newString);
            results.push(
              `[${i}] ${edit.path}: create new (${edit.newString.length} chars)`,
            );
          }
        }
      }

      // ── dry_run ならここで終了 ──────────────────────
      if (dry_run) {
        const header = description
          ? `[DRY RUN] ${description}`
          : "[DRY RUN] All edits validated successfully";
        return {
          success: true,
          output: [header, ...results].join("\n"),
        };
      }

      // ── Phase 3: ディスクに書き込み ─────────────────
      const writtenPaths: string[] = [];
      const verifiedSizes: Map<string, number> = new Map();
      try {
        for (const [absPath, content] of contentCache) {
          // ディレクトリが存在しなければ作成
          const dir = pathMod.dirname(absPath);
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(absPath, content, "utf-8");
          const stat = await fs.stat(absPath);
          verifiedSizes.set(absPath, stat.size);
          writtenPaths.push(absPath);
        }
      } catch (writeError) {
        // ── 書き込み失敗 → ロールバック ────────────────
        await this.rollback(backups, fs);
        return {
          success: false,
          output: "",
          error: `Write failed, rolled back all changes: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
        };
      }

      const verifyLines = writtenPaths.map(
        (p) => `  ✅ ${p} [${verifiedSizes.get(p)} bytes on disk]`,
      );

      // 書き込み後に構文チェック（失敗してもロールバックはしない・警告のみ）
      const warningLines: string[] = [];
      for (const absPath of writtenPaths) {
        const content = contentCache.get(absPath) ?? "";
        const validation = await validateSyntax(absPath, content);
        const warning = formatValidationWarning(validation);
        if (warning) {
          warningLines.push(`  ⚠️  ${absPath}:${warning}`);
        }
      }

      const header = description
        ? `${description}: ${edits.length} edit(s) applied to ${contentCache.size} file(s)`
        : `${edits.length} edit(s) applied to ${contentCache.size} file(s)`;
      return {
        success: true,
        output: [header, ...results, ...verifyLines, ...warningLines].join(
          "\n",
        ),
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** バックアップからファイルを復元 */
  private async rollback(
    backups: Array<{ path: string; existed: boolean; content: string | null }>,
    fs: typeof import("fs/promises"),
  ): Promise<void> {
    for (const backup of backups) {
      try {
        if (backup.existed && backup.content !== null) {
          await fs.writeFile(backup.path, backup.content, "utf-8");
        } else if (!backup.existed) {
          // 新規作成されたファイルを削除
          try {
            await fs.unlink(backup.path);
          } catch {
            // ファイルが存在しない場合は無視
          }
        }
      } catch {
        // ロールバック中のエラーは無視（ベストエフォート）
      }
    }
  }
}
