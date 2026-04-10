# ツール実行パイプライン修正記録

## 背景

LunaCode の auto mode でタスクを実行すると、エージェントが「タスク完了」と判定するが、実際にファイルが作成されていない問題がありました。

## 根本原因

1. OllamaProvider が Ollama API の `tools` パラメータを送信していなかった
2. テキスト抽出の正規表現パターンが不十分だった
3. モデルごとにツール呼び出しのフォーマットが異なり、単一のパターンでは対応できなかった
4. ConfigManager.load() が AgentLoop.initialize() で呼ばれておらず、config.json の設定が反映されていなかった

## 実施した修正

### Phase 1: Ollama ネイティブ Tool Calling API 対応

OllamaProvider を全面書き換えし、3つの実行パスを実装しました。

- **ネイティブパス**: `/api/chat` に `tools` パラメータを送信し、`data.message.tool_calls` を直接読取
- **テキスト抽出パス**: tools を送信せず、システムプロンプトにツール説明を注入してテキストから抽出
- **自動フォールバック**: ネイティブ API が空レスポンス（content=0, tool_calls=0）を返した場合、`useNativeTools` フラグを `false` に切替え、テキスト抽出モードに永続移行

### Phase 2: テキスト抽出パターン拡張（2→6パターン）

| パターン | 対応形式 | 追加理由 |
|---|---|---|
| 1. `<tool_call>` タグ | 標準 | 既存 |
| 2. コードブロック | 汎用 | 既存 |
| 3. `[TOOL_CALLS]` 配列 | Mistral 系 | mistral:7b-instruct が使用 |
| 4. `Tool call: name{...}` | Gemma 系 | gemma4:e4b が使用 |
| 5. JSON 配列 | 配列出力モデル | 一部モデルが配列で出力 |
| 6. 生 JSON オブジェクト | 最終手段 | パターン 1-5 に該当しない場合 |

### Phase 3: データ正規化（normalizeToolData）

モデルによって JSON の構造が異なるため、6つのフォーマットを正規化する関数を追加しました。

- `{ name, arguments }` → 標準
- `{ name, parameters }` → llama3.1 がリトライ時に使用
- `{ function: { name, arguments } }` → OpenAI 形式
- `{ function: { name, parameters } }` → OpenAI 代替
- `{ tool, parameters }` → 代替形式
- `{ action, params }` → 代替形式

### Phase 4: AgentLoop 改善

- **configManager.load()**: `initialize()` 内で設定ファイルを読み込むよう修正
- **スマートリトライ**: ツール未検出時に最大2回リトライ。条件: iteration <= 3 かつ応答が短い（200文字未満）
- **リトライ回避**: 長い説明文（=タスク完了報告）ではリトライしない

## モデル互換性テスト結果（最新）

### E2E ファイル作成ベンチマーク

| モデル | レイテンシ | ファイル作成 | iterations |
|---|---|---|---|
| llama3.1:latest | 10.9s | ✅ | 5 |
| qwen3.5:4b | 22.3s | ✅ | 4 |
| gemma4:e4b | 35.5s | ✅ | 5 |
| qwen2.5:14b | 19.2s | ✅ | 4 |
| mistral:7b-instruct | 19.5s | ✅ | 5 |
| qwen2.5:1.5b | 3.5s | ✅ | 4 |

### 実践コーディングタスク

| モデル | hello.js | FizzBuzz | JSON処理 |
|---|---|---|---|
| llama3.1 | ✅ | ✅ 正常実行 | ✅ 完全一致 |
| qwen3.5:4b | ✅ | ✅ 正常実行 | ✅ 完全一致 |
| gemma4:e4b | ✅ | ✅ 正常実行 | ✅ 完全一致 |
| qwen2.5:14b | ✅ | ✅ 正常実行 | ✅ 完全一致 |
| qwen2.5:1.5b | ✅ | — | ✅ 完全一致 |

### 推奨モデル

```bash
# 第一推奨（最速・最安定）
ollama pull llama3.1

# 高品質
ollama pull qwen2.5:14b

# バランス
ollama pull qwen3.5:4b
```

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `src/providers/OllamaProvider.ts` | ネイティブ Tool Calling + 6パターンテキスト抽出 + normalizeToolData |
| `src/agents/AgentLoop.ts` | configManager.load() + スマートリトライ |
| `tests/ollama-provider.test.ts` | 18テスト（6パターン + 正規化 + フォールバック） |
| `tests/benchmark.test.ts` | パフォーマンスベンチマーク |
| `tests/coding-task.test.ts` | 実践コーディングタスク3種 |
| `tests/security.test.ts` | 25テスト（危険コマンド検出） |
| `tests/agent-loop.test.ts` | 6テスト（MockLLM 統合） |
| `tests/tools.test.ts` | 16テスト（ツール単体） |
