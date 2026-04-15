import { MemorySystem } from "../memory/MemorySystem.js";
import { DreamState, DreamSettings } from "../types/index.js";
import { ILLMProvider } from "../providers/LLMProvider.js";
import * as fs from "fs/promises";
import * as path from "path";

/**
 * ドリーム統合結果
 */
export interface DreamConsolidationResult {
  logsProcessed: number;
  contradictionsResolved: number;
  insightsExtracted: number;
  memoriesCompressed: number;
  topicsCreated: number;
  durationMs: number;
}

/**
 * 洞察結果
 */
export interface InsightResult {
  content: string;
  confidence: number;
  sourceLines: number[];
  category: "fact" | "pattern" | "recommendation" | "warning";
}

/**
 * 矛盾解決結果
 */
export interface ContradictionResult {
  type: string;
  conflictA: string;
  conflictB: string;
  resolution: string;
  confidence: number;
}

/**
 * AutoDream - メモリ統合・洞察抽出機能
 *
 * Claude CodeのautoDream実装に基づいた機能：
 * - 夜間のメモリ統合
 * - 矛盾の自動解消
 * - 洞察の抽出と確定化
 * - 長期記憶の維持・最適化
 */
export class AutoDream {
  private memorySystem: MemorySystem;
  private llmProvider: ILLMProvider | null;
  private basePath: string;
  private dreamLogPath: string;
  private state: DreamState;

  constructor(
    basePath: string,
    memorySystem: MemorySystem,
    llmProvider?: ILLMProvider,
  ) {
    this.basePath = basePath;
    this.memorySystem = memorySystem;
    this.llmProvider = llmProvider || null;
    this.dreamLogPath = path.join(basePath, ".kairos", "dreams");
    this.state = {
      isRunning: false,
      startTime: 0,
      durationSeconds: 0,
      memoryConsolidated: false,
      contradictionsResolved: 0,
      insightsExtracted: 0,
    };
  }

  /**
   * ドリームモードの初期化
   */
  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.dreamLogPath, { recursive: true });
      console.log("✅ AutoDream initialized");
    } catch (error) {
      console.error("Failed to initialize AutoDream:", error);
      throw error;
    }
  }

  /**
   * ドリームモードの実行
   */
  async run(_settings: DreamSettings): Promise<DreamConsolidationResult> {
    if (this.state.isRunning) {
      throw new Error("Dream is already running");
    }

    console.log("🌙 Starting AutoDream mode...");

    const startTime = Date.now();
    this.state.isRunning = true;
    this.state.startTime = startTime;

    try {
      // ステップ1: メモリ統合
      console.log("\n📊 Step 1: Memory consolidation...");
      const consolidationResult = await this.consolidateMemory();

      // ステップ2: 矛盾解決
      console.log("\n🔍 Step 2: Resolving contradictions...");
      const contradictions = await this.resolveContradictions();
      this.state.contradictionsResolved = contradictions.length;

      // ステップ3: 洞察抽出
      console.log("\n💡 Step 3: Extracting insights...");
      const insights = await this.extractInsights();
      this.state.insightsExtracted = insights.length;

      // ステップ4: メモリ圧縮・修復
      console.log("\n🗜️  Step 4: Compressing and repairing memory...");
      const compactionResult = await this.compressAndRepairMemory();

      // ドリームログの保存
      await this.logDream({
        ...consolidationResult,
        contradictionsResolved: this.state.contradictionsResolved,
        insightsExtracted: this.state.insightsExtracted,
        memoriesCompressed: compactionResult.memoriesCompressed,
        topicsCreated: compactionResult.topicsCreated,
        durationMs: Date.now() - startTime,
      });

      const endTime = Date.now();
      this.state.durationSeconds = (endTime - startTime) / 1000;
      this.state.isRunning = false;
      this.state.memoryConsolidated = true;

      console.log("\n✅ AutoDream completed successfully");
      console.log(`   Duration: ${this.state.durationSeconds.toFixed(1)}s`);
      console.log(
        `   Contradictions resolved: ${this.state.contradictionsResolved}`,
      );
      console.log(`   Insights extracted: ${this.state.insightsExtracted}`);
      console.log(
        `   Memories compressed: ${compactionResult.memoriesCompressed}`,
      );
      console.log(`   Topics created: ${compactionResult.topicsCreated}`);

      return {
        ...consolidationResult,
        contradictionsResolved: this.state.contradictionsResolved,
        insightsExtracted: this.state.insightsExtracted,
        memoriesCompressed: compactionResult.memoriesCompressed,
        topicsCreated: compactionResult.topicsCreated,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      this.state.isRunning = false;
      console.error("❌ AutoDream failed:", error);
      throw error;
    }
  }

  /**
   * メモリ統合 - ログの統合
   */
  private async consolidateMemory(): Promise<
    Pick<DreamConsolidationResult, "logsProcessed">
  > {
    const logsPath = path.join(this.basePath, ".kairos", "logs");
    let logsProcessed = 0;

    try {
      // 最近のログファイルを取得
      const files = await fs.readdir(logsPath);
      const logFiles = files
        .filter((f) => f.endsWith(".log"))
        .sort()
        .reverse()
        .slice(0, 30); // 最大30日分

      logsProcessed = logFiles.length;

      for (const logFile of logFiles) {
        const logPath = path.join(logsPath, logFile);
        const content = await fs.readFile(logPath, "utf-8");

        // 重要な情報を抽出してトピック化
        await this.extractTopicsFromLogs(content, logFile.replace(".log", ""));
      }

      console.log(`   Processed ${logsProcessed} log files`);

      return { logsProcessed };
    } catch (error) {
      console.error("Error consolidating memory:", error);
      return { logsProcessed };
    }
  }

  /**
   * ログからのトピック抽出
   */
  private async extractTopicsFromLogs(
    logContent: string,
    date: string,
  ): Promise<void> {
    const lines = logContent.split("\n");
    const activities: Map<string, string[]> = new Map();

    // 活動タイプごとにグループ化
    for (const line of lines) {
      if (line.includes("Tool:")) {
        const toolName = line.match(/Tool: (\w+)/)?.[1];
        if (toolName) {
          if (!activities.has(toolName)) {
            activities.set(toolName, []);
          }
          activities.get(toolName)!.push(line);
        }
      }
    }

    // 重要な活動をトピックとして保存
    for (const [activity, details] of activities) {
      if (details.length >= 3) {
        // 3回以上使用されたツールのみ
        const topicName = `activity_${activity}_${date}`;
        const content = [
          `# ${activity} Activity - ${date}`,
          "",
          `**Usage Count:** ${details.length}`,
          "",
          "## Recent Uses:",
          ...details.slice(0, 5).map((d) => `- ${d}`),
          "",
          "## Pattern:",
          this.detectPattern(details),
        ].join("\n");

        await this.memorySystem.writeTopic(topicName, content);
      }
    }
  }

  /**
   * パターン検出
   */
  private detectPattern(details: string[]): string {
    // 簡易的なパターン検出
    if (details.some((d) => d.includes("error"))) {
      return "Some executions resulted in errors. Consider reviewing error handling.";
    }
    if (details.some((d) => d.includes("success"))) {
      return "Most executions were successful. This activity is stable.";
    }
    return "Regular activity pattern detected.";
  }

  /**
   * 矛盾解決
   */
  private async resolveContradictions(): Promise<ContradictionResult[]> {
    const contradictions: ContradictionResult[] = [];

    if (!this.llmProvider) {
      console.log(
        "   LLM provider not available, skipping advanced contradiction resolution",
      );
      return contradictions;
    }

    try {
      // メモリとトピックの内容を取得
      const memoryContent = await this.memorySystem.readMemory();
      const topics = await this.memorySystem.listTopics();

      // トピックごとに矛盾をチェック
      for (const topicName of topics) {
        const topic = await this.memorySystem.getTopicInfo(topicName);
        if (!topic) continue;

        const conflicts = await this.detectConflicts(
          memoryContent,
          topic.content,
        );

        for (const conflict of conflicts) {
          const resolution = await this.resolveConflict(conflict);

          if (resolution) {
            contradictions.push(resolution);

            // 解決策を適用
            await this.applyResolution(resolution);
          }
        }
      }

      console.log(`   Resolved ${contradictions.length} contradictions`);
    } catch (error) {
      console.error("Error resolving contradictions:", error);
    }

    return contradictions;
  }

  /**
   * 矛盾の検出
   */
  private async detectConflicts(
    memoryContent: string,
    topicContent: string,
  ): Promise<Array<{ conflictA: string; conflictB: string }>> {
    const conflicts: Array<{ conflictA: string; conflictB: string }> = [];

    // 矛盾ペアのキーワードセット
    const contradictionPairs = [
      ["enabled", "disabled"],
      ["true", "false"],
      ["yes", "no"],
      ["working", "not working"],
    ];

    // 全キーワードのセット（前フィルタ用）
    const allKeywords = new Set<string>();
    for (const [a, b] of contradictionPairs) {
      allKeywords.add(a);
      allKeywords.add(b);
    }

    // キーワードを含む行のみ抽出（O(n) フィルタリング）
    const hasKeyword = (line: string): boolean => {
      const lower = line.toLowerCase();
      for (const kw of allKeywords) {
        if (lower.includes(kw)) return true;
      }
      return false;
    };

    const memoryLines = memoryContent.split("\n").filter(hasKeyword);
    const topicLines = topicContent.split("\n").filter(hasKeyword);

    // フィルタ済み行のみ比較（大幅に候補数を削減）
    for (const memLine of memoryLines) {
      for (const topicLine of topicLines) {
        if (this.areContradictory(memLine, topicLine)) {
          conflicts.push({
            conflictA: memLine,
            conflictB: topicLine,
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * 矛盾の判定
   */
  private areContradictory(statementA: string, statementB: string): boolean {
    // 簡易的な矛盾判定
    const contradictions = [
      ["enabled", "disabled"],
      ["true", "false"],
      ["yes", "no"],
      ["working", "not working"],
    ];

    for (const [a, b] of contradictions) {
      if (
        statementA.toLowerCase().includes(a) &&
        statementB.toLowerCase().includes(b)
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * 矛盾の解決
   */
  private async resolveConflict(conflict: {
    conflictA: string;
    conflictB: string;
  }): Promise<ContradictionResult | null> {
    if (!this.llmProvider) {
      return null;
    }

    try {
      const prompt = [
        "You are tasked with resolving contradictory statements in memory.",
        "",
        "Conflict A:",
        conflict.conflictA,
        "",
        "Conflict B:",
        conflict.conflictB,
        "",
        "Please provide a resolution that best represents the truth.",
        "Format your response as JSON:",
        "{",
        '  "resolution": "the resolved statement",',
        '  "confidence": 0.0 to 1.0,',
        '  "explanation": "brief explanation"',
        "}",
      ].join("\n");

      const response = await this.llmProvider.generateResponse(prompt, {
        temperature: 0.3,
        maxTokens: 200,
      });

      // JSONパースを試みる
      try {
        const result = JSON.parse(response);

        return {
          type: "contradiction",
          conflictA: conflict.conflictA,
          conflictB: conflict.conflictB,
          resolution: result.resolution,
          confidence: result.confidence || 0.5,
        };
      } catch {
        // JSONパース失敗時は簡易的な解決策を返す
        return {
          type: "contradiction",
          conflictA: conflict.conflictA,
          conflictB: conflict.conflictB,
          resolution: `Conflicting information: "${conflict.conflictA}" vs "${conflict.conflictB}"`,
          confidence: 0.3,
        };
      }
    } catch (error) {
      console.error("Error resolving conflict:", error);
      return null;
    }
  }

  /**
   * 解決策の適用
   */
  private async applyResolution(
    resolution: ContradictionResult,
  ): Promise<void> {
    // 解決策をメモリに追加
    const note = [
      `### Contradiction Resolved (${new Date().toISOString()})`,
      "",
      `**Conflicts:**`,
      `- ${resolution.conflictA}`,
      `- ${resolution.conflictB}`,
      "",
      `**Resolution:**`,
      `${resolution.resolution}`,
      "",
      `**Confidence:** ${(resolution.confidence * 100).toFixed(0)}%`,
    ].join("\n");

    await this.memorySystem.appendMemory(note);
  }

  /**
   * 洞察抽出
   */
  private async extractInsights(): Promise<InsightResult[]> {
    const insights: InsightResult[] = [];

    if (!this.llmProvider) {
      console.log("   LLM provider not available, skipping insight extraction");
      return insights;
    }

    try {
      const memoryContent = await this.memorySystem.readMemory();
      const topics = await this.memorySystem.listTopics();

      // メモリから洞察を抽出
      const memoryInsights = await this.extractInsightsFromContent(
        memoryContent,
        "memory",
      );
      insights.push(...memoryInsights);

      // トピックから洞察を抽出
      for (const topicName of topics) {
        const topic = await this.memorySystem.readTopic(topicName);
        const topicInsights = await this.extractInsightsFromContent(
          topic,
          `topic:${topicName}`,
        );
        insights.push(...topicInsights);
      }

      console.log(`   Extracted ${insights.length} insights`);

      // 高信頼度の洞察をメモリに保存
      const highConfidenceInsights = insights.filter((i) => i.confidence > 0.7);
      await this.saveInsights(highConfidenceInsights);
    } catch (error) {
      console.error("Error extracting insights:", error);
    }

    return insights;
  }

  /**
   * コンテンツからの洞察抽出
   */
  private async extractInsightsFromContent(
    content: string,
    _source: string,
  ): Promise<InsightResult[]> {
    if (!this.llmProvider) {
      return [];
    }

    try {
      const prompt = [
        "Extract insights from the following content.",
        "An insight is a meaningful pattern, fact, or recommendation derived from the data.",
        "",
        "Content:",
        content.substring(0, 3000), // 最初の3000文字のみ
        "",
        "Extract 3-5 key insights and format as JSON:",
        "{",
        '  "insights": [',
        "    {",
        '      "content": "the insight",',
        '      "confidence": 0.0 to 1.0,',
        '      "category": "fact" | "pattern" | "recommendation" | "warning"',
        "    }",
        "  ]",
        "}",
      ].join("\n");

      const response = await this.llmProvider.generateResponse(prompt, {
        temperature: 0.4,
        maxTokens: 500,
      });

      try {
        const result = JSON.parse(response);

        return (result.insights || []).map((insight: { content: string; confidence?: number; category?: string }) => ({
          content: insight.content,
          confidence: insight.confidence || 0.5,
          sourceLines: [],
          category: insight.category || "fact",
        }));
      } catch {
        // JSONパース失敗時は空を返す
        return [];
      }
    } catch (error) {
      console.error("Error extracting insights from content:", error);
      return [];
    }
  }

  /**
   * 洞察の保存
   */
  private async saveInsights(insights: InsightResult[]): Promise<void> {
    if (insights.length === 0) {
      return;
    }

    const timestamp = new Date().toISOString().split("T")[0];
    const insightTopic = `insights_${timestamp}`;

    const content = [
      `# Insights - ${timestamp}`,
      "",
      `**Total Insights:** ${insights.length}`,
      "",
      "## Key Insights:",
      ...insights.map((insight) =>
        [
          `### ${insight.category.charAt(0).toUpperCase() + insight.category.slice(1)}`,
          `${insight.content}`,
          `*Confidence: ${(insight.confidence * 100).toFixed(0)}%*`,
        ].join("\n"),
      ),
    ].join("\n");

    await this.memorySystem.writeTopic(insightTopic, content);
  }

  /**
   * メモリ圧縮・修復
   */
  private async compressAndRepairMemory(): Promise<
    Pick<DreamConsolidationResult, "memoriesCompressed" | "topicsCreated">
  > {
    try {
      // 既存のautoCompact機能を使用
      const result = await this.memorySystem.autoCompact();

      console.log(
        `   Compressed ${result.originalLines - result.compressedLines} lines`,
      );
      console.log(`   Created ${result.topicsCreated} topics`);

      return {
        memoriesCompressed: result.compressedLines,
        topicsCreated: result.topicsCreated,
      };
    } catch (error) {
      console.error("Error compressing and repairing memory:", error);
      return {
        memoriesCompressed: 0,
        topicsCreated: 0,
      };
    }
  }

  /**
   * ドリームログの保存
   */
  private async logDream(result: DreamConsolidationResult): Promise<void> {
    const timestamp = new Date().toISOString();
    const logPath = path.join(
      this.dreamLogPath,
      `dream_${timestamp.replace(/[:.]/g, "-")}.log`,
    );

    const logContent = [
      "# Dream Log",
      "",
      `**Timestamp:** ${timestamp}`,
      `**Duration:** ${(result.durationMs / 1000).toFixed(1)}s`,
      "",
      "## Results:",
      `- Logs processed: ${result.logsProcessed}`,
      `- Contradictions resolved: ${result.contradictionsResolved}`,
      `- Insights extracted: ${result.insightsExtracted}`,
      `- Memories compressed: ${result.memoriesCompressed}`,
      `- Topics created: ${result.topicsCreated}`,
      "",
      "---",
      "",
    ].join("\n");

    try {
      await fs.writeFile(logPath, logContent, "utf-8");
    } catch (error) {
      console.error("Error writing dream log:", error);
    }
  }

  /**
   * ドリーム状態の取得
   */
  getState(): DreamState {
    return { ...this.state };
  }

  /**
   * ドリーム履歴の取得
   */
  async getDreamHistory(limit: number = 10): Promise<string[]> {
    try {
      const files = await fs.readdir(this.dreamLogPath);
      return files
        .filter((f) => f.endsWith(".log"))
        .sort()
        .reverse()
        .slice(0, limit);
    } catch {
      return [];
    }
  }
}
