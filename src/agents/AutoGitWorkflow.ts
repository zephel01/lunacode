/**
 * AutoGitWorkflow
 *
 * タスク完了後に自動で以下を実行するワークフロー:
 *   1. git commit  — 変更ファイルをステージングして AI 生成メッセージでコミット
 *   2. テスト実行  — 設定されたコマンド（デフォルト: bun test）を実行して CI と同じ検証
 *   3. PR ドラフト — `gh` CLI で GitHub PR ドラフトを作成（未インストール時は手順を出力）
 *
 * 設定は .kairos/config.json の "autoGit" セクションで行う。
 * AgentLoop の "task:complete" フックとして自動トリガーされる他、
 * 単独で import して使用することもできる。
 *
 * 安全性:
 *   - 破壊的な git コマンド（--force, reset --hard, clean 等）は実行しない
 *   - ステージングは明示的なパターンのみ（デフォルトは変更ファイル全体）
 *   - テスト失敗時は PR 作成をスキップ（createPROnTestFailure: true で上書き可）
 */

import { execSync, spawn } from "child_process";
import { ILLMProvider } from "../providers/LLMProvider.js";
import {
  AutoGitConfig,
  AutoGitWorkflowResult,
  CommitResult,
  TestRunResult,
  PRResult,
} from "../types/index.js";

// ─── デフォルト設定 ───────────────────────────────────────────────────────────
const DEFAULTS = {
  mode: "commit-and-test" as const,
  testCommand: "bun test",
  createPROnTestFailure: false,
  draftPR: true,
  baseBranch: "main",
  commitPrefix: "",
  includePatterns: [] as string[],
  excludePatterns: [] as string[],
} satisfies Required<
  Omit<AutoGitConfig, "enabled" | "prTemplate" | "hooks" | "commitPrefix"> & {
    commitPrefix: string;
  }
>;

// 拒否する git コマンドパターン（安全ガード）
const BLOCKED_GIT_PATTERNS = [
  /--force/,
  /-f\b/,
  /reset\s+--hard/,
  /clean\s+-[a-z]*f/,
  /push\s+.*--force/,
  /rebase\s+--onto/,
];

export class AutoGitWorkflow {
  private basePath: string;
  private config: Required<AutoGitConfig>;
  private llmProvider?: ILLMProvider;

  constructor(
    basePath: string,
    config: AutoGitConfig = {},
    llmProvider?: ILLMProvider,
  ) {
    this.basePath = basePath;
    this.llmProvider = llmProvider;
    this.config = {
      enabled: config.enabled ?? false,
      mode: config.mode ?? DEFAULTS.mode,
      testCommand: config.testCommand ?? DEFAULTS.testCommand,
      createPROnTestFailure:
        config.createPROnTestFailure ?? DEFAULTS.createPROnTestFailure,
      draftPR: config.draftPR ?? DEFAULTS.draftPR,
      baseBranch: config.baseBranch ?? DEFAULTS.baseBranch,
      prTemplate: config.prTemplate ?? "",
      commitPrefix: config.commitPrefix ?? DEFAULTS.commitPrefix,
      includePatterns: config.includePatterns ?? DEFAULTS.includePatterns,
      excludePatterns: config.excludePatterns ?? DEFAULTS.excludePatterns,
      hooks: config.hooks ?? {},
    };
  }

  // ─── パブリック API ──────────────────────────────────────────────────────────

  /**
   * ワークフロー全体を実行する。
   *
   * @param taskSummary - タスクの説明（コミットメッセージ生成に使用）
   */
  async run(taskSummary: string): Promise<AutoGitWorkflowResult> {
    const startTime = Date.now();
    let commit: CommitResult | undefined;
    let tests: TestRunResult | undefined;
    let pr: PRResult | undefined;

    console.log(`\n🔧 AutoGitWorkflow started (mode: ${this.config.mode})`);

    try {
      // pre-commit フック
      if (this.config.hooks?.preCommit) {
        console.log(`  ⚙️  Running pre-commit hook...`);
        await this.runShellCommand(this.config.hooks.preCommit);
      }

      // ── Step 1: git commit ──────────────────────────────────────────────────
      commit = await this.stageAndCommit(taskSummary);

      if (commit.status === "failed") {
        return this.buildResult("failed", commit, tests, pr, startTime);
      }

      // post-commit フック
      if (commit.status === "success" && this.config.hooks?.postCommit) {
        console.log(`  ⚙️  Running post-commit hook...`);
        await this.runShellCommand(this.config.hooks.postCommit);
      }

      if (this.config.mode === "commit-only") {
        return this.buildResult("success", commit, tests, pr, startTime);
      }

      // ── Step 2: テスト実行 ──────────────────────────────────────────────────
      tests = await this.runTests();

      if (this.config.mode === "commit-and-test") {
        const status = tests.status === "passed" ? "success" : "partial";
        return this.buildResult(status, commit, tests, pr, startTime);
      }

      // ── Step 3: PR ドラフト作成 ─────────────────────────────────────────────
      const shouldCreatePR =
        tests.status === "passed" || this.config.createPROnTestFailure;

      if (shouldCreatePR) {
        pr = await this.createPRDraft(taskSummary, tests);

        if (this.config.hooks?.postPR && pr.status === "created") {
          console.log(`  ⚙️  Running post-PR hook...`);
          await this.runShellCommand(this.config.hooks.postPR);
        }
      } else {
        pr = {
          status: "skipped",
          fallbackInstructions:
            "PR creation skipped because tests failed. " +
            "Set `createPROnTestFailure: true` in autoGit config to override.",
        };
        console.log(`  ⏭️  PR skipped (tests failed)`);
      }

      const finalStatus =
        tests.status === "passed" && pr.status !== "failed"
          ? "success"
          : "partial";

      return this.buildResult(finalStatus, commit, tests, pr, startTime);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n❌ AutoGitWorkflow error: ${message}`);
      return this.buildResult("failed", commit, tests, pr, startTime, message);
    }
  }

  /**
   * 変更ファイルをステージングしてコミットする。
   * コミットメッセージは LLM で生成（プロバイダー未設定時はフォールバック）。
   */
  async stageAndCommit(taskSummary: string): Promise<CommitResult> {
    console.log(`\n  📦 Step 1: Staging & committing changes...`);

    try {
      // 変更ファイルの確認
      const statusOutput = this.git("status --porcelain");
      if (!statusOutput.trim()) {
        console.log(`     Nothing to commit.`);
        return { status: "nothing-to-commit", filesChanged: [] };
      }

      // ステージング
      const filesToStage = this.resolveFilesToStage(statusOutput);
      if (filesToStage.length === 0) {
        return { status: "nothing-to-commit", filesChanged: [] };
      }

      for (const file of filesToStage) {
        this.git(`add -- "${file}"`);
      }

      // ステージ済みファイルの確認
      const stagedOutput = this.git("diff --cached --name-only");
      const filesChanged = stagedOutput
        .trim()
        .split("\n")
        .filter((f) => f.trim());

      if (filesChanged.length === 0) {
        return { status: "nothing-to-commit", filesChanged: [] };
      }

      // コミットメッセージ生成
      const diff = this.git("diff --cached --stat");
      const message = await this.generateCommitMessage(taskSummary, diff);
      const fullMessage = this.config.commitPrefix
        ? `${this.config.commitPrefix}${message}`
        : message;

      // コミット実行（--no-verify で pre-commit フックをバイパス可能だが、ここでは通常コミット）
      this.git(`commit -m "${fullMessage.replace(/"/g, '\\"')}"`);
      const commitHash = this.git("rev-parse --short HEAD").trim();

      console.log(`     ✅ Committed: ${commitHash} — ${fullMessage}`);
      console.log(
        `        Files: ${filesChanged.slice(0, 5).join(", ")}${filesChanged.length > 5 ? ` +${filesChanged.length - 5} more` : ""}`,
      );

      return {
        status: "success",
        commitHash,
        commitMessage: fullMessage,
        filesChanged,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`     ❌ Commit failed: ${message}`);
      return { status: "failed", filesChanged: [], error: message };
    }
  }

  /**
   * テストコマンドを実行して結果を返す。
   */
  async runTests(): Promise<TestRunResult> {
    const command = this.config.testCommand;
    console.log(`\n  🧪 Step 2: Running tests: ${command}`);

    const testStart = Date.now();
    try {
      const output = await this.runShellCommand(command, 120_000);
      const durationMs = Date.now() - testStart;

      // テスト結果のパース（bun test / jest / vitest の出力パターン）
      const { passCount, failCount } = this.parseTestOutput(output);
      const passed = failCount === 0;

      console.log(
        `     ${passed ? "✅" : "❌"} Tests ${passed ? "passed" : "failed"} (${Math.round(durationMs / 1000)}s) — ${passCount} pass, ${failCount} fail`,
      );

      return {
        status: passed ? "passed" : "failed",
        command,
        output,
        durationMs,
        passCount,
        failCount,
      };
    } catch (error) {
      const durationMs = Date.now() - testStart;
      const message = error instanceof Error ? error.message : String(error);

      // コマンド失敗時も output を保持
      const output = message.length > 2000 ? message.slice(0, 2000) : message;
      const { passCount, failCount } = this.parseTestOutput(output);

      console.error(`     ❌ Test command failed: ${message.slice(0, 200)}`);

      return {
        status: "failed",
        command,
        output,
        durationMs,
        passCount,
        failCount,
        error: message.slice(0, 500),
      };
    }
  }

  /**
   * `gh` CLI を使って GitHub PR ドラフトを作成する。
   * `gh` が未インストールまたは認証されていない場合は手順を出力する。
   */
  async createPRDraft(
    taskSummary: string,
    testResult?: TestRunResult,
  ): Promise<PRResult> {
    console.log(`\n  🔀 Step 3: Creating PR draft...`);

    try {
      // gh コマンドの確認
      const ghVersion = await this.runShellCommand("gh --version").catch(
        () => "",
      );
      if (!ghVersion) {
        const instructions = this.buildPRInstructions(taskSummary);
        console.log(`     ⚠️  gh CLI not found. See fallback instructions.`);
        return {
          status: "skipped",
          fallbackInstructions: instructions,
        };
      }

      // 現在のブランチを取得
      const currentBranch = this.git("rev-parse --abbrev-ref HEAD").trim();
      if (currentBranch === this.config.baseBranch) {
        return {
          status: "skipped",
          fallbackInstructions: `Already on base branch (${this.config.baseBranch}). Push to a feature branch first.`,
        };
      }

      // リモートへプッシュ
      console.log(`     📤 Pushing branch: ${currentBranch}`);
      this.git(`push -u origin "${currentBranch}"`);

      // PR タイトル・本文を生成
      const prTitle = await this.generatePRTitle(taskSummary);
      const prBody =
        this.config.prTemplate || this.buildPRBody(taskSummary, testResult);

      // PR 作成
      const draftFlag = this.config.draftPR ? "--draft" : "";
      const ghOutput = await this.runShellCommand(
        `gh pr create --title "${prTitle.replace(/"/g, '\\"')}" ` +
          `--body "${prBody.replace(/"/g, '\\"').replace(/\n/g, "\\n")}" ` +
          `--base "${this.config.baseBranch}" ${draftFlag}`.trim(),
      );

      // URL を抽出
      const urlMatch = ghOutput.match(/https:\/\/github\.com\/[^\s]+/);
      const url = urlMatch?.[0];
      const prNumberMatch = url?.match(/\/pull\/(\d+)/);
      const prNumber = prNumberMatch
        ? parseInt(prNumberMatch[1], 10)
        : undefined;

      console.log(
        `     ✅ PR created: ${url} ${this.config.draftPR ? "(draft)" : ""}`,
      );

      return {
        status: "created",
        url,
        prNumber,
        title: prTitle,
        isDraft: this.config.draftPR,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`     ❌ PR creation failed: ${message.slice(0, 200)}`);
      return {
        status: "failed",
        fallbackInstructions: this.buildPRInstructions(taskSummary),
        error: message,
      };
    }
  }

  // ─── プライベートヘルパー ────────────────────────────────────────────────────

  /**
   * LLM を使ってコミットメッセージを生成する。
   * プロバイダー未設定または失敗した場合はフォールバックメッセージを返す。
   */
  private async generateCommitMessage(
    taskSummary: string,
    diffStat: string,
  ): Promise<string> {
    if (!this.llmProvider) {
      return this.buildFallbackCommitMessage(taskSummary);
    }

    try {
      const prompt = [
        "Generate a concise git commit message for the following change.",
        "Format: <type>(<scope>): <subject>",
        "Types: feat, fix, refactor, test, docs, chore",
        "Rules: imperative mood, max 72 chars, no period at end",
        "",
        `Task: ${taskSummary}`,
        "",
        "Changed files (diff --stat):",
        diffStat.slice(0, 500),
        "",
        "Output ONLY the commit message. No explanation, no quotes.",
      ].join("\n");

      const message = await this.llmProvider.generateResponse(prompt, {
        temperature: 0.3,
        maxTokens: 80,
      });

      // 1行目のみ抽出・クリーニング
      const cleaned = message
        .split("\n")[0]
        .replace(/^["'`]+|["'`]+$/g, "")
        .trim();

      return cleaned.length > 5
        ? cleaned
        : this.buildFallbackCommitMessage(taskSummary);
    } catch {
      return this.buildFallbackCommitMessage(taskSummary);
    }
  }

  /** PR タイトルを LLM で生成する */
  private async generatePRTitle(taskSummary: string): Promise<string> {
    if (!this.llmProvider) {
      return `feat: ${taskSummary.slice(0, 60)}`;
    }

    try {
      const prompt = [
        "Generate a concise GitHub Pull Request title.",
        "Format: <type>: <subject>",
        "Rules: max 72 chars, no period at end",
        `Task: ${taskSummary}`,
        "Output ONLY the title.",
      ].join("\n");

      const title = await this.llmProvider.generateResponse(prompt, {
        temperature: 0.3,
        maxTokens: 60,
      });

      const cleaned = title
        .split("\n")[0]
        .replace(/^["'`]+|["'`]+$/g, "")
        .trim();

      return cleaned.length > 5 ? cleaned : `feat: ${taskSummary.slice(0, 60)}`;
    } catch {
      return `feat: ${taskSummary.slice(0, 60)}`;
    }
  }

  /** フォールバック用コミットメッセージ（LLM 不使用） */
  private buildFallbackCommitMessage(taskSummary: string): string {
    const subject = taskSummary.slice(0, 60).replace(/\n/g, " ").trim();
    return `feat: ${subject}`;
  }

  /** PR 本文を組み立てる */
  private buildPRBody(taskSummary: string, testResult?: TestRunResult): string {
    const lines = [
      "## Summary",
      taskSummary,
      "",
      "## Changes",
      "<!-- Describe what changed and why -->",
      "",
    ];

    if (testResult) {
      const icon = testResult.status === "passed" ? "✅" : "❌";
      lines.push(
        "## Test Results",
        `${icon} \`${testResult.command}\``,
        `- ${testResult.passCount ?? 0} passed, ${testResult.failCount ?? 0} failed`,
        "",
      );
    }

    lines.push(
      "## Checklist",
      "- [ ] Tests pass",
      "- [ ] Type check passes",
      "- [ ] Prettier formatted",
    );

    return lines.join("\n");
  }

  /** gh CLI なし / 失敗時のマニュアル手順 */
  private buildPRInstructions(taskSummary: string): string {
    const branch = (() => {
      try {
        return this.git("rev-parse --abbrev-ref HEAD").trim();
      } catch {
        return "<your-branch>";
      }
    })();

    return [
      "gh CLI が利用できないため、以下の手順で PR を作成してください:",
      "",
      `  1. git push -u origin ${branch}`,
      `  2. https://github.com/<owner>/<repo>/compare/${this.config.baseBranch}...${branch}`,
      `  3. タイトル: feat: ${taskSummary.slice(0, 60)}`,
      `  4. [Create pull request] → [Create draft pull request]`,
    ].join("\n");
  }

  /**
   * git status --porcelain の出力からステージ対象ファイルを解決する。
   * excludePatterns に一致するファイルは除外する。
   */
  private resolveFilesToStage(statusOutput: string): string[] {
    const allFiles = statusOutput
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .map((line) => line.slice(3).trim()); // "XY filepath" の形式から filepath を抽出

    const include =
      this.config.includePatterns.length > 0
        ? (file: string) =>
            this.config.includePatterns.some((pat) =>
              new RegExp(pat.replace(/\*/g, ".*")).test(file),
            )
        : () => true;

    const exclude = (file: string) =>
      this.config.excludePatterns.some((pat) =>
        new RegExp(pat.replace(/\*/g, ".*")).test(file),
      );

    return allFiles.filter((f) => include(f) && !exclude(f));
  }

  /**
   * テスト出力から pass/fail カウントを抽出する。
   * bun test / jest / vitest の形式に対応。
   */
  private parseTestOutput(output: string): {
    passCount: number;
    failCount: number;
  } {
    // bun test: "4 pass\n2 fail" or "Ran 6 tests across 2 files"
    const passMatch = output.match(/(\d+)\s+pass/i);
    const failMatch = output.match(/(\d+)\s+fail/i);

    // jest/vitest: "Tests: 2 failed, 5 passed"
    const jestPassMatch = output.match(/(\d+)\s+passed/i);
    const jestFailMatch = output.match(/(\d+)\s+failed/i);

    const passCount =
      parseInt(passMatch?.[1] ?? jestPassMatch?.[1] ?? "0", 10) || 0;
    const failCount =
      parseInt(failMatch?.[1] ?? jestFailMatch?.[1] ?? "0", 10) || 0;

    return { passCount, failCount };
  }

  /**
   * git コマンドを安全に実行する（破壊的コマンドはブロック）。
   */
  private git(command: string): string {
    // 安全ガード: 危険なコマンドパターンをブロック
    for (const pattern of BLOCKED_GIT_PATTERNS) {
      if (pattern.test(command)) {
        throw new Error(`Blocked dangerous git command: git ${command}`);
      }
    }

    return execSync(`git ${command}`, {
      cwd: this.basePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  /** シェルコマンドを非同期で実行する */
  private async runShellCommand(
    command: string,
    timeoutMs = 30_000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      const proc = spawn(command, {
        shell: true,
        cwd: this.basePath,
        timeout: timeoutMs,
      });

      proc.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      proc.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
      });

      proc.on("close", (code: number | null) => {
        const combined = (stdout + stderr).trim();
        if (code === 0) {
          resolve(combined);
        } else {
          reject(new Error(combined || `Command failed with code ${code}`));
        }
      });

      proc.on("error", (err: Error) => reject(err));
    });
  }

  /** AutoGitWorkflowResult を組み立てる */
  private buildResult(
    status: AutoGitWorkflowResult["status"],
    commit: CommitResult | undefined,
    tests: TestRunResult | undefined,
    pr: PRResult | undefined,
    startTime: number,
    error?: string,
  ): AutoGitWorkflowResult {
    const lines: string[] = [`AutoGitWorkflow: ${status.toUpperCase()}`];

    if (commit) {
      const icon =
        commit.status === "success"
          ? "✅"
          : commit.status === "nothing-to-commit"
            ? "⏭️"
            : "❌";
      lines.push(
        `  ${icon} Commit: ${commit.status}${commit.commitHash ? ` (${commit.commitHash})` : ""}`,
      );
    }
    if (tests) {
      const icon = tests.status === "passed" ? "✅" : "❌";
      lines.push(
        `  ${icon} Tests: ${tests.status} (${tests.passCount ?? 0} pass, ${tests.failCount ?? 0} fail)`,
      );
    }
    if (pr) {
      const icon =
        pr.status === "created" ? "✅" : pr.status === "skipped" ? "⏭️" : "❌";
      lines.push(`  ${icon} PR: ${pr.status}${pr.url ? ` — ${pr.url}` : ""}`);
      if (pr.fallbackInstructions) {
        lines.push(`\n${pr.fallbackInstructions}`);
      }
    }
    if (error) {
      lines.push(`  ⚠️  Error: ${error}`);
    }

    return {
      status,
      commit,
      tests,
      pr,
      totalDurationMs: Date.now() - startTime,
      summary: lines.join("\n"),
    };
  }

  // ─── ファクトリ & ユーティリティ ────────────────────────────────────────────

  /**
   * config オブジェクトからインスタンスを生成するファクトリ。
   * AgentLoop から呼び出す際に使用する。
   */
  static fromConfig(
    basePath: string,
    config: AutoGitConfig,
    llmProvider?: ILLMProvider,
  ): AutoGitWorkflow {
    return new AutoGitWorkflow(basePath, config, llmProvider);
  }

  /** 結果のサマリーを整形して返す */
  static formatResult(result: AutoGitWorkflowResult): string {
    return [
      "═══════════════════════════════════",
      result.summary,
      `Total: ${Math.round(result.totalDurationMs / 1000)}s`,
      "═══════════════════════════════════",
    ].join("\n");
  }
}
