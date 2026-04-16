import {
  MemoryCompactionConfig,
  TopicInfo,
  MemorySearchResult,
  CircuitBreakerState,
  CompactionResult,
} from "../types/index.js";
import * as fs from "fs/promises";
import * as path from "path";

export class MemorySystem {
  private basePath: string;
  private memoryPath: string;
  private topicsPath: string;
  private logsPath: string;

  // 圧縮設定
  private compactionConfig: MemoryCompactionConfig;

  // サーキットブレーカー
  private circuitBreaker: CircuitBreakerState;

  // W2-6: 前処理キャッシュ (content → { lines, linesLower, mtime })
  private contentCache = new Map<
    string,
    { lines: string[]; linesLower: string[]; mtime: number }
  >();
  private readonly CACHE_TTL_MS = 60_000; // 60秒キャッシュ

  constructor(
    basePath: string,
    compactionConfig?: Partial<MemoryCompactionConfig>,
  ) {
    this.basePath = basePath;
    this.memoryPath = path.join(basePath, "MEMORY.md");
    this.topicsPath = path.join(basePath, "topics");
    this.logsPath = path.join(basePath, "logs");

    // デフォルト設定
    this.compactionConfig = {
      enabled: true,
      maxContextLines: 200,
      maxMemoryTokens: 200,
      autoCompactThreshold: 500,
      ...compactionConfig,
    };

    // サーキットブレーカー初期化
    this.circuitBreaker = {
      isOpen: false,
      failureCount: 0,
      lastFailureTime: 0,
      nextAttemptTime: 0,
    };
  }

  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.topicsPath, { recursive: true });
      await fs.mkdir(this.logsPath, { recursive: true });

      // MEMORY.mdが存在しない場合は作成
      try {
        await fs.access(this.memoryPath);
      } catch {
        await fs.writeFile(
          this.memoryPath,
          "# LunaCode Memory\n\nThis file contains consolidated information about the project and conversations.\n\n",
          "utf-8",
        );
      }
    } catch (error) {
      console.error("Failed to initialize memory system:", error);
      throw error;
    }
  }

  // ========================================
  // コンテキスト圧縮機能（Phase 1）
  // ========================================

  /**
   * MicroCompact - 小規模なコンテキスト圧縮
   * 似たような行をマージし、重複を削除
   */
  async microCompact(): Promise<CompactionResult> {
    if (!this.compactionConfig.enabled) {
      return {
        originalLines: 0,
        compressedLines: 0,
        compressionRatio: 0,
        topicsCreated: 0,
        topicsMerged: 0,
      };
    }

    try {
      const content = await this.readMemory();
      const lines = content.split("\n");
      const originalLines = lines.length;

      // 重複行の削除
      const uniqueLines = Array.from(new Set(lines));

      // 空行の削除
      const nonEmptyLines = uniqueLines.filter(
        (line) => line.trim().length > 0,
      );

      // ヘッダーの維持
      const header = nonEmptyLines.slice(0, 3);
      const body = nonEmptyLines.slice(3);

      // コンテキストの制限
      const maxLines = this.compactionConfig.maxContextLines;
      const compressedBody = body.slice(0, maxLines);

      const compressedLines = header.length + compressedBody.length;
      const compressionRatio = (1 - compressedLines / originalLines) * 100;

      // 圧縮結果の保存
      const compressedContent = [...header, ...compressedBody].join("\n");
      await this.updateMemory(compressedContent);

      console.log(
        `MicroCompact: ${originalLines} → ${compressedLines} lines (${compressionRatio.toFixed(1)}% reduction)`,
      );

      return {
        originalLines,
        compressedLines,
        compressionRatio,
        topicsCreated: 0,
        topicsMerged: 0,
      };
    } catch (error) {
      console.error("MicroCompact failed:", error);
      throw error;
    }
  }

  /**
   * AutoCompact - 自動的な大規模圧縮
   * トピック別に分類し、重要な情報のみを残す
   */
  async autoCompact(): Promise<CompactionResult> {
    if (!this.compactionConfig.enabled) {
      return {
        originalLines: 0,
        compressedLines: 0,
        compressionRatio: 0,
        topicsCreated: 0,
        topicsMerged: 0,
      };
    }

    try {
      const content = await this.readMemory();
      const lines = content.split("\n");
      const originalLines = lines.length;

      // トピックの自動分類
      const topics = await this.classifyIntoTopics(lines);

      // 重要なセクションのみをメインメモリに残す
      const importantSections = this.extractImportantSections(lines);

      // トピックの保存
      let topicsCreated = 0;
      for (const [topicName, topicContent] of Object.entries(topics)) {
        if (topicContent.trim().length > 0) {
          await this.writeTopic(topicName, topicContent);
          topicsCreated++;
        }
      }

      // 圧縮されたメインメモリの作成
      const compressedMemory = this.buildCompressedMemory(
        importantSections,
        Object.keys(topics),
      );
      await this.updateMemory(compressedMemory);

      const compressedLines = compressedMemory.split("\n").length;
      const compressionRatio = (1 - compressedLines / originalLines) * 100;

      console.log(
        `AutoCompact: ${originalLines} → ${compressedLines} lines (${compressionRatio.toFixed(1)}% reduction, ${topicsCreated} topics created)`,
      );

      return {
        originalLines,
        compressedLines,
        compressionRatio,
        topicsCreated,
        topicsMerged: topicsCreated,
      };
    } catch (error) {
      console.error("AutoCompact failed:", error);
      throw error;
    }
  }

  /**
   * トピックの自動分類
   */
  private async classifyIntoTopics(
    lines: string[],
  ): Promise<Record<string, string>> {
    const topics: Record<string, string> = {
      architecture: "",
      features: "",
      bugs: "",
      tasks: "",
      conversations: "",
      other: "",
    };

    for (const line of lines) {
      const lowerLine = line.toLowerCase();

      if (
        lowerLine.includes("##") &&
        (lowerLine.includes("architect") || lowerLine.includes("design"))
      ) {
        topics.architecture += line + "\n";
      } else if (
        lowerLine.includes("##") &&
        (lowerLine.includes("feature") || lowerLine.includes("implement"))
      ) {
        topics.features += line + "\n";
      } else if (
        lowerLine.includes("##") &&
        (lowerLine.includes("bug") ||
          lowerLine.includes("error") ||
          lowerLine.includes("issue"))
      ) {
        topics.bugs += line + "\n";
      } else if (
        lowerLine.includes("##") &&
        (lowerLine.includes("task") || lowerLine.includes("todo"))
      ) {
        topics.tasks += line + "\n";
      } else if (
        lowerLine.includes("conversation") ||
        lowerLine.includes("user") ||
        lowerLine.includes("assistant")
      ) {
        topics.conversations += line + "\n";
      } else {
        topics.other += line + "\n";
      }
    }

    return topics;
  }

  /**
   * 重要なセクションの抽出
   */
  private extractImportantSections(lines: string[]): string[] {
    const important: string[] = [];
    const maxLines = this.compactionConfig.maxContextLines;

    // プロジェクト概要
    if (lines.length > 0) {
      important.push(lines[0]);
    }

    // 最新の重要なセクション
    for (let i = 1; i < Math.min(lines.length, maxLines); i++) {
      const line = lines[i];

      // ヘッダーを含む行を優先
      if (line.startsWith("#")) {
        important.push(line);
        continue;
      }

      // 前の行がヘッダーの場合は追加
      if (i > 0 && lines[i - 1].startsWith("#")) {
        important.push(line);
      }
    }

    return important;
  }

  /**
   * 圧縮されたメモリの構築
   */
  private buildCompressedMemory(
    sections: string[],
    topicNames: string[],
  ): string {
    const lines = [
      "# LunaCode Memory",
      "",
      "This file contains consolidated information about the project and conversations.",
      "For detailed information, see the topic files in the topics/ directory.",
      "",
      "## Available Topics",
      ...topicNames.map((name) => `- ${name}.md`),
      "",
      ...sections,
    ];

    return lines.join("\n");
  }

  /**
   * サーキットブレーカーの確認
   */
  private checkCircuitBreaker(): void {
    const now = Date.now();

    if (this.circuitBreaker.isOpen) {
      // サーキットが開いている場合、再試行を待機
      if (now >= this.circuitBreaker.nextAttemptTime) {
        this.circuitBreaker.isOpen = false;
        this.circuitBreaker.failureCount = 0;
        console.log("Circuit breaker reopened");
      }
      return;
    }

    // 失敗回数の確認
    if (this.circuitBreaker.failureCount >= 5) {
      this.circuitBreaker.isOpen = true;
      // 30秒後に再試行
      this.circuitBreaker.nextAttemptTime = now + 30000;
      console.log("Circuit breaker opened");
    }
  }

  /**
   * サーキットブレーカーの失敗記録
   */
  private recordCircuitBreakerFailure(error: Error): void {
    this.circuitBreaker.failureCount++;
    this.circuitBreaker.lastFailureTime = Date.now();
    console.error(
      `Circuit breaker failure: ${this.circuitBreaker.failureCount}/5`,
      error,
    );

    if (this.circuitBreaker.failureCount >= 5) {
      this.circuitBreaker.isOpen = true;
      this.circuitBreaker.nextAttemptTime = Date.now() + 30000;
    }
  }

  /**
   * サーキットブレーカーの成功記録
   */
  private recordCircuitBreakerSuccess(): void {
    this.circuitBreaker.failureCount = Math.max(
      0,
      this.circuitBreaker.failureCount - 1,
    );
  }

  // ========================================
  // メモリ検索の最適化（Phase 1）
  // ========================================

  /**
   * W2-6: コンテンツの前処理をキャッシュ付きで取得
   */
  private async getPreprocessedContent(
    filePath: string,
    content: string,
  ): Promise<{ lines: string[]; linesLower: string[] }> {
    try {
      const stat = await fs.stat(filePath);
      const mtime = stat.mtimeMs;

      const cached = this.contentCache.get(filePath);
      if (
        cached &&
        cached.mtime === mtime &&
        Date.now() - mtime < this.CACHE_TTL_MS
      ) {
        return { lines: cached.lines, linesLower: cached.linesLower };
      }

      // 新規前処理
      const lines = content.split("\n");
      const linesLower = lines.map((l) => l.toLowerCase());
      this.contentCache.set(filePath, { lines, linesLower, mtime });
      return { lines, linesLower };
    } catch {
      // stat 失敗時は前処理なしで返す
      const lines = content.split("\n");
      const linesLower = lines.map((l) => l.toLowerCase());
      return { lines, linesLower };
    }
  }

  /**
   * 最適化されたメモリ検索
   * 全てのレイヤーを検索し、関連度をスコアリング
   */
  async searchMemory(
    query: string,
    limit: number = 10,
  ): Promise<MemorySearchResult[]> {
    const results: MemorySearchResult[] = [];
    const queryWords = query.toLowerCase().split(/\s+/);

    // 1. メインメモリ検索（W2-6: キャッシュ付き前処理）
    const memoryContent = await this.readMemory();
    const memoryPreprocessed = await this.getPreprocessedContent(
      this.memoryPath,
      memoryContent,
    );
    const memoryResults = this.searchContent(
      queryWords,
      memoryPreprocessed.lines,
      memoryPreprocessed.linesLower,
      "memory",
    );
    results.push(...memoryResults);

    // 2. トピック検索（並列読み込み + W2-6: キャッシュ付き前処理）
    const topicFiles = await this.listTopics();
    const topicData = await Promise.all(
      topicFiles.map(async (tf) => {
        const content = await this.readTopic(tf);
        const topicPath = path.join(this.topicsPath, `${tf}.md`);
        const preprocessed = await this.getPreprocessedContent(
          topicPath,
          content,
        );
        return { preprocessed };
      }),
    );
    for (const { preprocessed } of topicData) {
      const topicResults = this.searchContent(
        queryWords,
        preprocessed.lines,
        preprocessed.linesLower,
        "topic",
      );
      results.push(...topicResults);
    }

    // 3. ログ検索（制限付き）
    const logResults = await this.searchLogs(query);
    results.push(...logResults.slice(0, limit));

    // 関連度でソート
    results.sort((a, b) => b.relevance - a.relevance);

    return results.slice(0, limit);
  }

  /**
   * コンテンツ検索のヘルパー関数（W2-6: 前処理済みデータを受け取る）
   */
  private searchContent(
    queryWords: string[],
    lines: string[],
    linesLower: string[],
    source: "memory" | "topic",
  ): MemorySearchResult[] {
    const results: MemorySearchResult[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lowerLine = linesLower[i];

      // クエリ単語との一致を確認
      const matchCount = queryWords.filter((word) =>
        lowerLine.includes(word),
      ).length;
      if (matchCount > 0) {
        results.push({
          source,
          content: line,
          relevance: matchCount / queryWords.length,
          timestamp: Date.now(),
        });
      }
    }

    return results;
  }

  /**
   * トピック一覧の取得
   */
  async listTopics(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.topicsPath);
      return files
        .filter((file) => file.endsWith(".md"))
        .map((file) => file.replace(".md", ""));
    } catch {
      return [];
    }
  }

  /**
   * トピック情報の取得
   */
  async getTopicInfo(topicName: string): Promise<TopicInfo | null> {
    try {
      const topicPath = path.join(this.topicsPath, `${topicName}.md`);
      const content = await fs.readFile(topicPath, "utf-8");
      const stat = await fs.stat(topicPath);

      return {
        name: topicName,
        content,
        lineCount: content.split("\n").length,
        lastUpdated: stat.mtimeMs,
      };
    } catch {
      return null;
    }
  }

  // ========================================
  // 基本的なメモリ操作（既存）
  // ========================================

  async readMemory(): Promise<string> {
    try {
      // サーキットブレーカーの確認
      this.checkCircuitBreaker();

      if (this.circuitBreaker.isOpen) {
        return "Error: Memory system is temporarily unavailable";
      }

      const content = await fs.readFile(this.memoryPath, "utf-8");
      this.recordCircuitBreakerSuccess();
      return content;
    } catch (error) {
      this.recordCircuitBreakerFailure(error as Error);
      return "";
    }
  }

  async appendMemory(content: string): Promise<void> {
    try {
      this.checkCircuitBreaker();

      if (this.circuitBreaker.isOpen) {
        throw new Error("Memory system is temporarily unavailable");
      }

      const existing = await this.readMemory();
      await fs.writeFile(this.memoryPath, existing + "\n" + content, "utf-8");

      // 自動圧縮のトリガー
      if (
        existing.split("\n").length > this.compactionConfig.autoCompactThreshold
      ) {
        await this.autoCompact();
      }

      this.recordCircuitBreakerSuccess();
    } catch (error) {
      this.recordCircuitBreakerFailure(error as Error);
      throw error;
    }
  }

  async updateMemory(content: string): Promise<void> {
    try {
      this.checkCircuitBreaker();

      if (this.circuitBreaker.isOpen) {
        throw new Error("Memory system is temporarily unavailable");
      }

      await fs.writeFile(this.memoryPath, content, "utf-8");
      this.recordCircuitBreakerSuccess();
    } catch (error) {
      this.recordCircuitBreakerFailure(error as Error);
      throw error;
    }
  }

  async readTopic(topic: string): Promise<string> {
    const topicPath = path.join(this.topicsPath, `${topic}.md`);
    try {
      return await fs.readFile(topicPath, "utf-8");
    } catch {
      return "";
    }
  }

  async writeTopic(topic: string, content: string): Promise<void> {
    const topicPath = path.join(this.topicsPath, `${topic}.md`);
    try {
      await fs.writeFile(topicPath, content, "utf-8");
    } catch (error) {
      console.error("Failed to write topic:", error);
      throw error;
    }
  }

  async appendToLog(content: string): Promise<void> {
    const date = new Date().toISOString().split("T")[0];
    const logPath = path.join(this.logsPath, `${date}.log`);

    try {
      await fs.appendFile(logPath, content + "\n", "utf-8");
    } catch (error) {
      console.error("Failed to append to log:", error);
      throw error;
    }
  }

  async searchLogs(pattern: string): Promise<MemorySearchResult[]> {
    try {
      const files = await fs.readdir(this.logsPath);
      const results: MemorySearchResult[] = [];
      const queryWords = pattern.toLowerCase().split(/\s+/);

      for (const file of files) {
        if (!file.endsWith(".log")) continue;
        const logPath = path.join(this.logsPath, file);
        const content = await fs.readFile(logPath, "utf-8");
        const lines = content.split("\n");

        for (const line of lines) {
          const lowerLine = line.toLowerCase();
          const matchCount = queryWords.filter((word) =>
            lowerLine.includes(word),
          ).length;

          if (matchCount > 0) {
            results.push({
              source: "log" as const,
              content: `${file}: ${line}`,
              relevance: (matchCount / queryWords.length) * 0.5, // ログは関連度を低めに
              timestamp: Date.now(),
            });
          }
        }
      }

      return results;
    } catch (error) {
      console.error("Failed to search logs:", error);
      return [];
    }
  }

  async getRecentLogs(days: number = 7): Promise<string> {
    try {
      const files = await fs.readdir(this.logsPath);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const recentFiles = files.filter((file) => {
        const fileDate = new Date(file.replace(".log", ""));
        return fileDate >= cutoffDate;
      });

      let results = "";
      for (const file of recentFiles) {
        const logPath = path.join(this.logsPath, file);
        const content = await fs.readFile(logPath, "utf-8");
        results += `=== ${file} ===\n${content}\n\n`;
      }

      return results;
    } catch (error) {
      console.error("Failed to get recent logs:", error);
      return "";
    }
  }

  /**
   * メモリ統合バッチ処理
   */
  async batchConsolidate(maxDays: number = 30): Promise<void> {
    try {
      // 古いログを統合
      const logsContent = await this.getRecentLogs(maxDays);
      const summary = this.summarizeLogs(logsContent);

      // 統合結果をトピックとして保存
      await this.writeTopic(
        `consolidated_${new Date().toISOString().split("T")[0]}`,
        summary,
      );

      // 古いログをアーカイブ
      await this.archiveOldLogs(maxDays);

      console.log(`Batch consolidation completed: ${maxDays} days processed`);
    } catch (error) {
      console.error("Batch consolidation failed:", error);
      throw error;
    }
  }

  /**
   * ログの要約
   */
  private summarizeLogs(logsContent: string): string {
    const lines = logsContent.split("\n");
    const summary: string[] = ["# Log Summary", ""];

    // 活動日数のカウント
    const activityDays = new Set();
    for (const line of lines) {
      const match = line.match(/^=== (\d{4}-\d{2}-\d{2})/);
      if (match) {
        activityDays.add(match[1]);
      }
    }

    summary.push(`Active Days: ${activityDays.size}`);

    // ツール使用統計
    const toolStats = new Map<string, number>();
    for (const line of lines) {
      const match = line.match(/Tool: (\w+)/);
      if (match) {
        const count = toolStats.get(match[1]) || 0;
        toolStats.set(match[1], count + 1);
      }
    }

    summary.push("Tool Usage:");
    const sortedTools = Array.from(toolStats.entries()).sort(
      (a, b) => b[1] - a[1],
    );
    for (const [tool, count] of sortedTools.slice(0, 5)) {
      summary.push(`  - ${tool}: ${count} times`);
    }

    return summary.join("\n");
  }

  /**
   * 古いログのアーカイブ
   */
  private async archiveOldLogs(days: number): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const archivePath = path.join(this.logsPath, "archive");
    await fs.mkdir(archivePath, { recursive: true });

    const files = await fs.readdir(this.logsPath);
    for (const file of files) {
      if (!file.endsWith(".log")) continue;

      const filePath = path.join(this.logsPath, file);
      const stat = await fs.stat(filePath);

      if (stat.mtime < cutoffDate) {
        const archiveFile = path.join(archivePath, file);
        await fs.rename(filePath, archiveFile);
      }
    }
  }

  async compactMemory(): Promise<void> {
    await this.autoCompact();
  }

  async consolidateMemory(): Promise<void> {
    // TODO: Implement memory consolidation logic (autoDream)
    // This will be part of Phase 2
    console.log("Memory consolidation not yet implemented");
  }

  /**
   * 圧縮設定の取得
   */
  getCompactionConfig(): MemoryCompactionConfig {
    return { ...this.compactionConfig };
  }

  /**
   * 圧縮設定の更新
   */
  updateCompactionConfig(config: Partial<MemoryCompactionConfig>): void {
    this.compactionConfig = { ...this.compactionConfig, ...config };
  }

  /**
   * メモリ統計情報の取得
   */
  async getMemoryStats(): Promise<{
    memoryLines: number;
    topicCount: number;
    totalSizeBytes: number;
  }> {
    try {
      // メインメモリの行数
      const memoryContent = await this.readMemory();
      const memoryLines = memoryContent.split("\n").length;

      // トピック数
      const topicCount = (await this.listTopics()).length;

      // 総サイズ
      let totalSize = memoryContent.length;
      const topics = await this.listTopics();
      for (const topic of topics) {
        const content = await this.readTopic(topic);
        totalSize += content.length;
      }

      return {
        memoryLines,
        topicCount,
        totalSizeBytes: totalSize,
      };
    } catch (error) {
      console.error("Failed to get memory stats:", error);
      return {
        memoryLines: 0,
        topicCount: 0,
        totalSizeBytes: 0,
      };
    }
  }
}
