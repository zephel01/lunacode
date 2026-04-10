import { Tool, ToolResult } from "../types/index.js";

export abstract class BaseTool implements Tool {
  abstract name: string;
  abstract description: string;
  abstract parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  abstract riskLevel: "LOW" | "MEDIUM" | "HIGH";

  abstract execute(params: unknown): Promise<ToolResult>;

  protected validateParams(params: unknown, required: string[]): void {
    if (!params || typeof params !== "object") {
      throw new Error("Parameters must be an object");
    }

    for (const key of required) {
      if (!(key in params)) {
        throw new Error(`Missing required parameter: ${key}`);
      }
    }
  }

  /**
   * 安全なコマンド実行（引数配列方式、shell: false）
   * シェルインジェクション対策として、こちらを優先して使用する
   */
  protected async runCommandSafe(
    command: string,
    args: string[],
    timeout: number = 15000,
  ): Promise<string> {
    const { spawn } = await import("child_process");

    return new Promise((resolve, reject) => {
      let output = "";
      let errorOutput = "";

      const proc = spawn(command, args, {
        shell: false,
        timeout,
      });

      proc.stdout?.on("data", (data: Buffer) => {
        output += data.toString();
      });

      proc.stderr?.on("data", (data: Buffer) => {
        errorOutput += data.toString();
      });

      proc.on("close", (code: number | null) => {
        if (code !== 0) {
          reject(new Error(errorOutput || `Command failed with code ${code}`));
        } else {
          resolve(output);
        }
      });

      proc.on("error", (err: Error) => {
        reject(err);
      });
    });
  }

  /**
   * @deprecated shell: true を使用するため、ユーザー入力を含む場合は runCommandSafe を使用すること
   */
  protected async runCommand(
    command: string,
    timeout: number = 15000,
  ): Promise<string> {
    const { spawn } = await import("child_process");

    return new Promise((resolve, reject) => {
      let output = "";
      let errorOutput = "";

      const proc = spawn(command, {
        shell: true,
        timeout,
      });

      proc.stdout?.on("data", (data) => {
        output += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        errorOutput += data.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(errorOutput || `Command failed with code ${code}`));
        } else {
          resolve(output);
        }
      });

      proc.on("error", (err) => {
        reject(err);
      });
    });
  }
}
