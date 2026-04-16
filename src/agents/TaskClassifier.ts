import type { TaskType } from "../types/index.js";

export type TaskComplexity = "simple" | "moderate" | "complex";

export interface ClassificationResult {
  complexity: TaskComplexity;
  reason: string;
  suggestedModel: "light" | "heavy";
  /** Phase 15: タスクの種別（ルーティング高度化で使用） */
  taskType: TaskType;
}

export class TaskClassifier {
  private complexIndicators: RegExp[] = [
    /リファクタ|refactor/i,
    /設計|design|architect/i,
    /デバッグ|debug|修正.*バグ|fix.*bug/i,
    /テスト.*作成|テスト.*書|write.*test|create.*test/i,
    /複数.*ファイル|multi.*file|several.*file/i,
    /パフォーマンス|optimize|最適化|performance/i,
    /セキュリティ|security|脆弱性|vulnerability/i,
    /移行|migrate|migration/i,
    /実装|implement|build.*feature/i,
  ];

  private simpleIndicators: RegExp[] = [
    /^(何|what|how|who|when|where|why)\b/i,
    /教えて|explain|説明|describe/i,
    /読んで|read|表示|show|見せて/i,
    /一覧|list|ls\b/i,
    /確認|check|verify|status/i,
    /ヘルプ|help|\?$/i,
  ];

  // Phase 15: タスク種別パターン（上から順に評価、最初にマッチしたものを採用）
  private taskTypePatterns: { type: TaskType; patterns: RegExp[] }[] = [
    {
      type: "debugging",
      patterns: [
        /デバッグ|debug|修正.*バグ|fix.*bug|エラー.*修正|fix.*error/i,
        /なぜ.*動かない|why.*not.*work|原因|cause.*error/i,
      ],
    },
    {
      type: "refactoring",
      patterns: [
        /リファクタ|refactor|リネーム|rename|整理|clean.*up/i,
        /移行|migrate|migration|アップグレード|upgrade/i,
      ],
    },
    {
      type: "code_review",
      patterns: [
        /レビュー|review|チェック.*コード|check.*code|改善点|improve/i,
        /セキュリティ|security|脆弱性|vulnerability|監査|audit/i,
      ],
    },
    {
      type: "code_generation",
      patterns: [
        /実装|implement|build|作成|create|書いて|write.*code/i,
        /追加|add.*feature|新規|new.*function|テスト.*作成|write.*test/i,
        /コンポーネント|component|モジュール|module|API|endpoint/i,
      ],
    },
    {
      type: "summarization",
      patterns: [
        /要約|summarize|summary|まとめ|概要|overview/i,
        /説明|explain|教えて|describe|ドキュメント|document/i,
      ],
    },
  ];

  classify(
    userInput: string,
    context?: { iteration?: number; toolResultCount?: number },
  ): ClassificationResult {
    const input = userInput.toLowerCase();
    const length = userInput.length;

    const complexScore = this.complexIndicators.filter((r) =>
      r.test(input),
    ).length;
    const simpleScore = this.simpleIndicators.filter((r) =>
      r.test(input),
    ).length;

    // Longer input suggests more complexity
    const lengthScore =
      length > 300 ? 1.5 : length > 150 ? 1 : length > 80 ? 0.5 : 0;

    // If already deep in iteration, task is complex
    const iterationScore = (context?.iteration ?? 0) > 3 ? 0.5 : 0;

    const totalScore =
      complexScore - simpleScore + lengthScore + iterationScore;

    const taskType = this.classifyTaskType(input);

    if (totalScore >= 1.5) {
      return {
        complexity: "complex",
        reason: this.buildReason(complexScore, lengthScore, "complex"),
        suggestedModel: "heavy",
        taskType,
      };
    } else if (totalScore <= -0.5) {
      return {
        complexity: "simple",
        reason: this.buildReason(simpleScore, 0, "simple"),
        suggestedModel: "light",
        taskType,
      };
    }
    return {
      complexity: "moderate",
      reason: "Moderate complexity - using heavy model for safety",
      suggestedModel: "heavy",
      taskType,
    };
  }

  /** タスク種別を判定する（Phase 15） */
  classifyTaskType(input: string): TaskType {
    for (const { type, patterns } of this.taskTypePatterns) {
      if (patterns.some((p) => p.test(input))) {
        return type;
      }
    }
    return "general";
  }

  private buildReason(
    matchCount: number,
    lengthScore: number,
    type: string,
  ): string {
    const parts: string[] = [];
    if (matchCount > 0) parts.push(`${matchCount} ${type} indicator(s)`);
    if (lengthScore > 0) parts.push("long input");
    return parts.length > 0
      ? parts.join(", ")
      : `Default ${type} classification`;
  }
}
