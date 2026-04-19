import { resolve as pathResolve, isAbsolute as pathIsAbsolute } from "path";
import { Tool, ToolContext, ToolResult } from "../types/index.js";

export abstract class BaseTool implements Tool {
  abstract name: string;
  abstract description: string;
  abstract parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  abstract riskLevel: "LOW" | "MEDIUM" | "HIGH";

  /**
   * Phase 29: `ToolRegistry.setContext()` 経由で注入される実行コンテキスト。
   * `basePath` が設定されていれば相対パス解決・子プロセスの `cwd` に使う。
   * 未設定時は `process.cwd()` にフォールバックする。
   */
  protected context?: ToolContext;

  /** コンテキストを設定する (Phase 29, ToolRegistry から呼ばれる) */
  setContext(ctx: ToolContext): void {
    this.context = ctx;
  }

  /**
   * 現在有効な basePath を返す。
   * `ToolContext` が設定されていればその `basePath`、無ければ `process.cwd()`。
   */
  protected resolveBasePath(): string {
    return this.context?.basePath ?? process.cwd();
  }

  /**
   * 相対パスを現在の basePath 基準で絶対パスに解決する。
   * 絶対パスはそのまま返す。
   */
  protected resolvePath(p: string): string {
    if (pathIsAbsolute(p)) return p;
    return pathResolve(this.resolveBasePath(), p);
  }

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
   * シェルインジェクション対策として、こちらを優先して使用する。
   *
   * Phase 29: `cwd` を明示せずに呼ばれた場合、`ToolContext.basePath`
   * （または `process.cwd()`）を cwd として spawn する。
   */
  protected async runCommandSafe(
    command: string,
    args: string[],
    timeout: number = 15000,
    cwd?: string,
  ): Promise<string> {
    const { spawn } = await import("child_process");

    return new Promise((resolve, reject) => {
      let output = "";
      let errorOutput = "";

      const proc = spawn(command, args, {
        shell: false,
        timeout,
        cwd: cwd ?? this.resolveBasePath(),
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
   *
   * Phase 29: spawn の cwd を `ToolContext.basePath`（または
   * `process.cwd()`）に明示指定する。
   */
  protected async runCommand(
    command: string,
    timeout: number = 15000,
    cwd?: string,
  ): Promise<string> {
    const { spawn } = await import("child_process");

    return new Promise((resolve, reject) => {
      let output = "";
      let errorOutput = "";

      const proc = spawn(command, {
        shell: true,
        timeout,
        cwd: cwd ?? this.resolveBasePath(),
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
