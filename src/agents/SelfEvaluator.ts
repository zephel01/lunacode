/**
 * SelfEvaluator — Phase 14: 自己評価・自己修正ループ
 *
 * AgentLoop が最終応答を生成した後に呼び出される。
 * LLM に元タスクと応答を渡して自己採点させ、スコアが閾値未満なら
 * 指摘内容を会話に注入して修正ループを回す。
 *
 * フロー:
 *   runLoop() → 最終応答 → SelfEvaluator.evaluate()
 *     ├── score >= threshold → そのまま返す
 *     └── score < threshold  → 修正プロンプト注入 → LLM 再応答
 *           └── maxRounds まで繰り返す
 */

import type {
  SelfEvalConfig,
  SelfEvalResult,
  EvalJudgment,
  CorrectionRound,
} from "../types/index.js";
import type {
  ILLMProvider as LLMProvider,
  ChatMessage,
} from "../providers/LLMProvider.js";

// ── 定数 ─────────────────────────────────────────────────────────────────────

const DEFAULT_SCORE_THRESHOLD = 7;
const DEFAULT_MAX_ROUNDS = 2;
const DEFAULT_MIN_RESPONSE_LENGTH = 50;

const EVAL_SYSTEM_PROMPT = `You are a strict code and task reviewer.
You will be given:
1. The original task (user request)
2. The agent's response

Evaluate the response and return a JSON object with this exact structure:
{
  "score": <integer 0-10>,
  "passed": <boolean>,
  "issues": [<string>, ...],
  "suggestion": "<one-line fix summary>"
}

Scoring guide:
- 9-10: Complete, correct, well-structured, no issues
- 7-8:  Mostly correct with minor gaps
- 5-6:  Partially complete or has notable omissions
- 3-4:  Significant errors or missing key parts
- 0-2:  Wrong, irrelevant, or empty

Set "passed" to true if score >= THRESHOLD.
Keep "issues" empty if passed.
Return ONLY the JSON object, no markdown fences.`;

// ── 型 ───────────────────────────────────────────────────────────────────────

export interface EvaluateOptions {
  task: string;
  response: string;
  /** 会話履歴（修正ループで追記する） */
  messages: ChatMessage[];
}

// ── クラス ────────────────────────────────────────────────────────────────────

export class SelfEvaluator {
  private readonly threshold: number;
  private readonly maxRounds: number;
  private readonly minResponseLength: number;
  private readonly evaluateSubAgents: boolean;

  constructor(
    private readonly llmProvider: LLMProvider,
    config: SelfEvalConfig = {},
  ) {
    this.threshold = config.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
    this.maxRounds = config.maxRounds ?? DEFAULT_MAX_ROUNDS;
    this.minResponseLength =
      config.minResponseLength ?? DEFAULT_MIN_RESPONSE_LENGTH;
    this.evaluateSubAgents = config.evaluateSubAgents ?? false;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * 応答を評価し、必要なら修正ループを回す。
   * @param options - タスク・応答・会話履歴
   * @param isSubAgent - サブエージェントとして呼ばれているか
   */
  async evaluate(
    options: EvaluateOptions,
    isSubAgent = false,
  ): Promise<SelfEvalResult> {
    const { task, response, messages } = options;

    // サブエージェントかつ evaluateSubAgents=false はスキップ
    if (isSubAgent && !this.evaluateSubAgents) {
      return this.skippedResult(response);
    }

    // 短すぎる応答はスキップ（「はい」「了解」など）
    if (response.trim().length < this.minResponseLength) {
      return this.skippedResult(response);
    }

    const corrections: CorrectionRound[] = [];
    let currentResponse = response;
    let initialScore = 0;

    for (let round = 1; round <= this.maxRounds; round++) {
      const start = Date.now();

      // 評価を実行
      const judgment = await this.judge(task, currentResponse);

      if (round === 1) {
        initialScore = judgment.score;
      }

      // 合格なら終了
      if (judgment.passed) {
        return {
          enabled: true,
          skipped: false,
          initialScore,
          finalScore: judgment.score,
          rounds: round - 1, // 修正ラウンド数（評価だけして修正しなかった場合は 0）
          corrections,
          finalResponse: currentResponse,
        };
      }

      // 修正プロンプトを生成して LLM に再応答させる
      const corrected = await this.correct(
        task,
        currentResponse,
        judgment,
        messages,
      );

      corrections.push({
        round,
        judgment,
        correctedResponse: corrected,
        durationMs: Date.now() - start,
      });

      currentResponse = corrected;
    }

    // maxRounds 使い切り → 最後の評価を取得してスコアだけ記録
    const finalJudgment = await this.judge(task, currentResponse);

    return {
      enabled: true,
      skipped: false,
      initialScore,
      finalScore: finalJudgment.score,
      rounds: corrections.length,
      corrections,
      finalResponse: currentResponse,
    };
  }

  /** 設定を fromConfig で構築するファクトリ */
  static fromConfig(
    llmProvider: LLMProvider,
    config: SelfEvalConfig,
  ): SelfEvaluator {
    return new SelfEvaluator(llmProvider, config);
  }

  /** 結果のサマリー文字列（ログ用） */
  static formatResult(result: SelfEvalResult): string {
    if (!result.enabled || result.skipped) {
      return "🔍 SelfEval: skipped";
    }
    const delta = result.finalScore - result.initialScore;
    const arrow =
      delta > 0 ? `↑${delta}` : delta < 0 ? `↓${Math.abs(delta)}` : "→";
    return (
      `🔍 SelfEval: ${result.rounds} round(s) | ` +
      `score ${result.initialScore} ${arrow} ${result.finalScore}/10`
    );
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /** LLM に採点させる（JSON を返す） */
  private async judge(task: string, response: string): Promise<EvalJudgment> {
    const systemPrompt = EVAL_SYSTEM_PROMPT.replace(
      "THRESHOLD",
      String(this.threshold),
    );

    const userContent = `## Original Task\n${task}\n\n## Agent Response\n${response}`;

    try {
      const completion = await this.llmProvider.chatCompletion({
        model: this.llmProvider.getDefaultModel(),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        stream: false,
      });

      const raw = completion.choices[0].message.content ?? "";
      return this.parseJudgment(raw);
    } catch {
      // LLM エラー時は合格扱いにして無限ループを防ぐ
      return {
        score: this.threshold,
        passed: true,
        issues: [],
        suggestion: "evaluation failed, assuming pass",
      };
    }
  }

  /** 指摘内容を元に修正応答を生成する */
  private async correct(
    task: string,
    currentResponse: string,
    judgment: EvalJudgment,
    messages: ChatMessage[],
  ): Promise<string> {
    const issuesList = judgment.issues
      .map((issue, i) => `${i + 1}. ${issue}`)
      .join("\n");

    const correctionPrompt =
      `Your previous response had the following issues (score: ${judgment.score}/10):\n\n` +
      `${issuesList}\n\n` +
      `Suggestion: ${judgment.suggestion}\n\n` +
      `Please provide a corrected and complete response to the original task. ` +
      `Address all issues above. Do not repeat the original flawed response.`;

    // 会話履歴 + 現在の応答 + 修正指示
    const historyMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: currentResponse },
      { role: "user", content: correctionPrompt },
    ];

    try {
      const completion = await this.llmProvider.chatCompletion({
        model: this.llmProvider.getDefaultModel(),
        messages: historyMessages,
        stream: false,
      });

      return completion.choices[0].message.content ?? currentResponse;
    } catch {
      return currentResponse; // エラー時は現状維持
    }
  }

  /** JSON 文字列を EvalJudgment にパースする */
  private parseJudgment(raw: string): EvalJudgment {
    // ```json ... ``` フェンスを除去
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    try {
      const parsed = JSON.parse(cleaned) as Partial<EvalJudgment>;
      const score = Math.min(10, Math.max(0, Number(parsed.score ?? 5)));
      return {
        score,
        passed: score >= this.threshold,
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        suggestion:
          typeof parsed.suggestion === "string" ? parsed.suggestion : "",
      };
    } catch {
      // パース失敗 → 合格扱いにしてフォールバック
      return {
        score: this.threshold,
        passed: true,
        issues: [],
        suggestion: "failed to parse evaluation",
      };
    }
  }

  /** スキップ時のデフォルト結果 */
  private skippedResult(response: string): SelfEvalResult {
    return {
      enabled: true,
      skipped: true,
      initialScore: 0,
      finalScore: 0,
      rounds: 0,
      corrections: [],
      finalResponse: response,
    };
  }
}
