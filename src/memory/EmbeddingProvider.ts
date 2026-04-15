/**
 * EmbeddingProvider - テキストをベクトル（埋め込み）に変換するプロバイダー
 *
 * 優先順位:
 *   1. Ollama (nomic-embed-text) - ローカル完結
 *   2. OpenAI (text-embedding-3-small) - クラウドAPI
 *   3. TF-IDF Fallback - 外部依存なし・常に動作
 */

export interface IEmbeddingProvider {
  generateEmbedding(text: string): Promise<number[]>;
  getDimension(): number;
  getProviderName(): string;
}

export type EmbeddingProviderType = "ollama" | "openai" | "tfidf";

export interface EmbeddingConfig {
  type: EmbeddingProviderType;
  /** Ollama の場合: ベースURL（デフォルト: http://localhost:11434） */
  baseUrl?: string;
  /** 埋め込みモデル名 */
  model?: string;
  /** OpenAI の場合: APIキー */
  apiKey?: string;
  /** タイムアウト（ミリ秒, デフォルト: 30秒） */
  timeoutMs?: number;
}

// ============================================================
// Ollama Embedding Provider
// ============================================================

export class OllamaEmbeddingProvider implements IEmbeddingProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private dimension: number = 768; // nomic-embed-text のデフォルト次元数

  constructor(config: EmbeddingConfig) {
    this.baseUrl = config.baseUrl ?? "http://localhost:11434";
    this.model = config.model ?? "nomic-embed-text";
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Ollama embeddings API error: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as { embedding: number[] };

      if (!data.embedding || !Array.isArray(data.embedding)) {
        throw new Error("Invalid embedding response from Ollama");
      }

      this.dimension = data.embedding.length;
      return data.embedding;
    } finally {
      clearTimeout(timer);
    }
  }

  getDimension(): number {
    return this.dimension;
  }

  getProviderName(): string {
    return `ollama:${this.model}`;
  }
}

// ============================================================
// OpenAI Embedding Provider
// ============================================================

export class OpenAIEmbeddingProvider implements IEmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly dimension: number;

  constructor(config: EmbeddingConfig) {
    if (!config.apiKey) {
      throw new Error("OpenAI API key is required for OpenAIEmbeddingProvider");
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "text-embedding-3-small";
    this.timeoutMs = config.timeoutMs ?? 30_000;
    // text-embedding-3-small: 1536次元
    this.dimension = this.model === "text-embedding-ada-002" ? 1536 : 1536;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: text,
          encoding_format: "float",
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = (await response.json()) as { error?: { message?: string } };
        throw new Error(
          `OpenAI embeddings API error: ${err.error?.message ?? response.statusText}`,
        );
      }

      const data = (await response.json()) as {
        data: { embedding: number[] }[];
      };

      if (!data.data?.[0]?.embedding) {
        throw new Error("Invalid embedding response from OpenAI");
      }

      return data.data[0].embedding;
    } finally {
      clearTimeout(timer);
    }
  }

  getDimension(): number {
    return this.dimension;
  }

  getProviderName(): string {
    return `openai:${this.model}`;
  }
}

// ============================================================
// TF-IDF Fallback Provider（外部依存ゼロ）
// ============================================================

/**
 * TF-IDF ベースの擬似ベクトル生成
 * - 外部 API 不要で常に動作するフォールバック
 * - 語彙はインスタンス内で動的に成長する
 * - 次元数: 最大 VOCAB_SIZE（デフォルト 512）
 */
export class TFIDFEmbeddingProvider implements IEmbeddingProvider {
  private readonly VOCAB_SIZE: number;
  private vocabulary: Map<string, number> = new Map(); // word -> index
  private documentFrequency: Map<string, number> = new Map(); // word -> doc count
  private documentCount: number = 0;

  constructor(vocabSize: number = 512) {
    this.VOCAB_SIZE = vocabSize;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const tokens = this.tokenize(text);
    this.updateVocabulary(tokens);
    this.documentCount++;

    // TF の計算
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }

    // TF-IDF ベクトルの構築（次元 = VOCAB_SIZE）
    const vector = new Array<number>(this.VOCAB_SIZE).fill(0);

    for (const [word, count] of tf) {
      const idx = this.vocabulary.get(word);
      if (idx === undefined || idx >= this.VOCAB_SIZE) continue;

      const tfVal = count / tokens.length;
      const df = this.documentFrequency.get(word) ?? 1;
      const idfVal = Math.log((this.documentCount + 1) / (df + 1)) + 1;
      vector[idx] = tfVal * idfVal;
    }

    return this.normalize(vector);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2);
  }

  private updateVocabulary(tokens: string[]): void {
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      if (
        !this.vocabulary.has(token) &&
        this.vocabulary.size < this.VOCAB_SIZE
      ) {
        this.vocabulary.set(token, this.vocabulary.size);
      }
      this.documentFrequency.set(
        token,
        (this.documentFrequency.get(token) ?? 0) + 1,
      );
    }
  }

  private normalize(vector: number[]): number[] {
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude === 0) return vector;
    return vector.map((v) => v / magnitude);
  }

  getDimension(): number {
    return this.VOCAB_SIZE;
  }

  getProviderName(): string {
    return "tfidf";
  }
}

// ============================================================
// ファクトリー関数
// ============================================================

/**
 * 設定に基づいて適切な EmbeddingProvider を生成する。
 * Ollama / OpenAI が利用不可な場合は TF-IDF にフォールバック。
 */
export function createEmbeddingProvider(
  config: EmbeddingConfig,
): IEmbeddingProvider {
  switch (config.type) {
    case "ollama":
      return new OllamaEmbeddingProvider(config);
    case "openai":
      return new OpenAIEmbeddingProvider(config);
    case "tfidf":
    default:
      return new TFIDFEmbeddingProvider();
  }
}

/**
 * 利用可能な EmbeddingProvider を自動選択する。
 * Ollama → OpenAI → TF-IDF の順に試行。
 */
export async function createAutoEmbeddingProvider(
  ollamaBaseUrl?: string,
  openAIApiKey?: string,
): Promise<IEmbeddingProvider> {
  // Ollama が起動しているか確認（常に試行し、失敗したら次へ）
  {
    const url = ollamaBaseUrl ?? "http://localhost:11434";
    try {
      const response = await fetch(`${url}/api/tags`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) {
        // nomic-embed-text が利用可能か確認
        const data = (await response.json()) as {
          models?: { name: string }[];
        };
        const hasEmbedModel = data.models?.some(
          (m) =>
            m.name.includes("nomic-embed") ||
            m.name.includes("embed") ||
            m.name.includes("mxbai"),
        );
        if (hasEmbedModel) {
          const model =
            data.models?.find(
              (m) => m.name.includes("nomic-embed") || m.name.includes("embed"),
            )?.name ?? "nomic-embed-text";
          return new OllamaEmbeddingProvider({
            type: "ollama",
            baseUrl: url,
            model,
          });
        }
      }
    } catch {
      // Ollama 未起動 → 次を試行
    }
  }

  // OpenAI が設定されているか確認
  const apiKey = openAIApiKey ?? process.env.OPENAI_API_KEY;
  if (apiKey) {
    return new OpenAIEmbeddingProvider({ type: "openai", apiKey });
  }

  // フォールバック: TF-IDF
  console.warn(
    "[EmbeddingProvider] Ollama/OpenAI が利用不可。TF-IDF フォールバックを使用します。",
  );
  return new TFIDFEmbeddingProvider();
}
