export type TaskComplexity = "simple" | "moderate" | "complex";

export interface ClassificationResult {
  complexity: TaskComplexity;
  reason: string;
  suggestedModel: "light" | "heavy";
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

    if (totalScore >= 1.5) {
      return {
        complexity: "complex",
        reason: this.buildReason(complexScore, lengthScore, "complex"),
        suggestedModel: "heavy",
      };
    } else if (totalScore <= -0.5) {
      return {
        complexity: "simple",
        reason: this.buildReason(simpleScore, 0, "simple"),
        suggestedModel: "light",
      };
    }
    return {
      complexity: "moderate",
      reason:
        "Moderate complexity - using heavy model for safety",
      suggestedModel: "heavy",
    };
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
