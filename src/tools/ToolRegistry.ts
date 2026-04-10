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

  async executeTool(name: string, params: unknown) {
    const tool = this.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    return tool.execute(params);
  }
}
