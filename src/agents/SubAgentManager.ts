import { AgentLoop } from "./AgentLoop.js";
import { ILLMProvider } from "../providers/LLMProvider.js";
import { SubAgentConfig, SubAgentResult, SubAgentRole } from "../types/index.js";

// Role-based tool permissions
const ROLE_TOOL_PERMISSIONS: Record<SubAgentRole, { allowed: string[] }> = {
  explorer: {
    allowed: ["read_file", "glob", "grep", "git"],
  },
  worker: {
    allowed: ["read_file", "write_file", "edit_file", "glob", "grep", "bash", "git"],
  },
  reviewer: {
    allowed: ["read_file", "glob", "grep", "bash", "git"],
  },
};

export class SubAgentManager {
  private llmProvider: ILLMProvider;
  private basePath: string;
  private maxConcurrent: number;

  constructor(llmProvider: ILLMProvider, basePath: string, maxConcurrent?: number) {
    this.llmProvider = llmProvider;
    this.basePath = basePath;
    this.maxConcurrent = maxConcurrent ?? 3;
  }

  // Spawn a single sub-agent
  async spawn(config: SubAgentConfig): Promise<SubAgentResult> {
    const id = config.id || `sub-${config.role}-${Date.now()}`;
    const startTime = Date.now();
    const toolsUsed: string[] = [];
    const filesModified: string[] = [];

    try {
      // Create a new AgentLoop with restricted tools (no delegate_task to prevent recursion)
      const allowedTools = ROLE_TOOL_PERMISSIONS[config.role].allowed;
      const agent = new AgentLoop(this.llmProvider, this.basePath, undefined, {
        isSubAgent: true,
        allowedTools,
      });
      await agent.initialize();

      // Build role-specific system context
      const rolePrompt = this.getRolePrompt(config.role);
      const fullTask = `${rolePrompt}\n\nTask: ${config.task}`;

      // Execute with timeout
      const maxIterations = config.maxIterations ?? 10;
      const timeout = config.timeout ?? 120000;

      const result = await this.executeWithTimeout(
        agent.processUserInput(fullTask),
        timeout
      );

      return {
        id,
        role: config.role,
        task: config.task,
        status: "completed",
        output: result,
        filesModified,
        toolsUsed,
        iterations: agent.getState().iteration,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const isTimeout = error instanceof Error && error.message === "Sub-agent timeout";
      return {
        id,
        role: config.role,
        task: config.task,
        status: isTimeout ? "timeout" : "failed",
        output: "",
        filesModified,
        toolsUsed,
        iterations: 0,
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Spawn multiple sub-agents in parallel (respecting maxConcurrent)
  async spawnParallel(configs: SubAgentConfig[]): Promise<SubAgentResult[]> {
    const results: SubAgentResult[] = [];
    const batches = this.chunk(configs, this.maxConcurrent);

    for (const batch of batches) {
      const batchResults = await Promise.allSettled(
        batch.map(config => this.spawn(config))
      );

      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          results.push({
            id: `sub-error-${Date.now()}`,
            role: "worker",
            task: "unknown",
            status: "failed",
            output: "",
            filesModified: [],
            toolsUsed: [],
            iterations: 0,
            durationMs: 0,
            error: result.reason?.message || "Unknown error",
          });
        }
      }
    }

    return results;
  }

  private getRolePrompt(role: SubAgentRole): string {
    switch (role) {
      case "explorer":
        return `You are an EXPLORER sub-agent. Your job is to READ and ANALYZE code.
You can use: read_file, glob, grep, git.
You CANNOT modify any files. Focus on understanding and reporting findings.`;
      case "worker":
        return `You are a WORKER sub-agent. Your job is to IMPLEMENT changes.
You can use: read_file, write_file, edit_file, glob, grep, bash, git.
Focus on completing the assigned task efficiently.`;
      case "reviewer":
        return `You are a REVIEWER sub-agent. Your job is to REVIEW and TEST code.
You can use: read_file, glob, grep, bash, git.
You CANNOT modify files directly. Use bash only for running tests.
Focus on finding issues and providing feedback.`;
    }
  }

  getAllowedTools(role: SubAgentRole): string[] {
    return ROLE_TOOL_PERMISSIONS[role].allowed;
  }

  private async executeWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Sub-agent timeout")), timeoutMs)
      ),
    ]);
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
      arr.slice(i * size, i * size + size)
    );
  }
}
