import { runGit } from "../utils/gitRunner.js";
import * as fs from "fs";
import * as path from "path";

/**
 * Checkpoint interface representing a saved state with git
 */
export interface Checkpoint {
  id: string; // Format: cp-{iteration}-{timestamp}
  iteration: number;
  timestamp: number;
  description: string;
  commitHash: string;
  filesChanged: string[];
}

/**
 * Configuration for CheckpointManager
 */
export interface CheckpointManagerConfig {
  enabled: boolean;
  strategy: "stash" | "branch";
  maxCheckpoints: number;
  autoCheckpoint: boolean;
}

/**
 * Checkpoint Manager for git-based checkpoint system
 * Manages checkpoint creation, rollback, and cleanup
 */
export class CheckpointManager {
  private basePath: string;
  private config: CheckpointManagerConfig;
  private checkpoints: Checkpoint[] = [];
  private sessionBranch: string = "";
  private originalBranch: string = "";

  constructor(basePath: string, config?: Partial<CheckpointManagerConfig>) {
    this.basePath = basePath;
    this.config = {
      enabled: true,
      strategy: "branch",
      maxCheckpoints: 20,
      autoCheckpoint: true,
      ...config,
    };
  }

  /**
   * Initialize the checkpoint system
   * Verify .git exists or create it
   * For branch strategy, create a working branch
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    try {
      // Check if .git exists
      const gitPath = path.join(this.basePath, ".git");
      if (!fs.existsSync(gitPath)) {
        // Initialize git repo
        await this.executeGitAsync(["init"]);
        // Set up initial commit
        try {
          await this.executeGitAsync(["config", "user.email", "checkpoint@lunacode.local"]);
          await this.executeGitAsync(["config", "user.name", "LunaCode Checkpoint"]);
          // Create initial commit
          await this.executeGitAsync(["add", "-A"]);
          await this.executeGitAsync(["commit", "-m", "Initial checkpoint", "--allow-empty"]);
        } catch (e) {
          // Ignore initial setup errors
        }
      }

      // Get current branch for restoration later
      try {
        this.originalBranch = (
          await this.executeGitAsync(["rev-parse", "--abbrev-ref", "HEAD"])
        ).trim();
      } catch (e) {
        this.originalBranch = "main";
      }

      // For branch strategy, create a session branch
      if (this.config.strategy === "branch") {
        const sessionTimestamp = Date.now();
        this.sessionBranch = `lunacode/session-${sessionTimestamp}`;
        try {
          await this.executeGitAsync(["checkout", "-b", this.sessionBranch]);
        } catch (e) {
          // Branch might already exist, try to checkout
          try {
            await this.executeGitAsync(["checkout", this.sessionBranch]);
          } catch (e2) {
            // Create it from current branch
            await this.executeGitAsync(["checkout", "-b", this.sessionBranch]);
          }
        }
      }
    } catch (e) {
      if (this.config.enabled) {
        console.error("Failed to initialize checkpoint manager:", e);
      }
    }
  }

  /**
   * Create a new checkpoint
   * Checks if there are changes, creates a commit with description
   * Prunes old checkpoints if needed
   */
  async create(description: string): Promise<Checkpoint | null> {
    if (!this.config.enabled) {
      return null;
    }

    try {
      // Check if there are changes
      const status = await this.executeGitAsync(["status", "--porcelain"]);
      if (!status.trim()) {
        // No changes, skip checkpoint
        return null;
      }

      // Generate checkpoint ID
      const iteration = this.checkpoints.length + 1;
      const timestamp = Date.now();
      const checkpointId = `cp-${iteration}-${timestamp}`;

      // Stage and commit all changes
      await this.executeGitAsync(["add", "-A"]);
      const commitMsg = `${checkpointId}: ${description}`;
      await this.executeGitAsync(["commit", "--no-verify", "-m", commitMsg]);

      // Get commit hash
      const commitHash = (
        await this.executeGitAsync(["rev-parse", "HEAD"])
      ).trim();

      // Get list of changed files
      const diffOutput = await this.executeGitAsync([
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        commitHash,
      ]);
      const filesChanged = diffOutput
        .trim()
        .split("\n")
        .filter((f) => f);

      // Create checkpoint object
      const checkpoint: Checkpoint = {
        id: checkpointId,
        iteration,
        timestamp,
        description,
        commitHash,
        filesChanged,
      };

      this.checkpoints.push(checkpoint);

      // Prune old checkpoints if needed
      if (this.checkpoints.length > this.config.maxCheckpoints) {
        await this.pruneOldCheckpoints();
      }

      return checkpoint;
    } catch (e) {
      console.error("Failed to create checkpoint:", e);
      return null;
    }
  }

  /**
   * Rollback to a specific checkpoint
   * Resets to the checkpoint's commit hash
   * Removes all later checkpoints
   */
  async rollback(checkpointId: string): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    try {
      const checkpoint = this.checkpoints.find((cp) => cp.id === checkpointId);
      if (!checkpoint) {
        throw new Error(`Checkpoint ${checkpointId} not found`);
      }

      // Reset to checkpoint
      await this.executeGitAsync(["reset", "--hard", checkpoint.commitHash]);

      // Remove checkpoints after this one
      const checkpointIndex = this.checkpoints.findIndex(
        (cp) => cp.id === checkpointId,
      );
      this.checkpoints = this.checkpoints.slice(0, checkpointIndex + 1);

      return true;
    } catch (e) {
      console.error("Failed to rollback checkpoint:", e);
      return false;
    }
  }

  /**
   * Undo to the latest checkpoint
   * Equivalent to rollback to the previous checkpoint
   */
  async undo(): Promise<boolean> {
    if (!this.config.enabled || this.checkpoints.length === 0) {
      return false;
    }

    try {
      // Restore to the last checkpoint's state
      const latestCheckpoint = this.checkpoints[this.checkpoints.length - 1];
      await this.executeGitAsync(["reset", "--hard", latestCheckpoint.commitHash]);
      return true;
    } catch (e) {
      console.error("Failed to undo:", e);
      return false;
    }
  }

  /**
   * List all checkpoints
   */
  list(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /**
   * Get diff between two checkpoints
   */
  async diff(fromId: string, toId?: string): Promise<string> {
    if (!this.config.enabled) {
      return "";
    }

    try {
      const fromCheckpoint = this.checkpoints.find((cp) => cp.id === fromId);
      if (!fromCheckpoint) {
        throw new Error(`Checkpoint ${fromId} not found`);
      }

      let toHash = "HEAD";
      if (toId) {
        const toCheckpoint = this.checkpoints.find((cp) => cp.id === toId);
        if (!toCheckpoint) {
          throw new Error(`Checkpoint ${toId} not found`);
        }
        toHash = toCheckpoint.commitHash;
      }

      return await this.executeGitAsync(["diff", `${fromCheckpoint.commitHash}..${toHash}`]);
    } catch (e) {
      console.error("Failed to get diff:", e);
      return "";
    }
  }

  /**
   * Cleanup - switch back to original branch if using branch strategy
   */
  async cleanup(): Promise<void> {
    if (!this.config.enabled || this.config.strategy !== "branch") {
      return;
    }

    try {
      if (this.originalBranch && this.originalBranch !== this.sessionBranch) {
        try {
          await this.executeGitAsync(["checkout", this.originalBranch]);
        } catch (e) {
          console.warn("Failed to switch back to original branch:", e);
        }
      }
    } catch (e) {
      console.warn("Cleanup failed:", e);
    }
  }

  /**
   * Execute git command asynchronously
   */
  private async executeGitAsync(args: string[]): Promise<string> {
    return runGit(args, { cwd: this.basePath });
  }

  /**
   * Prune old checkpoints beyond maxCheckpoints limit
   * Keeps the most recent maxCheckpoints checkpoints
   */
  private async pruneOldCheckpoints(): Promise<void> {
    try {
      const toRemove = this.checkpoints.length - this.config.maxCheckpoints;
      if (toRemove <= 0) {
        return;
      }

      // Remove oldest checkpoints (keep the most recent ones)
      this.checkpoints = this.checkpoints.slice(toRemove);
    } catch (e) {
      console.warn("Failed to prune old checkpoints:", e);
    }
  }

  /**
   * Get checkpoint statistics
   */
  getStats(): {
    total: number;
    oldest: Checkpoint | null;
    newest: Checkpoint | null;
  } {
    return {
      total: this.checkpoints.length,
      oldest: this.checkpoints[0] || null,
      newest: this.checkpoints[this.checkpoints.length - 1] || null,
    };
  }
}
