/**
 * PipelineOrchestrator
 *
 * Planner → Coder → Tester → Reviewer の4段階パイプラインを実装する
 * マルチエージェントオーケストレーター。
 *
 * フロー:
 *   1. Planner  : タスクを分析し、実装計画を策定（読み取り専用）
 *   2. Coder    : 計画に従ってコードを実装（ファイル作成・編集可）
 *   3. Tester   : テストを実行し結果を検証（読み取り・実行のみ）
 *   4. Reviewer : コード品質をレビューし改善点を提案（読み取り専用）
 *
 * リトライ戦略:
 *   - Testerが FAILED を返した場合、Coder に失敗情報を渡して再実行
 *   - maxRetries に達するまで Coder → Tester のループを繰り返す
 */

import { SubAgentManager } from "./SubAgentManager.js";
import { ILLMProvider } from "../providers/LLMProvider.js";
import {
  PipelineConfig,
  PipelineResult,
  PipelineStageResult,
  PipelineArtifacts,
  PipelineRole,
} from "../types/index.js";

// Testerの出力から成否を判定するキーワード
const TESTER_PASS_KEYWORDS = [
  "PASSED",
  "passed",
  "✅",
  "all tests pass",
  "success",
];
const TESTER_FAIL_KEYWORDS = [
  "FAILED",
  "failed",
  "❌",
  "test failed",
  "error",
  "assertion",
];

/**
 * パイプラインの実行コンテキスト（ステージ間で引き継がれる情報）
 */
interface PipelineContext {
  taskDescription: string;
  artifacts: PipelineArtifacts;
  previousFailure?: string; // 直前の Tester 失敗詳細
}

export class PipelineOrchestrator {
  private subAgentManager: SubAgentManager;
  private config: Required<PipelineConfig>;

  constructor(
    llmProvider: ILLMProvider,
    basePath: string,
    config: PipelineConfig = {},
  ) {
    this.subAgentManager = new SubAgentManager(llmProvider, basePath, 1);
    this.config = {
      maxRetries: config.maxRetries ?? 3,
      stageTimeout: config.stageTimeout ?? 120_000,
      skipStages: config.skipStages ?? [],
      onStageComplete: config.onStageComplete ?? (() => {}),
      onStageStart: config.onStageStart ?? (() => {}),
    };
  }

  /**
   * パイプラインを実行する
   *
   * @param taskDescription - 実装するタスクの説明（自然言語）
   * @returns パイプライン全体の実行結果
   */
  async run(taskDescription: string): Promise<PipelineResult> {
    const startTime = Date.now();
    const stageResults: PipelineStageResult[] = [];
    const context: PipelineContext = {
      taskDescription,
      artifacts: {},
    };

    console.log(`\n🚀 Pipeline started: "${taskDescription}"`);
    console.log(`   Max retries: ${this.config.maxRetries}`);
    console.log(`   Stage timeout: ${this.config.stageTimeout}ms\n`);

    try {
      // ─────────────────────────────────────────
      // Stage 1: Planner
      // ─────────────────────────────────────────
      const plannerResult = await this.runStage("planner", context, 0);
      stageResults.push(plannerResult);

      if (plannerResult.status === "failed") {
        return this.buildResult(
          taskDescription,
          "failed",
          stageResults,
          context.artifacts,
          startTime,
          0,
          "Planner stage failed",
        );
      }

      context.artifacts.plan = plannerResult.output;

      // ─────────────────────────────────────────
      // Stage 2 & 3: Coder → Tester (リトライループ)
      // ─────────────────────────────────────────
      let coderIteration = 0;
      let testerPassed = false;

      while (coderIteration < this.config.maxRetries) {
        // --- Coder ---
        const coderResult = await this.runStage(
          "coder",
          context,
          coderIteration,
        );
        stageResults.push(coderResult);

        if (
          coderResult.status === "failed" ||
          coderResult.status === "timeout"
        ) {
          return this.buildResult(
            taskDescription,
            "failed",
            stageResults,
            context.artifacts,
            startTime,
            coderIteration,
            `Coder stage failed on iteration ${coderIteration + 1}`,
          );
        }

        context.artifacts.code = coderResult.output;
        context.previousFailure = undefined; // リセット

        // --- Tester ---
        // runStage が skipStages を内部で処理するため常に呼び出す
        const testerResult = await this.runStage(
          "tester",
          context,
          coderIteration,
        );
        stageResults.push(testerResult);

        if (testerResult.status === "skipped") {
          // Tester をスキップした場合はそのまま通過
          testerPassed = true;
          break;
        }

        context.artifacts.testResults = testerResult.output;
        testerPassed = this.evaluateTesterOutput(testerResult.output);

        if (testerPassed) {
          console.log(`   ✅ Tester PASSED (iteration ${coderIteration + 1})`);
          break;
        } else {
          coderIteration++;
          if (coderIteration < this.config.maxRetries) {
            console.log(
              `   ⚠️  Tester FAILED — retrying Coder (${coderIteration}/${this.config.maxRetries})`,
            );
            // 失敗情報を次の Coder 実行に渡す
            context.previousFailure = testerResult.output;
          }
        }
      }

      // maxRetries に達してもテストが通らなかった場合
      if (!testerPassed && !this.config.skipStages.includes("tester")) {
        console.log(`   ❌ Max retries reached. Pipeline failed.`);
        return this.buildResult(
          taskDescription,
          "failed",
          stageResults,
          context.artifacts,
          startTime,
          coderIteration,
          `Tests did not pass after ${this.config.maxRetries} attempts`,
        );
      }

      // ─────────────────────────────────────────
      // Stage 4: Reviewer
      // ─────────────────────────────────────────
      const reviewerResult = await this.runStage("reviewer", context, 0);
      stageResults.push(reviewerResult);
      context.artifacts.review = reviewerResult.output;

      console.log(`\n✅ Pipeline completed successfully!\n`);

      return this.buildResult(
        taskDescription,
        "success",
        stageResults,
        context.artifacts,
        startTime,
        coderIteration,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n❌ Pipeline error: ${message}\n`);
      return this.buildResult(
        taskDescription,
        "failed",
        stageResults,
        context.artifacts,
        startTime,
        0,
        message,
      );
    }
  }

  /**
   * 単一ステージを実行する
   */
  private async runStage(
    role: PipelineRole,
    context: PipelineContext,
    iteration: number,
  ): Promise<PipelineStageResult> {
    // スキップ対象ステージ
    if (this.config.skipStages.includes(role)) {
      console.log(`   ⏭️  Stage [${role.toUpperCase()}] skipped`);
      return {
        stage: role,
        status: "skipped",
        output: "",
        durationMs: 0,
        iteration,
      };
    }

    console.log(
      `\n▶️  Stage [${role.toUpperCase()}] (iteration ${iteration + 1})`,
    );
    this.config.onStageStart(role, iteration);

    const task = this.buildStageTask(role, context, iteration);
    const stageStart = Date.now();

    const result = await this.subAgentManager.spawn({
      role,
      task,
      timeout: this.config.stageTimeout,
    });

    const stageResult: PipelineStageResult = {
      stage: role,
      status: result.status === "completed" ? "success" : result.status,
      output: result.output,
      durationMs: result.durationMs,
      iteration,
      error: result.error,
    };

    console.log(
      `   ${stageResult.status === "success" ? "✅" : "❌"} [${role.toUpperCase()}] done in ${Math.round(result.durationMs / 1000)}s`,
    );

    this.config.onStageComplete(stageResult, { ...context.artifacts });

    return stageResult;
  }

  /**
   * 各ステージ用のタスクプロンプトを組み立てる
   */
  private buildStageTask(
    role: PipelineRole,
    context: PipelineContext,
    iteration: number,
  ): string {
    const { taskDescription, artifacts, previousFailure } = context;

    switch (role) {
      case "planner":
        return [
          `## Original Task`,
          taskDescription,
          ``,
          `Analyze the codebase and produce a detailed implementation plan.`,
          `Structure your output with these sections:`,
          `1. Task Summary`,
          `2. Files to Create/Modify`,
          `3. Implementation Steps (numbered, actionable)`,
          `4. Test Criteria`,
          `5. Review Checklist`,
        ].join("\n");

      case "coder": {
        const parts = [
          `## Original Task`,
          taskDescription,
          ``,
          `## Implementation Plan (from Planner)`,
          artifacts.plan ?? "(no plan available — use your best judgment)",
        ];

        if (previousFailure && iteration > 0) {
          parts.push(
            ``,
            `## ⚠️ Previous Test Run FAILED (iteration ${iteration})`,
            `Fix these issues before re-implementing:`,
            previousFailure,
          );
        }

        parts.push(``, `Implement the code according to the plan above.`);
        return parts.join("\n");
      }

      case "tester":
        return [
          `## Original Task`,
          taskDescription,
          ``,
          `## Implementation Plan`,
          artifacts.plan ?? "(no plan available)",
          ``,
          `## Implemented Code Summary`,
          artifacts.code ?? "(no code summary available)",
          ``,
          `Verify the implementation:`,
          `1. Review the code for correctness`,
          `2. Run existing tests with bash`,
          `3. Check the test criteria from the plan`,
          ``,
          `Start your response with either "PASSED" or "FAILED", then explain.`,
        ].join("\n");

      case "reviewer":
        return [
          `## Original Task`,
          taskDescription,
          ``,
          `## Implementation Plan`,
          artifacts.plan ?? "(no plan available)",
          ``,
          `## Implemented Code Summary`,
          artifacts.code ?? "(no code summary available)",
          ``,
          `## Test Results`,
          artifacts.testResults ?? "(no test results available)",
          ``,
          `Review the implementation for:`,
          `- Code quality and TypeScript best practices`,
          `- Error handling completeness`,
          `- API design and documentation`,
          `- Performance considerations`,
          `- Security concerns`,
          ``,
          `Provide a structured review with specific, actionable suggestions.`,
        ].join("\n");
    }
  }

  /**
   * Testerの出力テキストから合否を判定する
   */
  private evaluateTesterOutput(output: string): boolean {
    const lower = output.toLowerCase();

    // PASSED キーワードを含むかチェック
    const hasPassed = TESTER_PASS_KEYWORDS.some(
      (kw) => output.includes(kw) || lower.includes(kw.toLowerCase()),
    );

    // FAILED キーワードを含むかチェック
    const hasFailed = TESTER_FAIL_KEYWORDS.some(
      (kw) => output.includes(kw) || lower.includes(kw.toLowerCase()),
    );

    // PASSED が明示的にあり、FAILED がない場合のみ成功とみなす
    if (hasPassed && !hasFailed) return true;
    if (hasFailed) return false;

    // 判定できない場合は成功とみなす（保守的ではなくポジティブ判定）
    return true;
  }

  /**
   * PipelineResult を組み立てる
   */
  private buildResult(
    taskDescription: string,
    status: "success" | "failed",
    stages: PipelineStageResult[],
    artifacts: PipelineArtifacts,
    startTime: number,
    coderIterations: number,
    error?: string,
  ): PipelineResult {
    return {
      taskDescription,
      status,
      stages,
      artifacts,
      totalDurationMs: Date.now() - startTime,
      coderIterations: coderIterations + 1,
      error,
    };
  }

  /**
   * パイプライン結果のサマリーを人間が読みやすい形式で返す
   */
  static formatSummary(result: PipelineResult): string {
    const lines: string[] = [
      `═══════════════════════════════════════`,
      `Pipeline Result: ${result.status.toUpperCase()}`,
      `═══════════════════════════════════════`,
      `Task: ${result.taskDescription}`,
      `Total Duration: ${Math.round(result.totalDurationMs / 1000)}s`,
      `Coder Iterations: ${result.coderIterations}`,
      ``,
      `Stages:`,
    ];

    for (const stage of result.stages) {
      const icon =
        stage.status === "success"
          ? "✅"
          : stage.status === "skipped"
            ? "⏭️"
            : "❌";
      lines.push(
        `  ${icon} ${stage.stage.toUpperCase().padEnd(10)} | ${stage.status.padEnd(8)} | ${Math.round(stage.durationMs / 1000)}s`,
      );
    }

    if (result.error) {
      lines.push(``, `Error: ${result.error}`);
    }

    if (result.artifacts.review) {
      lines.push(``, `Reviewer Notes:`, result.artifacts.review.slice(0, 500));
    }

    lines.push(`═══════════════════════════════════════`);
    return lines.join("\n");
  }
}
