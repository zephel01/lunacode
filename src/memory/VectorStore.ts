/**
 * VectorStore - コサイン類似度ベースのベクトルストア
 *
 * 特徴:
 * - インメモリ + JSON ファイル永続化
 * - コサイン類似度で Top-K 検索
 * - メタデータによるフィルタリング
 * - 最大エントリ数による自動 eviction（古いものから削除）
 */

import * as fs from "fs/promises";
import * as path from "path";

export type MemoryEntryType =
  | "task" // タスクの実行・結果
  | "error" // エラー・解決パターン
  | "code" // コードスニペット・変更
  | "conversation" // 会話の要約
  | "fact"; // プロジェクトに関する事実

export interface VectorMemoryEntry {
  id: string;
  content: string;
  embedding: number[];
  metadata: {
    type: MemoryEntryType;
    timestamp: number;
    sessionId?: string;
    tags?: string[];
    importance?: number; // 0-1: 重要度スコア（eviction 時に考慮）
    source?: string; // 情報源
  };
}

export interface VectorSearchResult {
  entry: VectorMemoryEntry;
  similarity: number; // コサイン類似度 (0-1)
}

export interface VectorStoreConfig {
  /** ストレージファイルパス */
  storagePath: string;
  /** 最大エントリ数（超過時は古い低重要度エントリを削除） */
  maxEntries?: number;
  /** 最小類似度しきい値（これ未満の結果は返さない） */
  minSimilarity?: number;
  /** 自動保存間隔（ミリ秒, 0 で無効） */
  autoSaveIntervalMs?: number;
}

export class VectorStore {
  private entries: Map<string, VectorMemoryEntry> = new Map();
  private readonly storagePath: string;
  private readonly maxEntries: number;
  private readonly minSimilarity: number;
  private isDirty: boolean = false;
  private autoSaveTimer?: ReturnType<typeof setInterval>;

  constructor(config: VectorStoreConfig) {
    this.storagePath = config.storagePath;
    this.maxEntries = config.maxEntries ?? 10_000;
    this.minSimilarity = config.minSimilarity ?? 0.3;

    if (config.autoSaveIntervalMs && config.autoSaveIntervalMs > 0) {
      this.autoSaveTimer = setInterval(
        () => this.saveIfDirty(),
        config.autoSaveIntervalMs,
      );
    }
  }

  // ============================================================
  // 初期化・永続化
  // ============================================================

  async initialize(): Promise<void> {
    const dir = path.dirname(this.storagePath);
    await fs.mkdir(dir, { recursive: true });

    try {
      await fs.access(this.storagePath);
      await this.load();
    } catch {
      // ファイルが存在しない場合は空のストアで開始
      this.entries = new Map();
      await this.save();
    }
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.storagePath, "utf-8");
      const data = JSON.parse(raw) as VectorMemoryEntry[];
      this.entries = new Map(data.map((e) => [e.id, e]));
    } catch (error) {
      console.error("[VectorStore] ロードに失敗しました:", error);
      this.entries = new Map();
    }
  }

  async save(): Promise<void> {
    try {
      const data = Array.from(this.entries.values());
      await fs.writeFile(
        this.storagePath,
        JSON.stringify(data, null, 2),
        "utf-8",
      );
      this.isDirty = false;
    } catch (error) {
      console.error("[VectorStore] 保存に失敗しました:", error);
    }
  }

  async saveIfDirty(): Promise<void> {
    if (this.isDirty) {
      await this.save();
    }
  }

  destroy(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
    }
  }

  // ============================================================
  // CRUD 操作
  // ============================================================

  async add(entry: VectorMemoryEntry): Promise<void> {
    // 容量超過時の eviction
    if (this.entries.size >= this.maxEntries) {
      this.evict();
    }

    this.entries.set(entry.id, entry);
    this.isDirty = true;
  }

  async update(id: string, updates: Partial<VectorMemoryEntry>): Promise<boolean> {
    const existing = this.entries.get(id);
    if (!existing) return false;

    this.entries.set(id, { ...existing, ...updates });
    this.isDirty = true;
    return true;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = this.entries.delete(id);
    if (deleted) this.isDirty = true;
    return deleted;
  }

  get(id: string): VectorMemoryEntry | undefined {
    return this.entries.get(id);
  }

  size(): number {
    return this.entries.size;
  }

  // ============================================================
  // ベクトル検索
  // ============================================================

  /**
   * クエリベクトルに対して上位 K 件を返す（コサイン類似度）
   */
  search(
    queryEmbedding: number[],
    topK: number = 5,
    filter?: Partial<VectorMemoryEntry["metadata"]>,
  ): VectorSearchResult[] {
    const results: VectorSearchResult[] = [];

    for (const entry of this.entries.values()) {
      // メタデータフィルタリング
      if (filter && !this.matchesFilter(entry, filter)) continue;

      const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
      if (similarity >= this.minSimilarity) {
        results.push({ entry, similarity });
      }
    }

    // 類似度降順でソートして Top-K を返す
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  /**
   * テキストの完全一致検索（ベクトル非使用）
   */
  searchByKeyword(keyword: string, topK: number = 5): VectorSearchResult[] {
    const lowerKeyword = keyword.toLowerCase();
    const results: VectorSearchResult[] = [];

    for (const entry of this.entries.values()) {
      if (entry.content.toLowerCase().includes(lowerKeyword)) {
        // キーワード出現頻度で簡易スコアリング
        const matches = (
          entry.content.toLowerCase().match(new RegExp(lowerKeyword, "g")) ?? []
        ).length;
        const similarity = Math.min(0.5 + matches * 0.1, 1.0);
        results.push({ entry, similarity });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  /**
   * タイプ別の最近のエントリを返す
   */
  getRecent(
    type?: MemoryEntryType,
    limit: number = 10,
  ): VectorMemoryEntry[] {
    let entries = Array.from(this.entries.values());
    if (type) {
      entries = entries.filter((e) => e.metadata.type === type);
    }
    return entries
      .sort((a, b) => b.metadata.timestamp - a.metadata.timestamp)
      .slice(0, limit);
  }

  /**
   * タグで検索
   */
  getByTag(tag: string, limit: number = 20): VectorMemoryEntry[] {
    return Array.from(this.entries.values())
      .filter((e) => e.metadata.tags?.includes(tag))
      .sort((a, b) => b.metadata.timestamp - a.metadata.timestamp)
      .slice(0, limit);
  }

  // ============================================================
  // 統計情報
  // ============================================================

  getStats(): {
    totalEntries: number;
    byType: Record<string, number>;
    oldestEntry?: number;
    newestEntry?: number;
  } {
    const byType: Record<string, number> = {};
    let oldest = Infinity;
    let newest = 0;

    for (const entry of this.entries.values()) {
      byType[entry.metadata.type] = (byType[entry.metadata.type] ?? 0) + 1;
      if (entry.metadata.timestamp < oldest) oldest = entry.metadata.timestamp;
      if (entry.metadata.timestamp > newest) newest = entry.metadata.timestamp;
    }

    return {
      totalEntries: this.entries.size,
      byType,
      oldestEntry: oldest === Infinity ? undefined : oldest,
      newestEntry: newest === 0 ? undefined : newest,
    };
  }

  // ============================================================
  // プライベートヘルパー
  // ============================================================

  private evict(): void {
    // 重要度が低く古いエントリを削除（最大エントリ数の 10% を削除）
    const evictCount = Math.max(1, Math.floor(this.maxEntries * 0.1));
    const candidates = Array.from(this.entries.values()).sort((a, b) => {
      // 重要度 * 新しさ でスコアリング（低いものを先に削除）
      const scoreA =
        (a.metadata.importance ?? 0.5) *
        (a.metadata.timestamp / Date.now());
      const scoreB =
        (b.metadata.importance ?? 0.5) *
        (b.metadata.timestamp / Date.now());
      return scoreA - scoreB;
    });

    for (let i = 0; i < evictCount; i++) {
      if (candidates[i]) {
        this.entries.delete(candidates[i].id);
      }
    }
  }

  private matchesFilter(
    entry: VectorMemoryEntry,
    filter: Partial<VectorMemoryEntry["metadata"]>,
  ): boolean {
    if (filter.type && entry.metadata.type !== filter.type) return false;
    if (filter.sessionId && entry.metadata.sessionId !== filter.sessionId) return false;
    if (filter.tags && filter.tags.length > 0) {
      const entryTags = entry.metadata.tags ?? [];
      if (!filter.tags.some((t) => entryTags.includes(t))) return false;
    }
    return true;
  }
}

// ============================================================
// 数学ユーティリティ
// ============================================================

/**
 * 2つのベクトル間のコサイン類似度を計算する（-1 〜 1）
 * 正規化済みベクトル同士なら内積と等しい
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    // 次元が異なる場合は短い方に合わせる
    const minLen = Math.min(a.length, b.length);
    a = a.slice(0, minLen);
    b = b.slice(0, minLen);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * UUID v4 の簡易実装（crypto.randomUUID が使えない環境向け）
 */
export function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // フォールバック実装
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
