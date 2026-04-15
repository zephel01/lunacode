/**
 * LongTermMemory - セッションを越えた長期記憶システム
 *
 * 役割:
 *   - テキスト + メタデータを受け取り、Embedding を生成して VectorStore に保存
 *   - 自然言語クエリで意味的に近い記憶を検索（セマンティック検索）
 *   - 既存の MemorySystem（ファイルベース）との橋渡し
 *   - AgentLoop に注入するコンテキストを構築
 *
 * ディレクトリ構成:
 *   <basePath>/
 *     MEMORY.md          ← 既存 MemorySystem
 *     topics/            ← 既存
 *     logs/              ← 既存
 *     vectors/
 *       store.json       ← VectorStore の永続化ファイル
 */

import * as path from "path";
import {
  IEmbeddingProvider,
  createAutoEmbeddingProvider,
} from "./EmbeddingProvider.js";
import {
  VectorStore,
  VectorMemoryEntry,
  VectorSearchResult,
  MemoryEntryType,
  generateId,
} from "./VectorStore.js";

// ============================================================
// 型定義
// ============================================================

export interface StoreMemoryOptions {
  type: MemoryEntryType;
  sessionId?: string;
  tags?: string[];
  /** 重要度 0-1（デフォルト 0.5） */
  importance?: number;
  source?: string;
}

export interface LongTermMemoryConfig {
  basePath: string;
  embeddingProvider?: IEmbeddingProvider;
  /** Ollama のベースURL（自動選択時に使用） */
  ollamaBaseUrl?: string;
  /** OpenAI API キー（自動選択時に使用） */
  openAIApiKey?: string;
  /** VectorStore の最大エントリ数 */
  maxEntries?: number;
  /** 最小類似度しきい値 */
  minSimilarity?: number;
  /** 検索結果のデフォルト件数 */
  defaultTopK?: number;
  /** 自動保存間隔（ミリ秒, デフォルト: 60秒） */
  autoSaveIntervalMs?: number;
}

export interface MemoryContext {
  /** エージェントのシステムプロンプトに注入するコンテキスト文字列 */
  contextText: string;
  /** 取得された記憶エントリ */
  entries: VectorSearchResult[];
  /** 使用された埋め込みプロバイダー */
  embeddingProvider: string;
}

// ============================================================
// LongTermMemory クラス
// ============================================================

export class LongTermMemory {
  private vectorStore: VectorStore;
  private embeddingProvider?: IEmbeddingProvider;
  private readonly config: Required<
    Omit<LongTermMemoryConfig, "embeddingProvider" | "ollamaBaseUrl" | "openAIApiKey">
  > & { ollamaBaseUrl?: string; openAIApiKey?: string };
  private initialized: boolean = false;

  constructor(config: LongTermMemoryConfig) {
    this.config = {
      basePath: config.basePath,
      maxEntries: config.maxEntries ?? 10_000,
      minSimilarity: config.minSimilarity ?? 0.3,
      defaultTopK: config.defaultTopK ?? 5,
      autoSaveIntervalMs: config.autoSaveIntervalMs ?? 60_000,
      ollamaBaseUrl: config.ollamaBaseUrl,
      openAIApiKey: config.openAIApiKey,
    };

    this.embeddingProvider = config.embeddingProvider;

    const vectorsPath = path.join(config.basePath, "vectors", "store.json");
    this.vectorStore = new VectorStore({
      storagePath: vectorsPath,
      maxEntries: this.config.maxEntries,
      minSimilarity: this.config.minSimilarity,
      autoSaveIntervalMs: this.config.autoSaveIntervalMs,
    });
  }

  // ============================================================
  // 初期化
  // ============================================================

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // VectorStore の初期化
    await this.vectorStore.initialize();

    // Embedding プロバイダーの初期化（未設定なら自動選択）
    if (!this.embeddingProvider) {
      this.embeddingProvider = await createAutoEmbeddingProvider(
        this.config.ollamaBaseUrl,
        this.config.openAIApiKey,
      );
    }

    this.initialized = true;
    console.log(
      `[LongTermMemory] 初期化完了 | プロバイダー: ${this.embeddingProvider.getProviderName()} | エントリ数: ${this.vectorStore.size()}`,
    );
  }

  // ============================================================
  // 記憶の保存
  // ============================================================

  /**
   * テキストを長期記憶に保存する
   * @param content 保存するテキスト
   * @param options メタデータオプション
   * @returns 保存されたエントリのID
   */
  async store(content: string, options: StoreMemoryOptions): Promise<string> {
    await this.ensureInitialized();

    const embedding = await this.generateEmbeddingSafe(content);
    const id = generateId();
    const entry: VectorMemoryEntry = {
      id,
      content,
      embedding,
      metadata: {
        type: options.type,
        timestamp: Date.now(),
        sessionId: options.sessionId,
        tags: options.tags ?? [],
        importance: options.importance ?? 0.5,
        source: options.source,
      },
    };

    await this.vectorStore.add(entry);
    return id;
  }

  /**
   * タスク実行結果を保存する（よく使うヘルパー）
   */
  async storeTaskResult(
    task: string,
    result: string,
    sessionId?: string,
    success: boolean = true,
  ): Promise<string> {
    const content = `タスク: ${task}\n結果: ${result}`;
    return this.store(content, {
      type: "task",
      sessionId,
      tags: [success ? "success" : "failure"],
      importance: success ? 0.6 : 0.8, // 失敗は高重要度（再発防止）
      source: "agent_loop",
    });
  }

  /**
   * エラーと解決パターンを保存する
   */
  async storeError(
    errorMessage: string,
    context: string,
    resolution?: string,
    sessionId?: string,
  ): Promise<string> {
    const content = resolution
      ? `エラー: ${errorMessage}\nコンテキスト: ${context}\n解決方法: ${resolution}`
      : `エラー: ${errorMessage}\nコンテキスト: ${context}`;

    return this.store(content, {
      type: "error",
      sessionId,
      tags: ["error", resolution ? "resolved" : "unresolved"],
      importance: resolution ? 0.9 : 0.7,
      source: "error_handler",
    });
  }

  /**
   * コードの変更・重要なスニペットを保存する
   */
  async storeCode(
    description: string,
    code: string,
    filePath?: string,
    sessionId?: string,
  ): Promise<string> {
    const content = filePath
      ? `ファイル: ${filePath}\n説明: ${description}\nコード:\n${code}`
      : `説明: ${description}\nコード:\n${code}`;

    return this.store(content, {
      type: "code",
      sessionId,
      tags: filePath ? ["code", filePath.split(".").pop() ?? ""] : ["code"],
      importance: 0.7,
      source: filePath,
    });
  }

  /**
   * 会話の重要なやり取りを保存する
   */
  async storeConversation(
    summary: string,
    sessionId?: string,
    importance: number = 0.5,
  ): Promise<string> {
    return this.store(summary, {
      type: "conversation",
      sessionId,
      tags: ["conversation"],
      importance,
      source: "conversation",
    });
  }

  // ============================================================
  // 記憶の検索
  // ============================================================

  /**
   * セマンティック検索（意味的に近い記憶を返す）
   * @param query 検索クエリ（自然言語）
   * @param topK 返す件数
   * @param filter メタデータフィルタ
   */
  async search(
    query: string,
    topK?: number,
    filter?: Partial<VectorMemoryEntry["metadata"]>,
  ): Promise<VectorSearchResult[]> {
    await this.ensureInitialized();

    const k = topK ?? this.config.defaultTopK;
    const queryEmbedding = await this.generateEmbeddingSafe(query);

    // ベクトル検索
    const vectorResults = this.vectorStore.search(queryEmbedding, k * 2, filter);

    // キーワード検索と合算（ハイブリッド検索）
    const keywordResults = this.vectorStore.searchByKeyword(query, k);
    const merged = this.mergeResults(vectorResults, keywordResults, k);

    return merged;
  }

  /**
   * AgentLoop に注入するコンテキストを構築する
   * @param userQuery ユーザーの入力
   * @param maxTokens コンテキストの最大トークン数目安
   */
  async buildContext(
    userQuery: string,
    maxTokens: number = 1500,
  ): Promise<MemoryContext> {
    await this.ensureInitialized();

    const results = await this.search(userQuery, 8);

    if (results.length === 0) {
      return {
        contextText: "",
        entries: [],
        embeddingProvider: this.embeddingProvider!.getProviderName(),
      };
    }

    const contextLines: string[] = [
      "## 関連する過去の記憶",
      "",
    ];

    let usedChars = 100;
    const maxChars = maxTokens * 4; // 1 token ≈ 4 chars
    const filteredResults: VectorSearchResult[] = [];

    for (const result of results) {
      const line = `[${result.entry.metadata.type}] (類似度: ${(result.similarity * 100).toFixed(0)}%) ${result.entry.content}`;
      if (usedChars + line.length > maxChars) break;

      contextLines.push(
        `### [${result.entry.metadata.type}] - 類似度: ${(result.similarity * 100).toFixed(0)}%`,
      );
      contextLines.push(result.entry.content);
      contextLines.push("");

      usedChars += line.length;
      filteredResults.push(result);
    }

    return {
      contextText: contextLines.join("\n"),
      entries: filteredResults,
      embeddingProvider: this.embeddingProvider!.getProviderName(),
    };
  }

  /**
   * 最近のエントリを取得
   */
  getRecent(type?: MemoryEntryType, limit?: number): VectorMemoryEntry[] {
    return this.vectorStore.getRecent(type, limit);
  }

  /**
   * タグで検索
   */
  getByTag(tag: string, limit?: number): VectorMemoryEntry[] {
    return this.vectorStore.getByTag(tag, limit);
  }

  // ============================================================
  // 削除・クリーンアップ
  // ============================================================

  async delete(id: string): Promise<boolean> {
    return this.vectorStore.delete(id);
  }

  /**
   * 古いエントリをクリーンアップ（指定日数以上古いもの）
   */
  async cleanup(olderThanDays: number = 90): Promise<number> {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const allEntries = this.vectorStore.getRecent(undefined, Infinity as number);
    let deleted = 0;

    for (const entry of allEntries) {
      if (entry.metadata.timestamp < cutoff && (entry.metadata.importance ?? 0.5) < 0.8) {
        await this.vectorStore.delete(entry.id);
        deleted++;
      }
    }

    if (deleted > 0) {
      await this.vectorStore.save();
    }
    return deleted;
  }

  // ============================================================
  // 統計・状態
  // ============================================================

  async flush(): Promise<void> {
    await this.vectorStore.save();
  }

  getStats() {
    return this.vectorStore.getStats();
  }

  getEmbeddingProviderName(): string {
    return this.embeddingProvider?.getProviderName() ?? "not initialized";
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  destroy(): void {
    this.vectorStore.destroy();
  }

  // ============================================================
  // プライベートヘルパー
  // ============================================================

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Embedding 生成（エラー時はゼロベクトルを返す）
   */
  private async generateEmbeddingSafe(text: string): Promise<number[]> {
    try {
      return await this.embeddingProvider!.generateEmbedding(text);
    } catch (error) {
      console.warn("[LongTermMemory] Embedding 生成に失敗:", error);
      // フォールバック: ゼロベクトル（検索時にはヒットしにくい）
      const dim = this.embeddingProvider!.getDimension();
      return new Array(dim).fill(0);
    }
  }

  /**
   * ベクトル検索とキーワード検索の結果をマージする（RRF: Reciprocal Rank Fusion）
   */
  private mergeResults(
    vectorResults: VectorSearchResult[],
    keywordResults: VectorSearchResult[],
    topK: number,
  ): VectorSearchResult[] {
    const scoreMap = new Map<string, { result: VectorSearchResult; score: number }>();
    const K = 60; // RRF 定数

    // ベクトル検索のスコアリング
    vectorResults.forEach((r, rank) => {
      const id = r.entry.id;
      const score = 1 / (K + rank);
      scoreMap.set(id, { result: r, score });
    });

    // キーワード検索のスコアリング（既存エントリには加算）
    keywordResults.forEach((r, rank) => {
      const id = r.entry.id;
      const rrfScore = 1 / (K + rank);
      const existing = scoreMap.get(id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(id, { result: r, score: rrfScore });
      }
    });

    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((v) => v.result);
  }
}
