import { AgentLoop } from "./AgentLoop.js";
import { ILLMProvider } from "../providers/LLMProvider.js";
import {
  SubAgentConfig,
  SubAgentResult,
  SubAgentRole,
} from "../types/index.js";

// Role-based tool permissions
const ROLE_TOOL_PERMISSIONS: Record<SubAgentRole, { allowed: string[] }> = {
  explorer: {
    allowed: ["read_file", "glob", "grep", "git"],
  },
  worker: {
    allowed: [
      "read_file",
      "write_file",
      "edit_file",
      "glob",
      "grep",
      "bash",
      "git",
    ],
  },
  reviewer: {
    allowed: ["read_file", "glob", "grep", "bash", "git"],
  },
  // ---- パイプライン専用ロール ----
  planner: {
    // 読み取り専用。既存コードを分析して実装計画を策定する
    allowed: ["read_file", "glob", "grep", "git"],
  },
  coder: {
    // ファイルの作成・編集が可能。実装を担当する
    allowed: [
      "read_file",
      "write_file",
      "edit_file",
      "glob",
      "grep",
      "bash",
      "git",
    ],
  },
  tester: {
    // テストの実行と確認が可能。ファイル変更はしない
    allowed: ["read_file", "glob", "grep", "bash", "git"],
  },
};

export class SubAgentManager {
  private llmProvider: ILLMProvider;
  private basePath: string;
  private maxConcurrent: number;

  constructor(
    llmProvider: ILLMProvider,
    basePath: string,
    maxConcurrent?: number,
  ) {
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
      const timeout = config.timeout ?? 120000;

      const result = await this.executeWithTimeout(
        agent.processUserInput(fullTask),
        timeout,
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
      const isTimeout =
        error instanceof Error && error.message === "Sub-agent timeout";
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
        batch.map((config) => this.spawn(config)),
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
      // ---- パイプライン専用ロール ----
      case "planner":
        return `You are a PLANNER agent in a multi-agent pipeline.
Your job is to ANALYZE the task and produce a detailed, structured implementation plan.
You can use: read_file, glob, grep, git (read-only access).
You CANNOT modify any files.

Output format — return a structured plan with these sections:
1. Task Summary: brief description of what needs to be done
2. Files to Create/Modify: list each file with its purpose
3. Implementation Steps: numbered step-by-step instructions for the Coder agent
4. Test Criteria: what the Tester agent should verify
5. Review Checklist: what the Reviewer agent should check

Be specific and actionable. The Coder agent will follow your plan exactly.`;
      case "coder":
        return `You are a CODER agent in a multi-agent pipeline.
Your job is to IMPLEMENT the code according to the plan provided.
You can use: read_file, write_file, edit_file, glob, grep, bash, git.

Guidelines:
- Follow the implementation plan precisely
- Write clean, well-typed TypeScript code
- Add JSDoc comments for public APIs
- Handle error cases and edge conditions
- If a previous test run failed, fix the reported issues

After completing, output a summary of:
- Files created/modified
- Key design decisions
- Any deviations from the plan and why`;
      case "tester":
        return `You are a TESTER agent in a multi-agent pipeline.
Your job is to VERIFY the code implemented by the Coder agent.
You can use: read_file, glob, grep, bash, git (no file modification).

Your responsibilities:
1. Review the implemented code for correctness
2. Run existing tests: use bash to execute test commands
3. Check that test criteria from the plan are met
4. Report any failures with specific details

Output format:
- PASSED or FAILED status
- Test results summary
- List of issues found (if any) with file:line references
- Specific fix instructions for the Coder agent (if FAILED)`;
    }
  }

  getAllowedTools(role: SubAgentRole): string[] {
    return ROLE_TOOL_PERMISSIONS[role].allowed;
  }

  private async executeWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Sub-agent timeout")), timeoutMs),
      ),
    ]);
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
      arr.slice(i * size, i * size + size),
    );
  }
}
