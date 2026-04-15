/**
 * 長期メモリ + ベクトル検索のテスト
 *
 * テスト対象:
 *   - VectorStore: CRUD, cosine similarity 検索, 永続化
 *   - EmbeddingProvider: TF-IDF（外部依存なし）
 *   - LongTermMemory: 保存・検索・コンテキスト構築
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  VectorStore,
  VectorMemoryEntry,
  cosineSimilarity,
  generateId,
} from "../src/memory/VectorStore.js";
import {
  TFIDFEmbeddingProvider,
  OllamaEmbeddingProvider,
} from "../src/memory/EmbeddingProvider.js";
import { LongTermMemory } from "../src/memory/LongTermMemory.js";

// ============================================================
// ヘルパー
// ============================================================

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "lunacode-test-"));
}

function makeEntry(
  content: string,
  embedding: number[],
  type: VectorMemoryEntry["metadata"]["type"] = "task",
): VectorMemoryEntry {
  return {
    id: generateId(),
    content,
    embedding,
    metadata: { type, timestamp: Date.now(), importance: 0.5 },
  };
}

// ============================================================
// cosineSimilarity
// ============================================================

describe("cosineSimilarity", () => {
  test("同一ベクトルは 1.0", () => {
    const v = [1, 0, 0];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  test("直交ベクトルは 0", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
  });

  test("正規化済みベクトルの部分類似", () => {
    const a = [1, 1, 0];
    const b = [1, 0, 0];
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  test("ゼロベクトルは 0 を返す（ゼロ除算回避）", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0);
  });

  test("次元が異なる場合でも動作する（短い方に合わせる）", () => {
    const sim = cosineSimilarity([1, 0, 0, 0], [1, 0, 0]);
    expect(sim).toBeCloseTo(1.0, 5);
  });
});

// ============================================================
// VectorStore
// ============================================================

describe("VectorStore", () => {
  let tmpDir: string;
  let store: VectorStore;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    store = new VectorStore({
      storagePath: path.join(tmpDir, "store.json"),
      maxEntries: 100,
      minSimilarity: 0.0, // テスト用に閾値を 0 に
    });
    await store.initialize();
  });

  afterEach(async () => {
    store.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("エントリの追加と取得", async () => {
    const entry = makeEntry("TypeScript のバグを修正", [1, 0, 0]);
    await store.add(entry);
    expect(store.size()).toBe(1);
    expect(store.get(entry.id)?.content).toBe("TypeScript のバグを修正");
  });

  test("エントリの削除", async () => {
    const entry = makeEntry("テストエントリ", [1, 0, 0]);
    await store.add(entry);
    const deleted = await store.delete(entry.id);
    expect(deleted).toBe(true);
    expect(store.size()).toBe(0);
    expect(store.get(entry.id)).toBeUndefined();
  });

  test("存在しない ID の削除は false を返す", async () => {
    const result = await store.delete("non-existent-id");
    expect(result).toBe(false);
  });

  test("エントリの更新", async () => {
    const entry = makeEntry("元のコンテンツ", [1, 0, 0]);
    await store.add(entry);
    await store.update(entry.id, { content: "更新されたコンテンツ" });
    expect(store.get(entry.id)?.content).toBe("更新されたコンテンツ");
  });

  test("ベクトル検索: 類似度順で返す", async () => {
    const entries = [
      makeEntry("A", [1, 0, 0]),  // query と完全一致
      makeEntry("B", [0, 1, 0]),  // 直交
      makeEntry("C", [0.9, 0.1, 0]), // 高類似
    ];
    for (const e of entries) await store.add(e);

    const results = store.search([1, 0, 0], 3);
    expect(results.length).toBeGreaterThan(0);
    // 最も類似度が高いものが先頭
    expect(results[0].similarity).toBeGreaterThanOrEqual(results[results.length - 1].similarity);
  });

  test("キーワード検索", async () => {
    await store.add(makeEntry("React のコンポーネント設計について", [1, 0, 0]));
    await store.add(makeEntry("TypeScript の型定義", [0, 1, 0]));
    await store.add(makeEntry("Python のデータ分析", [0, 0, 1]));

    const results = store.searchByKeyword("TypeScript");
    expect(results.length).toBe(1);
    expect(results[0].entry.content).toContain("TypeScript");
  });

  test("getRecent はタイムスタンプ降順で返す", async () => {
    const old = makeEntry("古いエントリ", [1, 0, 0]);
    old.metadata.timestamp = Date.now() - 10000;
    const newer = makeEntry("新しいエントリ", [0, 1, 0]);
    newer.metadata.timestamp = Date.now();

    await store.add(old);
    await store.add(newer);

    const recent = store.getRecent(undefined, 10);
    expect(recent[0].metadata.timestamp).toBeGreaterThan(recent[1].metadata.timestamp);
  });

  test("タグでの検索", async () => {
    const entry = makeEntry("タグ付きエントリ", [1, 0, 0]);
    entry.metadata.tags = ["bugfix", "typescript"];
    await store.add(entry);

    const results = store.getByTag("bugfix");
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("タグ付きエントリ");
  });

  test("メタデータフィルタリング", async () => {
    await store.add(makeEntry("タスクA", [1, 0, 0], "task"));
    await store.add(makeEntry("エラーB", [0, 1, 0], "error"));

    const results = store.search([1, 0, 0], 10, { type: "task" });
    expect(results.every((r) => r.entry.metadata.type === "task")).toBe(true);
  });

  test("JSON ファイルへの保存と読み込み", async () => {
    const entry = makeEntry("永続化テスト", [1, 0.5, 0]);
    await store.add(entry);
    await store.save();

    // 新しいストアでロード
    const store2 = new VectorStore({
      storagePath: path.join(tmpDir, "store.json"),
      minSimilarity: 0.0,
    });
    await store2.initialize();
    expect(store2.size()).toBe(1);
    expect(store2.get(entry.id)?.content).toBe("永続化テスト");
    store2.destroy();
  });

  test("getStats でエントリ統計を返す", async () => {
    await store.add(makeEntry("タスク1", [1, 0], "task"));
    await store.add(makeEntry("エラー1", [0, 1], "error"));

    const stats = store.getStats();
    expect(stats.totalEntries).toBe(2);
    expect(stats.byType["task"]).toBe(1);
    expect(stats.byType["error"]).toBe(1);
  });

  test("maxEntries を超えると eviction が発生する", async () => {
    const smallStore = new VectorStore({
      storagePath: path.join(tmpDir, "small.json"),
      maxEntries: 5,
      minSimilarity: 0.0,
    });
    await smallStore.initialize();

    for (let i = 0; i < 8; i++) {
      await smallStore.add(makeEntry(`エントリ ${i}`, [Math.random(), Math.random()]));
    }

    // maxEntries=5, evict=10% => evict 1 entry when 5th is added => max should be <= 5
    expect(smallStore.size()).toBeLessThanOrEqual(5);
    smallStore.destroy();
  });
});

// ============================================================
// TFIDFEmbeddingProvider
// ============================================================

describe("TFIDFEmbeddingProvider", () => {
  let provider: TFIDFEmbeddingProvider;

  beforeEach(() => {
    provider = new TFIDFEmbeddingProvider(64);
  });

  test("ベクトルが正しい次元を持つ", async () => {
    const embedding = await provider.generateEmbedding("TypeScript プログラミング");
    expect(embedding.length).toBe(64);
  });

  test("ベクトルが正規化されている（ノルム ≈ 1）", async () => {
    const embedding = await provider.generateEmbedding("バグ修正とテスト");
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    // ゼロベクトル以外は正規化されている
    if (norm > 0) {
      expect(norm).toBeCloseTo(1.0, 2);
    }
  });

  test("異なるテキストは異なるベクトルを生成する", async () => {
    const a = await provider.generateEmbedding("TypeScript バグ修正");
    const b = await provider.generateEmbedding("Python データ分析");
    const sim = cosineSimilarity(a, b);
    // 完全に同一ではない
    expect(sim).toBeLessThan(1.0);
  });

  test("類似テキストは非類似テキストより高い類似度", async () => {
    // 語彙を構築するため複数テキストで先に呼ぶ
    await provider.generateEmbedding("TypeScript バグ修正");
    await provider.generateEmbedding("Python データ分析");
    await provider.generateEmbedding("JavaScript フロントエンド");

    const query = await provider.generateEmbedding("TypeScript 修正");
    const similar = await provider.generateEmbedding("TypeScript バグ修正");
    const dissimilar = await provider.generateEmbedding("Python データ分析");

    const simScore = cosineSimilarity(query, similar);
    const dissimScore = cosineSimilarity(query, dissimilar);
    expect(simScore).toBeGreaterThanOrEqual(dissimScore);
  });

  test("空文字列でもクラッシュしない", async () => {
    const embedding = await provider.generateEmbedding("");
    expect(embedding.length).toBe(64);
  });

  test("getDimension が正しい値を返す", () => {
    expect(provider.getDimension()).toBe(64);
  });

  test("getProviderName は 'tfidf' を返す", () => {
    expect(provider.getProviderName()).toBe("tfidf");
  });
});

// ============================================================
// LongTermMemory
// ============================================================

describe("LongTermMemory", () => {
  let tmpDir: string;
  let memory: LongTermMemory;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    const provider = new TFIDFEmbeddingProvider(64);
    memory = new LongTermMemory({
      basePath: tmpDir,
      embeddingProvider: provider,
      defaultTopK: 3,
      minSimilarity: 0.0, // テスト用に閾値を 0 に
    });
    await memory.initialize();
  });

  afterEach(async () => {
    memory.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("初期化後に isInitialized() が true", () => {
    expect(memory.isInitialized()).toBe(true);
  });

  test("store でエントリを保存し、id を返す", async () => {
    const id = await memory.store("TypeScript のバグを修正しました", {
      type: "task",
      tags: ["bugfix"],
    });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const stats = memory.getStats();
    expect(stats.totalEntries).toBe(1);
  });

  test("search でセマンティック検索ができる", async () => {
    // 語彙を構築するため複数テキストで先に保存
    await memory.store("TypeScript のバグを修正しました", { type: "task" });
    await memory.store("Python でデータ分析を行いました", { type: "task" });
    await memory.store("React のコンポーネントを作成しました", { type: "code" });

    const results = await memory.search("TypeScript バグ修正");
    expect(results.length).toBeGreaterThan(0);
    // TypeScript 関連が上位に来ることを期待
    expect(results[0].entry.content).toContain("TypeScript");
  });

  test("storeTaskResult でタスク結果を保存できる", async () => {
    const id = await memory.storeTaskResult(
      "ファイルを読む",
      "src/index.ts を読み込みました",
      "session_1",
      true,
    );
    expect(typeof id).toBe("string");

    const recent = memory.getRecent("task", 5);
    expect(recent.length).toBe(1);
    expect(recent[0].metadata.tags).toContain("success");
  });

  test("storeError でエラーパターンを保存できる", async () => {
    const id = await memory.storeError(
      "Cannot find module 'foo'",
      "import 文の解決中",
      "package.json に foo を追加して解決",
      "session_1",
    );
    expect(typeof id).toBe("string");

    const recent = memory.getRecent("error", 5);
    expect(recent.length).toBe(1);
    expect(recent[0].metadata.importance).toBeGreaterThan(0.5); // 解決済みは高重要度
  });

  test("storeCode でコードスニペットを保存できる", async () => {
    await memory.storeCode(
      "ユーザー認証関数",
      "function authenticate(token: string) { ... }",
      "src/auth.ts",
    );

    const recent = memory.getRecent("code", 5);
    expect(recent.length).toBe(1);
    expect(recent[0].metadata.source).toBe("src/auth.ts");
  });

  test("buildContext が注入用テキストを構築する", async () => {
    await memory.store("TypeScript の型エラーを修正した", { type: "error", tags: ["typescript"] });
    await memory.store("React コンポーネントの最適化", { type: "code", tags: ["react"] });

    const ctx = await memory.buildContext("TypeScript エラーを直したい");
    // エントリがある場合はコンテキストテキストが生成される
    expect(typeof ctx.contextText).toBe("string");
    expect(typeof ctx.embeddingProvider).toBe("string");
    expect(Array.isArray(ctx.entries)).toBe(true);
  });

  test("buildContext でエントリがない場合は空文字列", async () => {
    const ctx = await memory.buildContext("何かを検索する");
    expect(ctx.contextText).toBe("");
    expect(ctx.entries.length).toBe(0);
  });

  test("delete でエントリを削除できる", async () => {
    const id = await memory.store("削除予定エントリ", { type: "fact" });
    expect(memory.getStats().totalEntries).toBe(1);

    const result = await memory.delete(id);
    expect(result).toBe(true);
    expect(memory.getStats().totalEntries).toBe(0);
  });

  test("getByTag でタグ検索ができる", async () => {
    await memory.store("タグ付きエントリ1", { type: "task", tags: ["urgent", "api"] });
    await memory.store("タグ付きエントリ2", { type: "task", tags: ["api"] });
    await memory.store("タグなしエントリ", { type: "task" });

    const results = memory.getByTag("urgent");
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("タグ付きエントリ1");
  });

  test("vectors ディレクトリが作成される", async () => {
    const vectorsDir = path.join(tmpDir, "vectors");
    const stat = await fs.stat(vectorsDir);
    expect(stat.isDirectory()).toBe(true);
  });

  test("flush 後にデータがファイルに永続化される", async () => {
    await memory.store("永続化テストエントリ", { type: "fact" });
    await memory.flush();

    const storePath = path.join(tmpDir, "vectors", "store.json");
    const raw = await fs.readFile(storePath, "utf-8");
    const data = JSON.parse(raw);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    expect(data[0].content).toBe("永続化テストエントリ");
  });

  test("getStats が正しい統計を返す", async () => {
    await memory.storeTaskResult("タスク1", "成功", "s1", true);
    await memory.storeError("エラー1", "ctx", undefined, "s1");

    const stats = memory.getStats();
    expect(stats.totalEntries).toBe(2);
    expect(stats.byType["task"]).toBe(1);
    expect(stats.byType["error"]).toBe(1);
  });
});
