import { Tool } from "../types/index.js";
import {
  BashTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  GitTool,
} from "./BasicTools.js";
import {
  GitStatusTool,
  GitDiffTool,
  GitCommitTool,
  GitApplyTool,
  GitLogTool,
} from "./GitTools.js";
import { MultiFileEditTool } from "./MultiFileEditTool.js";
import { TestRunnerTool } from "./TestRunnerTool.js";

export class ToolRegistry {
  private tools: Map<string, Tool>;

  constructor() {
    this.tools = new Map();
    this.registerDefaultTools();
  }

  private registerDefaultTools(): void {
    this.register(new BashTool());
    this.register(new FileReadTool());
    this.register(new FileWriteTool());
    this.register(new FileEditTool());
    this.register(new GlobTool());
    this.register(new GrepTool());
    this.register(new GitTool());

    // Phase 20: マルチファイル同時編集
    this.register(new MultiFileEditTool());

    // Phase 21: テスト実行ツール
    this.register(new TestRunnerTool());

    // Phase 18: Git ツール強化
    this.register(new GitStatusTool());
    this.register(new GitDiffTool());
    this.register(new GitCommitTool());
    this.register(new GitApplyTool());
    this.register(new GitLogTool());
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  getByName(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getToolDescriptions(): string {
    const descriptions = this.getAll().map((tool) => {
      return `- ${tool.name}: ${tool.description}`;
    });
    return descriptions.join("\n");
  }

  /**
   * 許可されたツール名リストでフィルタリング（サブエージェント用）
   * リストにないツールは除去される
   */
  filterByAllowed(allowedNames: string[]): void {
    const allowed = new Set(allowedNames);
    for (const name of this.tools.keys()) {
      if (!allowed.has(name)) {
        this.tools.delete(name);
      }
    }
  }

  async executeTool(name: string, params: unknown) {
    const tool = this.get(name);
    if (!tool) {
      const availableTools = this.getAll()
        .map((t) => t.name)
        .join(", ");
      return {
        success: false,
        output: "",
        error: `Tool "${name}" is not available. Available tools: ${availableTools}`,
      };
    }
    return tool.execute(params);
  }
}
