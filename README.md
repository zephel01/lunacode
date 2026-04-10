<p align="center">
  <h1 align="center">LunaCode</h1>
  <p align="center">
    <strong>KAIROS — 自律型コーディングエージェント</strong>
  </p>
  <p align="center">
    ReAct パターン | 3層セルフヒーリングメモリ | マルチ LLM | 24/7 デーモン
  </p>
  <p align="center">
    <a href="https://github.com/zephel01/lunacode/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
    <a href="https://bun.sh"><img alt="Runtime: Bun" src="https://img.shields.io/badge/runtime-Bun-f9f1e1.svg" /></a>
    <a href="https://www.typescriptlang.org/"><img alt="Language: TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178c6.svg" /></a>
  </p>
</p>

---

LunaCode は、Claude Code にインスパイアされたオープンソースの自律型コーディングエージェントです。ReAct パターンによるエージェントループ、3層の自己修復メモリ、KAIROS 常駐デーモン、マルチ LLM プロバイダー対応を統合し、24時間自律稼働できるデジタルコーディングアシスタントを目指しています。

> **Note**: 本プロジェクトは活発に開発中です。API やコマンド体系は今後変更される可能性があります。

## 主な特徴

- **ReAct エージェントループ** — Thought → Action → Observation サイクルで自律的にタスクを遂行（最大50イテレーション）
- **対話・自動実行・ワンショット** — REPL対話モード / タスク完了まで自動でツール実行 / シンプルな1回のやり取り
- **Ollama ネイティブ Tool Calling** — Ollama API のネイティブツール呼び出しに対応。非対応モデルはテキスト抽出に自動フォールバック（6種類のパターン認識）
- **スマートリトライ** — ツール呼び出しが検出されない場合、具体的なフォーマット例を提示して自動リトライ（最大2回）
- **3層セルフヒーリングメモリ** — メインメモリ / トピック別ファイル / 生ログの3層構造。MicroCompact / AutoCompact による自動圧縮とサーキットブレーカーによる障害耐性
- **KAIROS デーモン** — 60秒 Tick で常駐し、プロアクティブなチェック・メモリ統合・ヘルス監視を実行。AutoDream でアイドル時にメモリ統合・矛盾解消・洞察抽出
- **マルチ LLM** — OpenAI / Z.AI (GLM) / Ollama / LM Studio / LiteLLM をサポート
- **7つのコアツール** — Bash, ファイル読み書き・編集, Glob, Grep, Git（リスクレベル管理付き）
- **並列ツール実行** — トポロジカルソートによる依存解決とバッチ並列実行
- **マルチエージェント** — Coordinator / Worker パターンでタスク分散・優先度キューイング
- **95テスト / 187アサーション** — ツール・プロバイダー・セキュリティ・E2E・ベンチマーク・コーディングタスクの自動テスト
- **セキュリティ** — RBAC、サンドボックス実行、危険コマンド検出、Undercover モード

## クイックスタート

### 前提条件

- [Bun](https://bun.sh) >= 1.0.0（または Node.js >= 18.0.0）
- LLM プロバイダーのいずれか（OpenAI / Z.AI Coding Plan / Ollama / LM Studio）

### インストール

```bash
git clone https://github.com/zephel01/lunacode.git
cd lunacode
bun install
```

### 環境変数

利用する LLM プロバイダーに応じて設定してください。

```bash
# OpenAI
export OPENAI_API_KEY="sk-..."

# Z.AI Coding Plan（GLM-5.1 等）
export ZAI_API_KEY="your-zai-api-key"

# Ollama（ローカル）— デフォルト: http://localhost:11434
export OLLAMA_BASE_URL="http://localhost:11434"

# LM Studio（ローカル）— デフォルト: http://localhost:1234/v1
export LMSTUDIO_BASE_URL="http://localhost:1234/v1"
```

### 使ってみる

```bash
# グローバルコマンドとして登録（推奨）
bun link
lunacode chat              # 対話モード（REPL）— おすすめ

# 自動実行モード — タスクを与えると自律的にファイル作成まで実行
lunacode --auto "JavaScript でテトリスを作成" --rounds 10

# ワンショット — 1回の質問応答
lunacode "Python の学習順序は"

# セットアップ
lunacode init              # 対話的に config.json を生成
lunacode config models     # 利用可能なモデル一覧

# テスト
lunacode test-provider     # 接続テスト
bun test                   # 自動テスト実行（95テスト）
```

## Ollama モデル互換性

Ollama で利用する場合のモデル別動作検証結果です（自動テストによる検証済み）。

### 推奨モデル

| モデル | hello.js | FizzBuzz | JSON処理 | レイテンシ | 評価 |
|---|---|---|---|---|---|
| **llama3.1** | ✅ | ✅ 正常実行 | ✅ 完全一致 | 12s | ⭐ 最速・最安定 |
| **qwen2.5:14b** | ✅ | ✅ 正常実行 | ✅ 完全一致 | 28s | ⭐ 高品質 |
| **qwen3.5:4b** | ✅ | ✅ 正常実行 | ✅ 完全一致 | 28s | ⭐ バランス良好 |
| **gemma4:e4b** | ✅ | ✅ 正常実行 | ✅ 完全一致 | 42s | ⭐ 安定 |
| **qwen2.5:1.5b** | ✅ | — | ✅ 完全一致 | 4s | 軽量タスク向き |

### ツール呼び出しの仕組み

LunaCode は Ollama のネイティブ Tool Calling API を使用します。モデルが対応していない場合は自動的にテキスト抽出方式にフォールバックします。

```
リクエスト → Ollama ネイティブ Tool Calling API (/api/chat + tools)
              ↓ ツール呼び出し成功 → 実行
              ↓ 空レスポンス → テキスト抽出モードに切替（永続）
                               ↓ 6パターンで抽出
                               ↓ 検出失敗 → リトライ（最大2回）
```

対応するテキスト抽出パターン:

1. `<tool_call>JSON</tool_call>` — 標準タグ形式
2. `` ```json JSON``` `` — コードブロック形式
3. `[TOOL_CALLS] [{...}]` — Mistral 形式
4. `Tool call: name{...}` — Gemma 形式
5. `[{"name": "...", "arguments": {...}}]` — 配列形式
6. `{"name": "...", "arguments": {...}}` — 生 JSON

## アーキテクチャ

```
src/
├── agents/          # ReAct エージェントループ、マルチエージェント
├── daemon/          # KAIROS デーモン、AutoDream
├── memory/          # 3層メモリシステム
├── tools/           # ツールフレームワーク（7種 + 並列実行）
├── providers/       # LLM プロバイダー抽象化（Factory パターン）
├── config/          # 設定管理
├── security/        # RBAC、サンドボックス、Undercover
├── buddy/           # コンパニオンAI（17種ペット）
├── notifications/   # マルチチャンネル通知
├── ui/              # React Ink ターミナルUI
├── types/           # 型定義
└── cli.ts           # エントリーポイント
```

### データフロー

```
ユーザー入力 / Tick イベント
      ↓
AgentLoop（ReAct: Thought → Action → Observation）
      ↓                        ↑ リトライ（ツール未検出時）
LLM プロバイダー ──→ ネイティブ Tool Calling or テキスト抽出
      ↓
ToolRegistry → ツール実行（write_file, bash, etc.）
      ↓
MemorySystem（3層メモリ + MicroCompact / AutoCompact）
      ↓
AutoDream（バックグラウンド統合） → NotificationManager
```

## テスト

```bash
# 全テスト実行（95テスト）
bun test

# 個別テスト
bun test tests/tools.test.ts           # ツール単体テスト
bun test tests/agent-loop.test.ts      # エージェントループテスト
bun test tests/ollama-provider.test.ts # Ollama プロバイダーテスト
bun test tests/security.test.ts        # セキュリティテスト
bun test tests/benchmark.test.ts       # パフォーマンスベンチマーク
bun test tests/coding-task.test.ts     # 実践コーディングタスクテスト
```

| テストファイル | テスト数 | 内容 |
|---|---|---|
| tools.test.ts | 16 | ToolRegistry、write/read/edit_file、bash |
| agent-loop.test.ts | 6 | ReAct ループ、ツール連鎖、状態管理 |
| ollama-provider.test.ts | 18 | ネイティブ API、テキスト抽出6パターン、正規化 |
| security.test.ts | 25 | 危険コマンド15種ブロック、安全コマンド10種許可 |
| benchmark.test.ts | 8 | ツール速度、LLM 応答時間、検出精度、E2E |
| coding-task.test.ts | 3 | hello.js、FizzBuzz、JSON処理の実践テスト |
| daemon.test.ts | 19 | KAIROS デーモン、Tick、AutoDream |

## LLM プロバイダー

| プロバイダー | タイプ | ツール呼び出し | コスト | プライバシー |
|---|---|---|---|---|
| OpenAI | クラウド | ネイティブ | 有料 | — |
| Z.AI (GLM) | クラウド | ネイティブ | 有料 | — |
| Ollama | ローカル | ネイティブ + フォールバック | 無料 | 完全 |
| LM Studio | ローカル | ネイティブ | 無料 | 完全 |
| LiteLLM | プロキシ | プロキシ依存 | 変動 | 変動 |

## 技術スタック

| カテゴリ | 技術 |
|---|---|
| 言語 | TypeScript (ES2022) |
| ランタイム | Bun |
| ターミナルUI | React Ink |
| LLM SDK | OpenAI SDK |
| ファイル検索 | fast-glob, ripgrep |
| テスト | Bun Test |
| 通知 | Pushover, Telegram, OS native |

## ドキュメント

| ドキュメント | 内容 |
|---|---|
| [セットアップガイド](./docs/guide/getting-started.md) | インストール、LLM プロバイダー設定、初期設定 |
| [使い方ガイド](./docs/guide/usage.md) | コマンド一覧、基本的な操作フロー、設定ファイル |
| [機能詳細ガイド](./docs/guide/features.md) | デーモン、メモリ、マルチエージェント、Buddy 等の詳細 |
| [アーキテクチャ](./docs/ARCHITECTURE.md) | 内部設計、ツール実行パイプライン、テスト戦略 |
| [トラブルシューティング](./docs/guide/troubleshooting.md) | よくある質問と問題解決 |

## コントリビューション

Issue や Pull Request を歓迎します。

1. Fork して feature branch を作成 (`git checkout -b feature/amazing-feature`)
2. 変更をコミット (`git commit -m 'Add amazing feature'`)
3. Push (`git push origin feature/amazing-feature`)
4. Pull Request を作成

バグ報告は [Issues](https://github.com/zephel01/lunacode/issues) からお願いします。

## ライセンス

[MIT License](./LICENSE)

## Acknowledgments

- [Claude Code](https://github.com/anthropics/claude-code) — アーキテクチャのインスピレーション
- [OpenAI](https://openai.com/) — GPT モデル
- [Ollama](https://ollama.com/) — ローカル LLM ランナー
- [LM Studio](https://lmstudio.ai/) — ローカル LLM プラットフォーム
- [Z.AI](https://z.ai/) — GLM Coding Plan
- [LiteLLM](https://litellm.ai/) — マルチ LLM 統合
