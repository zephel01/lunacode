import * as fs from "fs/promises";

/**
 * Utility class for generating unified diff output.
 * Provides diff generation for file changes and replacements.
 */
export class DiffGenerator {
  /**
   * Generate unified diff between two strings
   * @param oldContent The original content
   * @param newContent The new content
   * @param filePath The file path for diff header
   * @returns Unified diff format string
   */
  static generateUnifiedDiff(
    oldContent: string,
    newContent: string,
    filePath: string,
  ): string {
    if (oldContent === newContent) {
      return "";
    }

    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");

    // Simple line-based diff algorithm
    const hunks = this.computeHunks(oldLines, newLines);

    if (hunks.length === 0) {
      return "";
    }

    let diff = `--- a/${filePath}\n`;
    diff += `+++ b/${filePath}\n`;

    for (const hunk of hunks) {
      diff += `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@\n`;
      for (const line of hunk.lines) {
        diff += line;
      }
    }

    return diff;
  }

  /**
   * Compare existing file with new content and generate diff
   * @param filePath Path to the file
   * @param newContent The new content
   * @returns Unified diff format string
   */
  static async generateWriteDiff(
    filePath: string,
    newContent: string,
  ): Promise<string> {
    try {
      const oldContent = await fs.readFile(filePath, "utf-8");
      return this.generateUnifiedDiff(oldContent, newContent, filePath);
    } catch {
      // File doesn't exist, treat as new file
      const lines = newContent.split("\n").map((line) => `+${line}\n`);
      let diff = `--- /dev/null\n`;
      diff += `+++ b/${filePath}\n`;
      diff += `@@ -0,0 +1,${lines.length} @@\n`;
      diff += lines.join("");
      return diff;
    }
  }

  /**
   * Generate edit diff showing old_string → new_string replacement in context
   * @param filePath Path to the file
   * @param oldString The string to be replaced
   * @param newString The replacement string
   * @param fileContent The full file content
   * @returns Edit diff format string showing context
   */
  static generateEditDiff(
    filePath: string,
    oldString: string,
    newString: string,
    fileContent: string,
  ): string {
    const lines = fileContent.split("\n");

    // Find start line by locating oldString in the full content
    const pos = fileContent.indexOf(oldString);
    if (pos === -1) {
      return "";
    }

    // Count newlines before pos to find startLine
    const beforePos = fileContent.substring(0, pos);
    const startLine = beforePos.split("\n").length - 1;

    // Count lines spanned by oldString
    const oldStringLines = oldString.split("\n").length;
    const endLine = startLine + oldStringLines - 1;

    // Calculate context (3 lines before/after)
    const contextBefore = 3;
    const contextAfter = 3;

    const displayStart = Math.max(0, startLine - contextBefore);
    const displayEnd = Math.min(lines.length - 1, endLine + contextAfter);

    let diff = `--- a/${filePath}\n`;
    diff += `+++ b/${filePath}\n`;
    diff += `@@ -${displayStart + 1},${displayEnd - displayStart + 1} +${displayStart + 1},${displayEnd - displayStart + 1} @@\n`;

    // Add context before
    for (let i = displayStart; i < startLine; i++) {
      diff += ` ${lines[i]}\n`;
    }

    // Add removed lines
    const oldLines = oldString.split("\n");
    for (const line of oldLines) {
      diff += `-${line}\n`;
    }

    // Add added lines
    const newLines = newString.split("\n");
    for (const line of newLines) {
      diff += `+${line}\n`;
    }

    // Add context after
    for (let i = endLine + 1; i <= displayEnd; i++) {
      diff += ` ${lines[i]}\n`;
    }

    return diff;
  }

  /**
   * Add ANSI color codes to diff for terminal output
   * @param diff The diff string
   * @returns Colorized diff string
   */
  static colorize(diff: string): string {
    const lines = diff.split("\n");
    const colored = lines
      .map((line) => {
        if (line.startsWith("---") || line.startsWith("+++")) {
          // Cyan for file headers
          return `\x1b[36m${line}\x1b[0m`;
        } else if (line.startsWith("@@")) {
          // Cyan for hunk headers
          return `\x1b[36m${line}\x1b[0m`;
        } else if (line.startsWith("-")) {
          // Red for removed lines
          return `\x1b[31m${line}\x1b[0m`;
        } else if (line.startsWith("+")) {
          // Green for added lines
          return `\x1b[32m${line}\x1b[0m`;
        } else {
          // No color for context lines
          return line;
        }
      })
      .join("\n");

    return colored;
  }

  /**
   * Compute hunks for the diff
   * @param oldLines Original lines
   * @param newLines New lines
   * @returns Array of hunks
   */
  private static computeHunks(
    oldLines: string[],
    newLines: string[],
  ): Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: string[];
  }> {
    const hunks: Array<{
      oldStart: number;
      oldCount: number;
      newStart: number;
      newCount: number;
      lines: string[];
    }> = [];

    // Simple LCS-based diff (for simplicity, we use a basic algorithm)
    const diffLines = this.simpleDiff(oldLines, newLines);

    if (diffLines.length === 0) {
      return hunks;
    }

    let currentHunk: {
      oldStart: number;
      oldCount: number;
      newStart: number;
      newCount: number;
      lines: string[];
    } | null = null;
    let oldLineNum = 1;
    let newLineNum = 1;
    let contextCount = 0;

    for (const diffLine of diffLines) {
      const [type, line] = diffLine;

      // Determine if we need to start a new hunk
      if (currentHunk === null) {
        currentHunk = {
          oldStart: oldLineNum,
          oldCount: 0,
          newStart: newLineNum,
          newCount: 0,
          lines: [],
        };
      }

      if (type === "context") {
        currentHunk.lines.push(` ${line}\n`);
        currentHunk.oldCount++;
        currentHunk.newCount++;
        oldLineNum++;
        newLineNum++;
        contextCount++;
      } else if (type === "remove") {
        currentHunk.lines.push(`-${line}\n`);
        currentHunk.oldCount++;
        oldLineNum++;
        contextCount = 0;
      } else if (type === "add") {
        currentHunk.lines.push(`+${line}\n`);
        currentHunk.newCount++;
        newLineNum++;
        contextCount = 0;
      }

      // Close hunk if we have too much context
      if (contextCount > 6 && currentHunk.oldCount > 0) {
        hunks.push(currentHunk);
        currentHunk = null;
        contextCount = 0;
      }
    }

    if (currentHunk !== null && currentHunk.oldCount > 0) {
      hunks.push(currentHunk);
    }

    return hunks;
  }

  /**
   * Simple diff algorithm based on line comparison
   * @param oldLines Original lines
   * @param newLines New lines
   * @returns Array of [type, line] tuples
   */
  private static simpleDiff(
    oldLines: string[],
    newLines: string[],
  ): Array<["context" | "remove" | "add", string]> {
    const result: Array<["context" | "remove" | "add", string]> = [];
    // oldSet / newSet は将来の最適化用に予約（現在は未使用）
    const _oldSet = new Set(oldLines);
    const _newSet = new Set(newLines);
    void _oldSet; void _newSet;

    // Track which lines from oldLines appear in newLines
    let oldIdx = 0;
    let newIdx = 0;

    while (oldIdx < oldLines.length || newIdx < newLines.length) {
      if (oldIdx >= oldLines.length) {
        // Add remaining new lines
        result.push(["add", newLines[newIdx]]);
        newIdx++;
      } else if (newIdx >= newLines.length) {
        // Remove remaining old lines
        result.push(["remove", oldLines[oldIdx]]);
        oldIdx++;
      } else if (oldLines[oldIdx] === newLines[newIdx]) {
        // Lines match
        result.push(["context", oldLines[oldIdx]]);
        oldIdx++;
        newIdx++;
      } else {
        // Lines differ - try to find common lines ahead
        const oldNextMatch = oldLines.indexOf(newLines[newIdx], oldIdx + 1);
        const newNextMatch = newLines.indexOf(oldLines[oldIdx], newIdx + 1);

        if (
          oldNextMatch !== -1 &&
          (newNextMatch === -1 || oldNextMatch <= newNextMatch)
        ) {
          // Remove lines until we find a match
          result.push(["remove", oldLines[oldIdx]]);
          oldIdx++;
        } else if (newNextMatch !== -1) {
          // Add lines until we find a match
          result.push(["add", newLines[newIdx]]);
          newIdx++;
        } else {
          // No clear match ahead, treat as replace
          result.push(["remove", oldLines[oldIdx]]);
          result.push(["add", newLines[newIdx]]);
          oldIdx++;
          newIdx++;
        }
      }
    }

    return result;
  }
}
