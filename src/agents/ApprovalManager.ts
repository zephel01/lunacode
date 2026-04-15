import { DiffGenerator } from "./DiffGenerator.js";

/**
 * Approval mode determines how requests are handled
 * - "auto": All requests are automatically approved
 * - "confirm": All requests require user confirmation
 * - "selective": Different risk levels have different handling
 */
export type ApprovalMode = "auto" | "confirm" | "selective";

/**
 * Result of an approval request
 * - "approved": Request was approved
 * - "rejected": Request was rejected
 * - "edited": Request was approved but args were edited
 */
export type ApprovalResult = "approved" | "rejected" | "edited";

/**
 * Configuration for approval behavior
 */
export interface ApprovalConfig {
  mode: ApprovalMode;
  showDiff: boolean; // Whether to show diffs in approval requests
  autoApproveReadOnly: boolean; // Auto-approve read-only operations in selective mode
  timeoutSeconds: number; // 0 = unlimited
}

/**
 * Request for approval of a tool execution
 */
export interface ApprovalRequest {
  toolName: string;
  args: Record<string, unknown>;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  diff?: string; // Optional diff for write operations
  description: string; // Human-readable description
}

/**
 * Callbacks for approval handling
 */
export interface ApprovalCallbacks {
  requestApproval: (request: ApprovalRequest) => Promise<{
    result: ApprovalResult;
    editedArgs?: Record<string, unknown>;
  }>;
}

/**
 * Manages approval of tool executions based on risk level and configuration
 */
export class ApprovalManager {
  private config: ApprovalConfig;
  private callbacks: ApprovalCallbacks;
  private stats: {
    approved: number;
    rejected: number;
    autoApproved: number;
  };

  constructor(config: ApprovalConfig, callbacks: ApprovalCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
    this.stats = {
      approved: 0,
      rejected: 0,
      autoApproved: 0,
    };
  }

  /**
   * Check if a tool execution requires approval and request if necessary
   * @param toolName Name of the tool
   * @param args Arguments passed to the tool
   * @param riskLevel Risk level of the operation
   * @returns Object with approval status and potentially modified args
   */
  async checkApproval(
    toolName: string,
    args: Record<string, unknown>,
    riskLevel: string,
  ): Promise<{
    approved: boolean;
    args: Record<string, unknown>;
  }> {
    // Mode: auto - always approve
    if (this.config.mode === "auto") {
      this.stats.autoApproved++;
      return { approved: true, args };
    }

    // Mode: confirm - always request approval
    if (this.config.mode === "confirm") {
      const description = this.generateDescription(toolName, args);
      const request: ApprovalRequest = {
        toolName,
        args,
        riskLevel: riskLevel as "LOW" | "MEDIUM" | "HIGH",
        description,
      };

      const response = await this.callbacks.requestApproval(request);

      if (response.result === "approved") {
        this.stats.approved++;
        return { approved: true, args: response.editedArgs || args };
      } else if (response.result === "edited") {
        this.stats.approved++;
        return { approved: true, args: response.editedArgs || args };
      } else {
        this.stats.rejected++;
        return { approved: false, args };
      }
    }

    // Mode: selective
    const riskLevel_ = riskLevel as "LOW" | "MEDIUM" | "HIGH";

    // LOW risk + read-only tools: auto-approve
    if (
      riskLevel_ === "LOW" &&
      this.isReadOnlyTool(toolName) &&
      this.config.autoApproveReadOnly
    ) {
      this.stats.autoApproved++;
      return { approved: true, args };
    }

    // MEDIUM risk (write_file, edit_file): generate diff and request approval
    if (riskLevel_ === "MEDIUM") {
      const description = this.generateDescription(toolName, args);
      let diff: string | undefined;

      if (this.config.showDiff) {
        diff = await this.generateDiffForTool(toolName, args);
      }

      const request: ApprovalRequest = {
        toolName,
        args,
        riskLevel: riskLevel_,
        diff,
        description,
      };

      const response = await this.callbacks.requestApproval(request);

      if (response.result === "approved") {
        this.stats.approved++;
        return { approved: true, args: response.editedArgs || args };
      } else if (response.result === "edited") {
        this.stats.approved++;
        return { approved: true, args: response.editedArgs || args };
      } else {
        this.stats.rejected++;
        return { approved: false, args };
      }
    }

    // HIGH risk (bash, etc.): always request approval
    if (riskLevel_ === "HIGH") {
      const description = this.generateDescription(toolName, args);
      const request: ApprovalRequest = {
        toolName,
        args,
        riskLevel: riskLevel_,
        description,
      };

      const response = await this.callbacks.requestApproval(request);

      if (response.result === "approved") {
        this.stats.approved++;
        return { approved: true, args: response.editedArgs || args };
      } else if (response.result === "edited") {
        this.stats.approved++;
        return { approved: true, args: response.editedArgs || args };
      } else {
        this.stats.rejected++;
        return { approved: false, args };
      }
    }

    // Default: auto-approve
    this.stats.autoApproved++;
    return { approved: true, args };
  }

  /**
   * Identify if a tool is read-only
   * @param toolName Name of the tool
   * @returns True if the tool is read-only
   */
  private isReadOnlyTool(toolName: string): boolean {
    // These tools don't modify state
    const readOnlyTools = [
      "read_file",
      "glob",
      "grep",
      "list_directory",
      "get_directory_structure",
      "file_exists",
    ];

    if (readOnlyTools.includes(toolName)) {
      return true;
    }

    // git tools (status, log, diff, show are read-only)
    if (toolName.startsWith("git_")) {
      const readOnlyGitOps = ["status", "log", "diff", "show", "branch"];
      return readOnlyGitOps.some((op) => toolName.includes(op));
    }

    return false;
  }

  /**
   * Generate a human-readable description of the tool execution
   * @param toolName Name of the tool
   * @param args Arguments passed to the tool
   * @returns Description string
   */
  private generateDescription(
    toolName: string,
    args: Record<string, unknown>,
  ): string {
    if (toolName === "write_file") {
      return `Write file: ${args.filePath}`;
    }
    if (toolName === "edit_file") {
      return `Edit file: ${args.filePath}`;
    }
    if (toolName === "read_file") {
      return `Read file: ${args.filePath}`;
    }
    if (toolName === "bash") {
      return `Execute command: ${args.command}`;
    }
    if (toolName === "glob") {
      return `Glob pattern: ${args.pattern}`;
    }
    if (toolName === "grep") {
      return `Search pattern: ${args.pattern} in ${args.path}`;
    }

    return `Execute ${toolName} with args: ${JSON.stringify(args)}`;
  }

  /**
   * Generate diff for write/edit operations
   * @param toolName Name of the tool
   * @param args Arguments passed to the tool
   * @returns Diff string or undefined
   */
  private async generateDiffForTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string | undefined> {
    if (toolName === "write_file") {
      const filePath = args.filePath as string;
      const content = args.content as string;
      try {
        return await DiffGenerator.generateWriteDiff(filePath, content);
      } catch {
        return undefined;
      }
    }

    if (toolName === "edit_file") {
      const filePath = args.filePath as string;
      const oldString = args.oldString as string;
      const newString = args.newString as string;

      try {
        // For edit_file, we'd need the file content
        // This is a simplified version - in practice, you'd read the file
        return DiffGenerator.generateEditDiff(
          filePath,
          oldString,
          newString,
          "",
        );
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  /**
   * Get approval statistics
   * @returns Stats object with approved/rejected/autoApproved counts
   */
  getStats(): typeof this.stats {
    return {
      ...this.stats,
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      approved: 0,
      rejected: 0,
      autoApproved: 0,
    };
  }
}
