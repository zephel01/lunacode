<p align="center">
  <h1 align="center">LunaCode</h1>
  <p align="center">
    <strong>KAIROS — 自律型コーディングエージェント</strong>
  </p>
  <p align="center">
    ReAct パターン | ストリーミング | マルチエージェント | 自己評価ループ | MCP | マルチ LLM
  </p>
  <p align="center">
    <a href="https://github.com/zephel01/lunacode/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/zephel01/lunacode/actions/workflows/ci.yml/badge.svg" /></a>
    <a href="https://github.com/zephel01/lunacode/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
    <a href="https://bun.sh"><img alt="Runtime: Bun" src="https://img.shields.io/badge/runtime-Bun-f9f1e1.svg" /></a>
    <a href="https://www.typescriptlang.org/"><img alt="Language: TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178c6.svg" /></a>
    <img alt="Tests: 536 pass" src="https://img.shields.io/badge/tests-536%20pass-brightgreen.svg" />
    <img alt="Phase: 20/22" src="https://img.shields.io/badge/phase-20%2F22%20complete-success.svg" />
  </p>
  <p align="center">
    <code>TypeScript</code> · <code>Bun</code> · <code>ReAct</code> · <code>MCP</code> · <code>commander.js</code> · <code>pino</code> · <code>OpenAI</code> · <code>Ollama</code> · <code>LM Studio</code> · <code>Z.AI</code> · <code>LiteLLM</code>
  </p>
</p>

---

LunaCode は、Claude Code にインスパイアされたオープンソースの自律型コーディングエージェントです。ReAct パターンによるエージェントループ、長期ベクトルメモリ、マルチエージェントオーケストレーション、自己評価・自己修正ループ、タスク別モデルルーティング、MCP 統合、5社の LLM プロバイダー対応、構造化ログ（pino）、commander.js による CLI サブコマンド、SWE-bench 対応の Git ツール・マルチファイル編集を統合し、自律稼働するコーディングアシスタントを目指しています。

> **Note**: 本プロジェクトは活発に開発中です。API やコマンド体系は今後変更される可能性があります。

## 主な特徴

### コア機能

- **ReAct エージェントループ** — Thought → Action → Observation サイクルで自律的にタスクを遂行（最大50イテレーション）
- **対話・自動実行・ワンショット** — REPL 対話モード / タスク完了まで自動でツール実行 / シンプルな 1 回のやり取り
- **ストリーミング応答** — Ollama NDJSON ストリーミングによるリアルタイム応答表示。AsyncGenerator ベースで逐次トークン出力
- **コンテキストウィンドウ管理** — モデル別コンテキスト長の自動検出・トークン推定（CJK/ASCII 対応）・メッセージ自動トリミング
- **14のコアツール** — Bash, ファイル読み書き・編集, マルチファイル一括編集, Glob, Grep, Git（status/diff/commit/apply/log）, delegate_task（リスクレベル管理付き）

### LLM プロバイダー・ルーティング

- **マルチ LLM** — OpenAI / Z.AI (GLM) / Ollama / LM Studio / LiteLLM をサポート
- **プロバイダーフォールバック** — サーキットブレーカーパターンによる障害検知と複数プロバイダー間の自動切替
- **タスク別モデルルーティング** — タスク種別（code_generation / debugging / refactoring / code_review / summarization / general）を自動判定し、ルールベースで最適プロバイダーを選択。フォールバックチェーンによる自動エスカレーション
- **Ollama ネイティブ Tool Calling** — Ollama API のネイティブツール呼び出しに対応。非対応モデルはテキスト抽出に自動フォールバック（6 種類のパターン認識）

### エージェント・自律機能

- **マルチエージェントオーケストレーション** — PipelineOrchestrator による Planner / Coder / Reviewer の役割分担と逐次実行パイプライン
- **サブエージェント委譲** — Hub-and-Spoke モデルで最大 6 タスクを並列委譲。ロール別ツール権限（explorer / worker / reviewer）
- **自己評価・自己修正ループ** — LLM が自分の出力をスコアリングし、閾値未満なら自動で修正・再生成。最大修正ラウンド数とサブエージェント適用を設定可能
- **自動 Git ワークフロー** — タスク完了時に Conventional Commits 形式で自動コミット。テスト実行・PR 作成まで自動化可能

### メモリ・コンテキスト

- **3 層セルフヒーリングメモリ** — メインメモリ / トピック別ファイル / 生ログの 3 層構造。MicroCompact / AutoCompact による自動圧縮
- **長期メモリ（ベクトル検索）** — TF-IDF / Ollama / OpenAI ベースのエンベディングで過去のセッション・エラー・コードをセマンティック検索。外部 DB 不要の純 TypeScript 実装
- **KAIROS デーモン** — 60 秒 Tick で常駐し、プロアクティブなチェック・メモリ統合・ヘルス監視を実行。AutoDream でメモリ統合・矛盾解消・洞察抽出

### 安全性・開発体験

- **構造化ログ（pino）** — JSON 構造化ログ / pino-pretty による開発時カラー出力。コンポーネント別子ロガー、エラーオブジェクトのスタックトレース自動シリアライズ
- **CLI サブコマンド（commander.js）** — cobra 相当の CLI フレームワーク。ネストしたサブコマンド、エイリアス、オプション解析、`--help` 自動生成
- **チェックポイント＆ロールバック** — Git ベースの自動チェックポイント。write_file / edit_file / bash 実行前に自動保存、undo / rollback / diff で変更管理
- **Diff プレビュー＆承認フロー** — ファイル変更前に unified diff をプレビュー。auto / confirm / selective の 3 モード、リスクレベル別承認制御
- **ライフサイクルフック** — session / tool / iteration / response / mcp の 11 イベントにカスタム処理を挿入
- **MCP 統合（Model Context Protocol）** — JSON-RPC 2.0 over stdio で外部 MCP サーバーと連携。Web 検索・ブラウジングなど外部ツールを自動登録
- **セキュリティ** — RBAC、サンドボックス実行、危険コマンド検出、SSRF 対策、Undercover モード

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

# セットアップ
lunacode init                       # 対話的に config.json を生成
lunacode init --provider ollama     # プロバイダー指定で非対話セットアップ
lunacode config models              # 利用可能なモデル一覧
lunacode test-provider              # 接続テスト
lunacode test-provider --quick      # クイック接続テスト

# 対話モード（REPL）— おすすめ
lunacode chat

# 自動実行モード — タスクを与えると自律的にファイル作成まで実行
lunacode auto "JavaScript でテトリスを作成" --rounds 10
lunacode auto "REST API作成" --skill api-design --rounds 15

# ワンショット — 1回の質問応答
lunacode "Python の学習順序は"

# スキル管理
lunacode skill list                 # インストール済みスキル一覧
lunacode skill create my-skill      # スキルテンプレート作成
lunacode skill show my-skill        # スキル詳細表示

# メモリ管理
lunacode memory stats               # メモリ統計
lunacode memory search "キーワード"  # メモリ検索

# その他
lunacode daemon start               # バックグラウンドデーモン起動
lunacode dream run                  # メモリ統合（ドリームモード）
lunacode buddy info                 # コンパニオンAI情報

# テスト
bun test                            # 自動テスト実行（471テスト）
```

## 設定

`config.json`（または `.kairos/config.json`）で全機能を制御します。環境変数 `${VAR}` の展開に対応しています。

```jsonc
{
  "llm": {
    "type": "ollama",
    "model": "llama3.1"
  },
  // タスク別モデルルーティング
  "routing": {
    "enabled": true,
    "rules": [
      { "taskType": "code_generation", "provider": "ollama", "model": "qwen2.5:14b" },
      { "taskType": "debugging", "provider": "openai", "model": "gpt-4o-mini" }
    ],
    "defaultProvider": "ollama",
    "fallbackChain": ["ollama", "openai"]
  },
  // 自己評価ループ
  "selfEval": {
    "enabled": true,
    "scoreThreshold": 7,
    "maxRounds": 2
  },
  // MCP サーバー
  "mcp": {
    "servers": [
      { "name": "web-search", "command": "python", "args": ["mcp-wrapper/server.py"] }
    ]
  }
}
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
├── agents/          # AgentLoop, TaskClassifier, ModelRouter, SelfEvaluator
│                    # SubAgentManager, PipelineOrchestrator, AutoGitWorkflow
│                    # ContextManager, CheckpointManager, ApprovalManager
├── providers/       # LLM プロバイダー抽象化（5社）, ModelRegistry
│                    # CircuitBreaker, FallbackProvider, LLMProviderFactory
├── hooks/           # HookManager, FileHookLoader（11イベント）
├── tools/           # ToolRegistry, SubAgentTool（8種 + 並列実行）
├── mcp/             # MCPConnection, MCPClientManager（JSON-RPC 2.0）
├── memory/          # MemorySystem（3層）, LongTermMemory（ベクトル検索）
│                    # EmbeddingProvider, VectorStore
├── daemon/          # KAIROS デーモン, AutoDream
├── skills/          # SkillLoader, スキル自動検出
├── config/          # ConfigManager（環境変数展開対応）
├── security/        # RBAC, サンドボックス, Undercover
├── buddy/           # コンパニオンAI（17種ペット）
├── notifications/   # マルチチャンネル通知
├── ui/              # React Ink ターミナルUI
├── utils/           # TokenCounter, スピナー, Logger（pino）
├── types/           # 型定義
└── cli.ts           # エントリーポイント（commander.js）
```

### データフロー

```
ユーザー入力 / Tick イベント
      ↓
TaskClassifier → タスク種別 + 複雑度分類
      ↓
ModelRouter → ルールマッチ → プロバイダー選択（フォールバックチェーン付き）
      ↓
AgentLoop（ReAct: Thought → Action → Observation）
      ↓                        ↑ リトライ（ツール未検出時）
ContextManager → メッセージトリミング → LLM プロバイダー（ストリーミング対応）
      ↓                                    ↑ フォールバック（CircuitBreaker）
HookManager → tool:before → ToolRegistry → ツール実行 → tool:after
      ↓                                    ↓ delegate_task
MemorySystem（3層）+ LongTermMemory    SubAgentManager / PipelineOrchestrator
      ↓                                    ↓
SelfEvaluator → スコアリング → 修正ループ（閾値未満時）
      ↓
AutoGitWorkflow → 自動コミット / テスト / PR
      ↓
AutoDream（バックグラウンド統合） → NotificationManager
```

## 実装フェーズ

全 22 フェーズ中 20 完了（Phase 19 bubbletea は保留、Phase 21 テスト実行ツールは未着手）。

| Phase | 機能 | テスト |
|-------|------|--------|
| 1 | ストリーミング応答 | 8 pass |
| 2 | コンテキストウィンドウ管理 | 24 pass |
| 3 | プロバイダーフォールバック | 21 pass |
| 4 | モデル自動選択 | 34 pass |
| 5 | チェックポイント＆ロールバック | 18 pass |
| 6 | Diff プレビュー＆承認フロー | 33 pass |
| 7 | Hooks（ライフサイクルイベント） | 22 pass |
| 8 | サブエージェント（並列実行） | 20 pass |
| 9 | MCP（Model Context Protocol） | 22 pass |
| 10 | 長期メモリ + ベクトル検索 | 37 pass |
| 11 | マルチエージェントオーケストレーション | 15 pass |
| 12 | 自動 Git ワークフロー | 20 pass |
| 13 | Web Search / Browser ツール統合 | — |
| 14 | 自己評価・自己修正ループ | 16 pass |
| 15 | モデルルーティング高度化 | 32 pass |
| 16 | 構造化ログ（pino） | 19 pass |
| 17 | CLI サブコマンド（commander.js） | 11 pass |
| 18 | Git ツール強化（SWE-bench 対応） | 41 pass |
| 19 | TUI 刷新（bubbletea） | 保留 |
| 20 | マルチファイル同時編集（SWE-bench 対応） | 27 pass |

## テスト

```bash
# 全テスト実行
bun test  # 536 pass / 0 fail / 1120 expect()

# 個別テスト
bun test tests/tools.test.ts           # ツール単体テスト
bun test tests/agent-loop.test.ts      # エージェントループテスト
bun test tests/model-router.test.ts    # モデルルーティングテスト
bun test tests/self-evaluator.test.ts  # 自己評価テスト
bun test tests/security.test.ts        # セキュリティテスト
bun test tests/vector-memory.test.ts   # ベクトルメモリテスト
bun test tests/logger.test.ts          # 構造化ログテスト
bun test tests/cli-commander.test.ts   # CLIサブコマンドテスト
bun test tests/multi-file-edit.test.ts # マルチファイル編集テスト
```

| テストファイル | テスト数 | 内容 |
|---|---|---|
| tools.test.ts | 16 | ToolRegistry、write/read/edit_file、bash |
| agent-loop.test.ts | 6 | ReAct ループ、ツール連鎖、状態管理 |
| agent-with-mock.test.ts | 5 | モック LLM 連携テスト |
| ollama-provider.test.ts | 18 | ネイティブ API、テキスト抽出6パターン、正規化 |
| security.test.ts | 25 | 危険コマンド15種ブロック、安全コマンド10種許可 |
| streaming.test.ts | 8 | NDJSON ストリーミング、ツール抽出、使用量情報 |
| token-counter.test.ts | 10 | CJK/ASCII トークン推定、メッセージオーバーヘッド |
| context-manager.test.ts | 14 | メッセージトリミング、使用率、キャリブレーション |
| circuit-breaker.test.ts | 8 | 状態遷移（closed→open→half-open）、リセット |
| fallback-provider.test.ts | 13 | フォールバック、ラウンドロビン、ストリーミング |
| task-classifier.test.ts | 32 | 複雑度分類、タスク種別判定、キーワードスコアリング |
| model-router.test.ts | 34 | モデル選択、ルールマッチ、フォールバックチェーン |
| hook-manager.test.ts | 11 | フック登録、emit、abort/modifyArgs |
| file-hook-loader.test.ts | 11 | hooks.json 読込、条件フィルタ、変数展開 |
| sub-agent-manager.test.ts | 20 | ロール権限、spawn/spawnParallel、SubAgentTool |
| pipeline-orchestrator.test.ts | 15 | パイプライン実行、Planner/Coder/Reviewer |
| checkpoint-manager.test.ts | 18 | チェックポイント作成、ロールバック、undo、diff |
| diff-generator.test.ts | 15 | unified diff生成、カラー化、新規/編集/マルチライン |
| approval-manager.test.ts | 18 | 承認モード(auto/confirm/selective)、diff連携 |
| mcp-connection.test.ts | 11 | JSON-RPC通信、ツール一覧/実行、接続管理 |
| mcp-client-manager.test.ts | 11 | 複数サーバー管理、ツール名前空間、ToolRegistry連携 |
| self-evaluator.test.ts | 16 | スコアリング、修正ループ、JSON解析、エッジケース |
| auto-git-workflow.test.ts | 20 | Conventional Commits、テスト実行、PR生成 |
| vector-memory.test.ts | 37 | TF-IDF エンベディング、ベクトル検索、永続化 |
| skill-loader.test.ts | 7 | スキル自動検出、トリガーマッチ |
| benchmark.test.ts | 8 | ツール速度、LLM 応答時間、検出精度、E2E |
| coding-task.test.ts | 3 | hello.js、FizzBuzz、JSON処理の実践テスト |
| daemon.test.ts | 23 | KAIROS デーモン、Tick、イベント、通知、AutoDream |
| logger.test.ts | 19 | pino ロガー、子ロガー、構造化出力、JSONモード |
| cli-commander.test.ts | 11 | コマンド構造、サブコマンド、オプション解析 |
| git-tools.test.ts | 41 | git_status, git_diff, git_commit, git_apply, git_log |
| multi-file-edit.test.ts | 27 | マルチファイル一括編集、ロールバック、dry_run |

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
| CLI | commander.js |
| ログ | pino / pino-pretty |
| ターミナルUI | React Ink |
| LLM SDK | OpenAI SDK |
| ファイル検索 | fast-glob, ripgrep |
| ベクトル検索 | TF-IDF / Ollama / OpenAI Embeddings |
| MCP | JSON-RPC 2.0 over stdio |
| テスト | Bun Test (536 pass) |
| 通知 | Pushover, Telegram, OS native |

## ドキュメント

| ドキュメント | 内容 |
|---|---|
| [セットアップガイド](./docs/guide/getting-started.md) | インストール、LLM プロバイダー設定、初期設定 |
| [使い方ガイド](./docs/guide/usage.md) | コマンド一覧、基本的な操作フロー、設定ファイル |
| [機能詳細ガイド](./docs/guide/features.md) | デーモン、メモリ、マルチエージェント、Buddy 等の詳細 |
| [アーキテクチャ](./docs/ARCHITECTURE.md) | 内部設計、ツール実行パイプライン、テスト戦略 |
| [開発計画](./docs/inside/plan.md) | 全22フェーズの詳細・進捗 |
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
