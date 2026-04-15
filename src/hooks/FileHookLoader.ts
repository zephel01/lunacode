import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { HookManager } from "./HookManager.js";
import { HookContext, HookEvent } from "../types/index.js";

const execAsync = promisify(exec);

interface FileHookConfig {
  name: string;
  event: string | string[];
  command: string;
  condition?: {
    toolName?: string[];
    filePattern?: string;
  };
  priority?: number;
}

export class FileHookLoader {
  async load(basePath: string, hookManager: HookManager): Promise<number> {
    const hooksPath = path.join(basePath, ".kairos", "hooks.json");

    // Check if hooks.json exists
    let content: string;
    try {
      content = await fs.readFile(hooksPath, "utf-8");
    } catch {
      // hooks.json doesn't exist — not an error
      return 0;
    }

    // Parse JSON (throws on invalid JSON so callers know config is broken)
    const config = JSON.parse(content) as { hooks: FileHookConfig[] };

    if (!config.hooks || !Array.isArray(config.hooks)) {
      return 0;
    }

    for (const hookConfig of config.hooks) {
      hookManager.register({
        name: hookConfig.name,
        event: hookConfig.event as HookEvent,
        priority: hookConfig.priority,
        handler: async (context: HookContext) => {
          // Condition check: toolName
          if (hookConfig.condition?.toolName) {
            if (
              !context.toolName ||
              !hookConfig.condition.toolName.includes(context.toolName)
            ) {
              return;
            }
          }
          // Condition check: filePattern (simple suffix match)
          if (hookConfig.condition?.filePattern) {
            const filePath = context.toolArgs?.path as string;
            if (!filePath) return;
            const pattern = hookConfig.condition.filePattern;
            if (pattern.startsWith("*")) {
              const ext = pattern.slice(1);
              if (!filePath.endsWith(ext)) return;
            }
          }

          // Execute shell command with variable interpolation
          const command = this.interpolate(hookConfig.command, context);
          try {
            const { stdout, stderr } = await execAsync(command, {
              cwd: basePath,
              timeout: 30000,
            });
            if (stdout.trim())
              console.log(`[Hook: ${hookConfig.name}] ${stdout.trim()}`);
            if (stderr.trim())
              console.warn(`[Hook: ${hookConfig.name}] ${stderr.trim()}`);
          } catch (error) {
            console.error(`[Hook: ${hookConfig.name}] Command failed:`, error);
          }
        },
      });
    }

    return config.hooks.length;
  }

  private interpolate(template: string, context: HookContext): string {
    return template
      .replace(/\$\{filePath\}/g, (context.toolArgs?.path as string) || "")
      .replace(/\$\{toolName\}/g, context.toolName || "")
      .replace(/\$\{sessionId\}/g, context.sessionId || "");
  }
}
