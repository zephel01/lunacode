// src/utils/gitRunner.ts
import { spawn } from "child_process";

export interface RunGitOptions {
  cwd: string;
  /** タイムアウト (ms)。デフォルト 30 秒 */
  timeoutMs?: number;
  /** stdout/stderr をまとめて返すか（false だと stdout のみ） */
  combineStderr?: boolean;
}

export class GitCommandError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

/**
 * git コマンドを非同期で実行する。
 * - shell: true は使用しない（コマンドインジェクション防止）
 * - 大きい diff にも対応するためストリーミング収集
 */
export function runGit(
  args: readonly string[],
  opts: RunGitOptions,
): Promise<string> {
  const { cwd, timeoutMs = 30_000, combineStderr = false } = opts;

  return new Promise((resolve, reject) => {
    const proc = spawn("git", args as string[], { cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGKILL");
        reject(
          new GitCommandError(
            `git ${args.join(" ")} timed out after ${timeoutMs}ms`,
            null,
            stderr,
          ),
        );
      }
    }, timeoutMs);

    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(combineStderr ? stdout + stderr : stdout);
      } else {
        reject(
          new GitCommandError(
            `git ${args.join(" ")} exited ${code}: ${stderr.trim()}`,
            code,
            stderr,
          ),
        );
      }
    });
  });
}
