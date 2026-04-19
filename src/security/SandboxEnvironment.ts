/**
 * @deprecated Phase 25 (2026-04-19) 以降はこのファイルのサンドボックスは使わないこと。
 *
 * 理由:
 *  - ルール判定が `command.includes(pattern)` のみ。`rm  -rf /`（二重空白）、
 *    `/bin/rm -rf /`、`$(echo rm) -rf /` など容易にバイパス可能
 *  - `allow` ルールは評価されていない（`deny` のみチェック）
 *  - `maxExecutionTime` は `console.warn` を出すだけで実際のプロセスを殺さない
 *  - `allowNetwork` / `maxMemoryUsage` は設定は受けるが何も強制していない
 *  - 「サンドボックス」と謳っているが実体は `cwd` と env 変数を渡すだけで、
 *    子プロセスから親ファイルシステムに完全アクセスできる
 *
 * 代わりに `src/sandbox/WorkspaceIsolator.ts`（Tier 1 作業ツリー分離）を使うこと。
 * プロセスレベル隔離が必要な場合は Phase 26 以降で追加される Tier 2 (container) /
 * Tier 3 (os-native) を待つこと。
 *
 * このクラスは後方互換のためだけに残っている。新規コードから呼び出さないこと。
 */

import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs/promises";

/**
 * @deprecated Phase 25: `src/sandbox/types.ts` の `SandboxConfig` を使うこと。
 */
export interface SandboxConfig {
  enabled: boolean;
  allowNetwork: boolean;
  allowedPaths: string[];
  allowedCommands: string[];
  maxExecutionTime: number; // ミリ秒
  maxMemoryUsage: number; // MB
}

/**
 * 実行結果
 */
export interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  executionTime: number;
  signal?: string;
}

/**
 * サンドボックスルール
 */
export interface SandboxRule {
  type: "allow" | "deny";
  pattern: string;
  reason?: string;
}

/**
 * サンドボックス環境
 *
 * @deprecated Phase 25: このクラスはセキュリティ機能として実効性が乏しい。
 * 詳細はファイル先頭の非推奨コメントを参照。新規コードは
 * `WorkspaceIsolator`（Tier 1）を使うこと。
 *
 * Phase 4.2: セキュリティ強化 - サンドボックス
 * - 安全な実行環境（注: 実際には cwd + env 変更のみ）
 * - アクセス制御（注: ルールが文字列 includes のみ）
 * - リソース制限（注: timeout / memory は未実装）
 */
export class SandboxEnvironment {
  private static warned = false;
  private config: SandboxConfig;
  private rules: SandboxRule[] = [];
  private sandboxPath: string;
  private executionHistory: Map<string, ExecutionResult> = new Map();

  constructor(config?: Partial<SandboxConfig>) {
    if (!SandboxEnvironment.warned) {
      SandboxEnvironment.warned = true;
      // LunaCode の他のモジュールと違い pino logger を持たないので、
      // ここは意図的に stderr へ直接出す。
      console.warn(
        "⚠️  [deprecated] SandboxEnvironment は Phase 25 で非推奨になりました。" +
          "ルール判定や timeout / memory 制限が実効性を持たないため、" +
          "セキュリティ境界として使わないでください。" +
          "代わりに src/sandbox/WorkspaceIsolator.ts (Tier 1) を使用してください。",
      );
    }

    this.config = {
      enabled: true,
      allowNetwork: false,
      allowedPaths: [],
      allowedCommands: [],
      maxExecutionTime: 30000, // 30秒
      maxMemoryUsage: 512, // 512MB
      ...config,
    };

    this.sandboxPath = path.join(process.cwd(), ".kairos", "sandbox");

    // デフォルトルールの設定
    this.setupDefaultRules();
  }

  /**
   * 初期化
   */
  async initialize(): Promise<void> {
    console.log("🔒 Initializing Sandbox Environment...");

    // サンドボックスディレクトリの作成
    await fs.mkdir(this.sandboxPath, { recursive: true });

    // サンドボックス内のディレクトリ構造を作成
    await this.setupSandboxStructure();

    console.log("✅ Sandbox Environment initialized");
  }

  /**
   * サンドボックス構造の設定
   */
  private async setupSandboxStructure(): Promise<void> {
    const directories = ["temp", "workspace", "logs", "cache"];

    for (const dir of directories) {
      await fs.mkdir(path.join(this.sandboxPath, dir), { recursive: true });
    }
  }

  /**
   * デフォルトルールの設定
   */
  private setupDefaultRules(): void {
    this.rules = [
      {
        type: "deny",
        pattern: "rm -rf /",
        reason: "Prevent destructive operations",
      },
      {
        type: "deny",
        pattern: "mkfs",
        reason: "Prevent filesystem modification",
      },
      {
        type: "deny",
        pattern: ":(){:|:&};:",
        reason: "Prevent fork bombs",
      },
      {
        type: "allow",
        pattern: "git",
        reason: "Allow git operations",
      },
      {
        type: "allow",
        pattern: "npm",
        reason: "Allow npm operations",
      },
    ];
  }

  /**
   * コマンドの実行（サンドボックス環境）
   */
  async executeCommand(
    command: string,
    args: string[] = [],
  ): Promise<ExecutionResult> {
    if (!this.config.enabled) {
      // サンドボックスが無効な場合は直接実行
      return this.executeDirectly(command, args);
    }

    const executionId = `exec-${Date.now()}`;
    const startTime = Date.now();

    console.log(`🔒 Executing in sandbox: ${command} ${args.join(" ")}`);

    // ルールチェック
    const ruleCheck = this.checkRules(command);
    if (!ruleCheck.allowed) {
      return {
        success: false,
        stdout: "",
        stderr: `Sandbox rule violation: ${ruleCheck.reason}`,
        exitCode: 1,
        executionTime: 0,
      };
    }

    // サンドボックス内で実行
    const workspacePath = path.join(this.sandboxPath, "workspace");
    const tempPath = path.join(this.sandboxPath, "temp");

    try {
      // タイムアウト設定
      const timeout = setTimeout(() => {
        console.warn(`⚠️ Command execution timed out: ${command}`);
      }, this.config.maxExecutionTime);

      // 子プロセスの実行
      const result = await this.executeInSandbox(
        command,
        args,
        workspacePath,
        tempPath,
      );

      clearTimeout(timeout);

      const executionTime = Date.now() - startTime;

      // 実行結果を記録
      const executionResult: ExecutionResult = {
        success: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        executionTime,
      };

      this.executionHistory.set(executionId, executionResult);

      console.log(`✅ Execution completed in ${executionTime}ms`);

      return executionResult;
    } catch (error) {
      const executionTime = Date.now() - startTime;

      console.error(`❌ Execution failed:`, error);

      return {
        success: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        executionTime,
      };
    }
  }

  /**
   * 直接実行（サンドボックスなし）
   */
  private async executeDirectly(
    command: string,
    args: string[],
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    console.log(`🔓 Executing directly: ${command} ${args.join(" ")}`);

    return new Promise((resolve) => {
      const process = spawn(command, args);

      let stdout = "";
      let stderr = "";

      process.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      process.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      process.on("close", (code) => {
        const executionTime = Date.now() - startTime;

        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code,
          executionTime,
        });
      });

      process.on("error", (error) => {
        const executionTime = Date.now() - startTime;

        resolve({
          success: false,
          stdout,
          stderr: error.message,
          exitCode: 1,
          executionTime,
        });
      });
    });
  }

  /**
   * サンドボックス内で実行
   */
  private async executeInSandbox(
    command: string,
    args: string[],
    workspacePath: string,
    tempPath: string,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const env = {
        ...process.env,
        SANDBOX_ENABLED: "true",
        SANDBOX_WORKSPACE: workspacePath,
        SANDBOX_TEMP: tempPath,
      };

      const childProcess = spawn(command, args, {
        cwd: workspacePath,
        env,
      });

      let stdout = "";
      let stderr = "";

      childProcess.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      childProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      childProcess.on("close", (code) => {
        resolve({ exitCode: code, stdout, stderr });
      });

      childProcess.on("error", (error) => {
        resolve({ exitCode: 1, stdout, stderr: error.message });
      });
    });
  }

  /**
   * ルールチェック
   */
  private checkRules(command: string): { allowed: boolean; reason?: string } {
    for (const rule of this.rules) {
      if (command.includes(rule.pattern)) {
        if (rule.type === "deny") {
          return {
            allowed: false,
            reason: rule.reason || "Rule violation",
          };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * 実行履歴を取得
   */
  getExecutionHistory(): ExecutionResult[] {
    return Array.from(this.executionHistory.values());
  }

  /**
   * 実行統計を取得
   */
  getExecutionStats() {
    const history = this.getExecutionHistory();

    if (history.length === 0) {
      return {
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        averageExecutionTime: 0,
      };
    }

    const totalExecutions = history.length;
    const successfulExecutions = history.filter((r) => r.success).length;
    const failedExecutions = history.filter((r) => !r.success).length;
    const averageExecutionTime =
      history.reduce((sum, r) => sum + r.executionTime, 0) / totalExecutions;

    return {
      totalExecutions,
      successfulExecutions,
      failedExecutions,
      averageExecutionTime: Math.round(averageExecutionTime),
    };
  }

  /**
   * 設定を更新
   */
  updateConfig(updates: Partial<SandboxConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * 設定を取得
   */
  getConfig(): SandboxConfig {
    return { ...this.config };
  }

  /**
   * ルールを追加
   */
  addRule(rule: SandboxRule): void {
    this.rules.push(rule);
  }

  /**
   * ルールを削除
   */
  removeRule(index: number): void {
    this.rules.splice(index, 1);
  }

  /**
   * 全てのルールを取得
   */
  getRules(): SandboxRule[] {
    return [...this.rules];
  }

  /**
   * 履歴をクリア
   */
  clearHistory(): void {
    this.executionHistory.clear();
    console.log("🧹 Sandbox execution history cleared");
  }

  /**
   * サンドボックスをクリアンアップ
   */
  async cleanup(): Promise<void> {
    try {
      await fs.rm(this.sandboxPath, { recursive: true, force: true });
      console.log("🧹 Sandbox cleaned up");
    } catch (error) {
      console.error("Failed to clean up sandbox:", error);
    }
  }

  /**
   * サンドボックスのサイズを取得
   */
  async getSize(): Promise<number> {
    try {
      const stats = await fs.stat(this.sandboxPath);
      return stats.size;
    } catch {
      return 0;
    }
  }
}
