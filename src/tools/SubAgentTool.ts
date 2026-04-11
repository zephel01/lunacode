import { Tool, ToolResult, SubAgentConfig } from "../types/index.js";
import { SubAgentManager } from "../agents/SubAgentManager.js";

export class SubAgentTool implements Tool {
  name = "delegate_task";
  description = `Delegate sub-tasks to specialized sub-agents for parallel execution.
Each sub-task runs in an independent context with role-based tool restrictions.
Roles:
- "explorer": Read-only analysis (read_file, glob, grep, git)
- "worker": Full read/write access (all tools including bash)
- "reviewer": Review & test only (read_file, glob, grep, bash for tests, git)

Use this when a task can be broken into independent parts that don't depend on each other's output.

Example tool call:
<tool_call>
{"name": "delegate_task", "arguments": {"tasks": [{"role": "explorer", "task": "Analyze the project structure"}, {"role": "worker", "task": "Create a new utility function"}]}}
</tool_call>`;

  parameters = {
    type: "object" as const,
    properties: {
      tasks: {
        type: "array",
        description: "Array of independent sub-tasks to execute in parallel",
        items: {
          type: "object",
          properties: {
            role: {
              type: "string",
              enum: ["explorer", "worker", "reviewer"],
              description: "Sub-agent role determining tool access",
            },
            task: {
              type: "string",
              description: "Clear, self-contained description of what to do",
            },
          },
          required: ["role", "task"],
        },
      },
    },
    required: ["tasks"],
  };

  riskLevel = "MEDIUM" as const;

  private manager: SubAgentManager;

  constructor(manager: SubAgentManager) {
    this.manager = manager;
  }

  async execute(params: unknown): Promise<ToolResult> {
    const { tasks } = params as { tasks: SubAgentConfig[] };

    if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
      return { success: false, output: "", error: "No tasks provided" };
    }

    if (tasks.length > 6) {
      return { success: false, output: "", error: "Maximum 6 sub-tasks allowed" };
    }

    console.log(`🚀 Spawning ${tasks.length} sub-agent(s)...`);

    const results = await this.manager.spawnParallel(tasks);

    const summary = results.map((r, i) => {
      const statusIcon = r.status === "completed" ? "✅" : r.status === "timeout" ? "⏰" : "❌";
      return `### Sub-agent ${i + 1} [${r.role}] ${statusIcon} ${r.status}
Task: ${r.task}
Duration: ${r.durationMs}ms | Iterations: ${r.iterations}
${r.output ? `\nOutput:\n${r.output.substring(0, 1000)}${r.output.length > 1000 ? "\n...(truncated)" : ""}` : ""}${r.error ? `\nError: ${r.error}` : ""}`;
    }).join("\n\n---\n\n");

    const completedCount = results.filter(r => r.status === "completed").length;
    const allCompleted = completedCount === results.length;
    const failedDetails = results
      .filter(r => r.status !== "completed")
      .map(r => `[${r.role}] ${r.status}: ${r.error || "no output"}`)
      .join("; ");

    return {
      success: allCompleted,
      output: `# Sub-agent Results (${completedCount}/${results.length} completed)\n\n${summary}`,
      error: allCompleted ? undefined : `${results.length - completedCount} sub-agent(s) failed: ${failedDetails}`,
    };
  }
}
