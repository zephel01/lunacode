# ユーザーガイド

LunaCode へようこそ！このガイドでは、LunaCode の導入から高度な機能の活用までを説明します。

## 目次

1. [はじめに](#はじめに)
2. [基本的な使い方](#基本的な使い方)
3. [高度な機能](#高度な機能)
4. [設定](#設定)
5. [ベストプラクティス](#ベストプラクティス)
6. [ヒントとコツ](#ヒントとコツ)
7. [ユースケース](#ユースケース)

## はじめに

### クイックスタート

1. **LunaCode のインストール**

```bash
# Bun を使用（推奨）
curl -fsSL https://bun.sh/install | bash

# グローバルインストール
bun install --global
```

2. **LLM プロバイダーの選択**

LunaCode は複数の LLM プロバイダーに対応しています。

**最大パフォーマンス（オンライン）:**

```bash
export OPENAI_API_KEY=your-key
lunacode "最初のクエリ"
```

**完全なプライバシー（オフライン）:**

```bash
# Ollama のインストール
curl -fsSL https://ollama.com/install.sh | sh

# モデルの取得
ollama pull llama3.1

# LunaCode の設定
export OLLAMA_BASE_URL=http://localhost:11434
export OLLAMA_MODEL=llama3.1
lunacode "最初のクエリ"
```

**ローカルとクラウドの併用:**

```bash
# LM Studio を https://lmstudio.ai からインストール
export LMSTUDIO_BASE_URL=http://localhost:1234/v1
lunacode "最初のクエリ"
```

3. **最初のクエリを実行**

```bash
lunacode "JavaScript でシンプルな関数を作成して"
```

LunaCode が自動的にタスクを処理します。

### プロジェクトの初期設定

LunaCode をディレクトリで初めて実行すると、プロジェクトルート直下に `.kairos/` ディレクトリが作成され、すべてのデータがその中に保存されます:

```
your-project/
├── .kairos/              # LunaCode データディレクトリ（すべてここに格納）
│   ├── config.json      # プロジェクト設定（手動作成）
│   ├── MEMORY.md        # メインメモリファイル
│   ├── topics/          # トピック別ファイル（*.md）
│   ├── logs/            # 日別アクティビティログ（*.log）
│   ├── hooks.json       # ライフサイクルフック定義（手動作成）
│   ├── daemon.pid       # デーモンプロセスID（起動時に自動作成）
│   ├── dreams/          # AutoDream ログ
│   ├── activity.json    # 最終アクティビティ時刻
│   └── sessions.json    # セッション情報
└── your-code-files
```

> メモリ関連ファイル（MEMORY.md, topics/, logs/）はすべて `.kairos/` 配下に保存されます。`config.json` や `hooks.json` は手動で作成する設定ファイルです。

## 基本的な使い方

### コーディング支援

**シンプルなクエリ:**

```bash
lunacode "ユーザー管理用の REST API エンドポイントを作成して"
```

**複雑なタスク:**

```bash
lunacode "認証、データベース、フロントエンドを含むフルスタックアプリケーションを実装して"
```

**フォローアップ質問:**

```bash
lunacode "ユーザー一覧 API にページネーションを追加して"
```

### メモリ管理

**メモリの状態確認:**

```bash
lunacode memory stats
```

**メモリの検索:**

```bash
lunacode memory search "認証"
```

**メモリの圧縮:**

```bash
lunacode memory compact
```

**トピックの表示:**

```bash
lunacode memory topics
```

### デーモンモード

**デーモンの起動（バックグラウンド）:**

```bash
lunacode daemon start
```

**デーモンの状態確認:**

```bash
lunacode daemon status
```

**デーモンのログ表示:**

```bash
lunacode daemon logs
```

**デーモンの停止:**

```bash
lunacode daemon stop
```

### ドリームモード

**手動でドリームを実行:**

```bash
lunacode dream run
```

**ドリームの状態確認:**

```bash
lunacode dream status
```

**ドリーム履歴の表示:**

```bash
lunacode dream history
```

### バディモード

**ペットの情報確認:**

```bash
lunacode buddy info
```

**ペットを呼ぶ:**

```bash
lunacode buddy call ミケ
```

**ペットと会話:**

```bash
lunacode buddy talk こんにちは！
```

**ペットにごはん:**

```bash
lunacode buddy feed
```

**ペットと遊ぶ:**

```bash
lunacode buddy play
```

**ペットを寝かせる:**

```bash
lunacode buddy sleep
```

**新しいペットを作成:**

```bash
lunacode buddy create --type cat --name タマ
```

**利用可能なペットタイプの表示:**

```bash
lunacode buddy types
```

## 高度な機能

### マルチエージェント連携

LunaCode は複数のエージェントを並列実行できます。

1. **コーディネーターの起動:**

```bash
lunacode daemon start
```

2. **専門ワーカーの追加:**
   タスクに応じて LunaCode が自動的にワーカーを作成します。

3. **アクティビティの監視:**

```bash
lunacode daemon status
```

### 並列ツール実行

複雑なタスクを処理する際、LunaCode は複数のツールを同時実行してより高速に結果を返します。

### メモリの高度な管理

**カスタム圧縮設定:**

```json
// .kairos/config.json
{
  "memory": {
    "compaction": {
      "enabled": true,
      "maxContextLines": 200,
      "autoCompactThreshold": 500,
      "consolidationInterval": 24
    }
  }
}
```

### 通知システム

**通知の設定:**

```json
// .kairos/config.json
{
  "notifications": {
    "enabled": true,
    "channels": ["console", "os"],
    "priority": "medium",
    "quietHours": {
      "start": "22:00",
      "end": "06:00"
    }
  }
}
```

**モバイル通知の設定:**

1. https://pushover.net から Pushover API キーを取得
2. 設定に追加:

```json
{
  "notifications": {
    "pushover": {
      "userKey": "your-user-key",
      "apiToken": "your-api-token"
    }
  }
}
```

### アクセス制御（エンタープライズ向け）

**ユーザーの追加:**

```bash
lunacode admin add-user username --role user
```

**権限の管理:**

```bash
lunacode admin policy create --name "Development" --role user
```

**監査ログの表示:**

```bash
lunacode admin audit --limit 100
```

### サンドボックス環境

**コマンドの安全な実行:**

```bash
lunacode sandbox exec "npm install"
```

**実行履歴の確認:**

```bash
lunacode sandbox history
```

### アンダーカバーモード

商用利用時に LunaCode の出自を隠すモードです:

```json
{
  "undercover": {
    "enabled": true,
    "hideAnthropicReferences": true,
    "hideClaudeReferences": true,
    "customProjectName": "Code Assistant",
    "customAgentName": "AI Assistant"
  }
}
```

### ストリーミング応答

LunaCode は Ollama のストリーミングレスポンスに対応しています。LLM の応答がリアルタイムで表示され、待ち時間が大幅に短縮されます。ストリーミングは Ollama プロバイダーで自動的に有効になります。

### コンテキストウィンドウ管理

長い会話でもコンテキストが自動的に管理されます。モデルのコンテキスト長に応じて古いメッセージが自動でトリミングされ、システムメッセージは常に保持されます。

対応モデルのコンテキスト長:

```
llama3.1           — 131,072 tokens
llama3.1:8b        — 131,072 tokens
qwen2.5:14b        — 131,072 tokens
gemma4:e4b         — 131,072 tokens
qwen3.5:4b         —  32,768 tokens
mistral:7b         —  32,768 tokens
codellama:13b      —  16,384 tokens
deepseek-coder:6.7b —  16,384 tokens
（未登録モデル）     —   8,192 tokens（デフォルト）
```

### プロバイダーフォールバック

複数の LLM プロバイダーを設定している場合、1つのプロバイダーが障害を起こしても自動的に別のプロバイダーにフォールバックします。サーキットブレーカーパターンにより、障害のあるプロバイダーへの不要なリクエストを防ぎます。

設定例:
```json
{
  "llm": {
    "providers": [
      { "type": "ollama", "baseUrl": "http://localhost:11434", "model": "llama3.1" },
      { "type": "ollama", "baseUrl": "http://backup:11434", "model": "qwen2.5:14b" }
    ],
    "fallback": {
      "failureThreshold": 3,
      "resetTimeSeconds": 60
    }
  }
}
```

### モデル自動ルーティング

タスクの複雑度に応じて、軽量モデルと高性能モデルを自動的に切り替えます。

- **軽量タスク** — ファイル一覧、簡単な質問、ヘルプ要求 → 軽量モデル（高速応答）
- **複雑タスク** — リファクタリング、設計、デバッグ、テスト作成 → 高性能モデル（高品質応答）

設定例:
```json
{
  "llm": {
    "routing": {
      "lightModel": { "type": "ollama", "model": "qwen2.5:1.5b" },
      "heavyModel": { "type": "ollama", "model": "llama3.1" }
    }
  }
}
```

### ライフサイクルフック

エージェントの動作をカスタマイズするためのフックシステムです。イベントの前後にカスタム処理を挿入できます。

`.kairos/hooks.json` にフック定義を配置します:
```json
{
  "hooks": [
    {
      "name": "log-tool-usage",
      "event": "tool:after",
      "priority": 10,
      "command": "echo '[${toolName}] executed on ${filePath}' >> .kairos/tool-log.txt"
    },
    {
      "name": "lint-on-write",
      "event": "tool:after",
      "priority": 5,
      "condition": {
        "toolName": ["write_file"],
        "filePattern": "*.ts"
      },
      "command": "npx eslint ${filePath} --fix"
    }
  ]
}
```

対応イベント（11種）:
- `session:start` — セッション開始時
- `session:end` — セッション終了時
- `tool:before` — ツール実行前（abort でキャンセル可、modifyArgs で引数変更可）
- `tool:after` — ツール実行後
- `tool:error` — ツール実行エラー時
- `iteration:start` — イテレーション開始時
- `iteration:end` — イテレーション終了時
- `response:complete` — LLM 応答完了時
- `mcp:connected` — MCP サーバー接続時
- `mcp:disconnected` — MCP サーバー切断時
- `mcp:tool_called` — MCP ツール呼び出し時

### サブエージェント委譲

複雑なタスクを複数のサブエージェントに分割して並列実行できます。各サブエージェントにはロールに基づくツール権限が設定されます。

ロール:
- **explorer** — 読み取り専用（read_file, glob, grep）。コードの調査・分析に使用
- **worker** — 全ツール使用可。ファイル作成・編集などの実作業に使用
- **reviewer** — 読み取り + bash。コードレビュー・テスト実行に使用

エージェントが自動的に `delegate_task` ツールを使用してサブタスクを委譲します（最大6タスク、デフォルト並列数3）。

### チェックポイント＆ロールバック

ファイル変更操作（write_file, edit_file, bash）の実行前に自動でチェックポイントを作成します。問題が発生した場合に直前の状態に戻せます。

設定（`.kairos/config.json`）:

```json
{
  "checkpoint": {
    "enabled": true,
    "strategy": "branch",
    "maxCheckpoints": 50,
    "autoCheckpoint": true
  }
}
```

主な操作:
- **自動保存** — write_file/edit_file/bash 実行前に自動でスナップショット作成
- **undo** — 直前のチェックポイントの状態に戻す
- **rollback** — 指定した任意のチェックポイントまで戻す
- **diff** — チェックポイント間の変更差分を表示

> Git リポジトリ内でのみ動作します。セッション用の一時ブランチが自動作成され、終了時にクリーンアップされます。

### Diff プレビュー＆承認フロー

ファイル変更前に unified diff をプレビュー表示し、ユーザーの承認を求めます。

設定（`.kairos/config.json`）:

```json
{
  "approval": {
    "mode": "selective",
    "showDiff": true,
    "autoApproveReadOnly": true,
    "timeoutSeconds": 60
  }
}
```

承認モード:
- **auto** — すべての操作を自動承認（高速だが注意が必要）
- **confirm** — すべての操作で確認を求める（最も安全）
- **selective**（推奨） — リスクレベルに応じて判断。read-only 操作は自動承認、HIGH リスク操作（bash, rm 等）は確認を要求

リスクレベル:
- **LOW** — 読み取り専用（read_file, glob, grep, git status 等）
- **MEDIUM** — ファイル書き込み（write_file, edit_file）
- **HIGH** — シェル実行（bash）、システム変更

### MCP サーバー連携

外部の MCP（Model Context Protocol）サーバーと連携して、追加ツールを動的に利用できます。

設定（`.kairos/config.json`）:

```json
{
  "mcp": {
    "servers": [
      {
        "name": "filesystem",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
      },
      {
        "name": "github",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": { "GITHUB_TOKEN": "ghp_..." }
      }
    ]
  }
}
```

MCP サーバーのツールは `mcp_{サーバー名}_{ツール名}` の形式で自動登録されます。セッション開始時に設定されたサーバーへ自動接続し、セッション終了時に自動切断されます。

### スキルシステム

スキルとは、`.kairos/skills/` 以下に配置するカスタム処理モジュールです。特定のキーワードに反応して自動で実行されます。エージェントが「テスト実行」「デプロイ」などのキーワードを検出すると、対応するスキルスクリプトを自動呼び出しします。

**スキルの配置場所**:

```
.kairos/
└── skills/
    ├── test-runner/        # スキル名（ディレクトリ）
    │   ├── skill.json      # スキル定義
    │   └── run.sh          # 実行スクリプト
    └── deploy/
        ├── skill.json
        └── run.sh
```

**スキル定義（`skill.json`）の例**:

```json
{
  "name": "test-runner",
  "description": "プロジェクトのテストを実行する",
  "triggers": ["テストを実行", "テスト", "bun test", "run tests"],
  "script": "run.sh"
}
```

**実行スクリプト（`run.sh`）の例**:

```bash
#!/bin/bash
cd "$PROJECT_ROOT"
bun test --reporter=verbose
```

スキルが実行されると、結果がエージェントの Observation としてフィードバックされます。`triggers` に指定したキーワードがユーザーの指示に含まれると自動検出されます。

### TUI（ターミナル UI）

LunaCode には React Ink ベースのリッチな TUI が含まれています。標準の CLI モードに加え、視覚的に整理された UI で操作できます。

**起動方法**:

```bash
lunacode tui             # TUI モードで起動
lunacode tui --status    # ステータスパネル表示
```

**主な表示要素**:

| 要素 | 説明 |
|---|---|
| エージェント入力欄 | 指示を入力するプロンプト |
| 会話ビュー | エージェントとのやり取り履歴 |
| ツール実行パネル | リアルタイムのツール実行状況 |
| ステータスバー | 現在のモデル・イテレーション数・メモリ使用量 |
| Diff ビュー | 承認フロー有効時のファイル変更プレビュー |

**キーバインド**:

| キー | 操作 |
|---|---|
| `Enter` | メッセージ送信 |
| `Ctrl+C` | 現在の操作をキャンセル |
| `Ctrl+D` | TUI を終了 |
| `Tab` | 次のパネルにフォーカス移動 |
| `Esc` | ダイアログを閉じる |

> **注意**: TUI は Bun 実行時のみサポートされます。Node.js での実行時は標準 CLI モードにフォールバックします。

## 設定

### 環境変数

**OpenAI:**

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o-mini
```

**Ollama:**

```bash
export OLLAMA_BASE_URL=http://localhost:11434
export OLLAMA_MODEL=llama3.1
```

**LM Studio:**

```bash
export LMSTUDIO_BASE_URL=http://localhost:1234/v1
export LMSTUDIO_MODEL=local-model
```

**共通設定:**

```bash
export LUNACODE_MAX_ITERATIONS=50
export LUNACODE_TIMEOUT=15000
```

### 設定ファイル

`.kairos/config.json` を作成します:

```json
{
  "llmProvider": {
    "type": "openai",
    "apiKey": "your-api-key",
    "model": "gpt-4o-mini"
  },
  "memory": {
    "compaction": {
      "enabled": true,
      "maxContextLines": 200
    }
  },
  "daemon": {
    "enabled": false,
    "tickIntervalSeconds": 60
  },
  "notifications": {
    "enabled": true,
    "channels": ["console"]
  },
  "buddy": {
    "enabled": false
  }
}
```

### フック設定

フック定義ファイルを `.kairos/hooks.json` に配置すると、エージェント起動時に自動的に読み込まれます。変数 `${filePath}`, `${toolName}`, `${sessionId}` が利用可能です。

## ベストプラクティス

### 開発者向け

1. **シンプルに始める** — 基本的なクエリから始めて、LunaCode の応答を理解する
2. **メモリを活用** — プロジェクトのコンテキストを LunaCode のメモリに蓄積する
3. **段階的に進める** — 複雑なタスクは小さな管理可能な部分に分割する
4. **レビューする** — LunaCode の提案は必ず確認してから適用する

### チーム向け

1. **コンテキストの共有** — チームプロジェクトで `.kairos` ディレクトリを共有する
2. **デーモンモード** — バックグラウンドで継続的に支援するデーモンモードを有効にする
3. **メモリ管理** — 定期的にメモリの圧縮と整理を行う
4. **通知** — 重要な更新には通知を活用する

### 本番環境向け

1. **テスト** — デプロイ前にローカル LLM でテストする
2. **監視** — デーモンモードと通知を有効にする
3. **アクセス制御** — 適切なユーザー管理を実装する
4. **サンドボックス** — コード実行にはサンドボックス環境を使用する

## ヒントとコツ

### キーボードショートカット

LunaCode を対話モードで使用する場合:

- `Ctrl+C` — 現在の操作をキャンセル
- `Ctrl+D` — 対話モードを終了
- `help` と入力 — 利用可能なコマンドを表示

### メモリのコツ

1. **具体的に指示** — クエリが具体的であるほど、結果が良くなる
2. **トピックを活用** — 関連タスクでは特定のトピックを参照する
3. **定期的に圧縮** — パフォーマンス維持のために定期的にメモリを圧縮する
4. **まず検索** — 質問する前にメモリを検索する

### パフォーマンスのコツ

1. **ローカル LLM** — プライバシーと高速応答のためにローカル LLM を使用する
2. **メモリ管理** — コンテキストを最適化するためにメモリをコンパクトに保つ
3. **並列実行** — LunaCode のツール並列実行を活用する
4. **オフラインモード** — オフラインタスクでは API コールを最小化する
5. **モデルルーティング** — タスクの複雑度に応じた自動ルーティングで、軽量タスクの応答速度を向上
6. **ストリーミング** — Ollama ストリーミングでリアルタイム応答表示、待ち時間の体感を短縮

### バディモードのコツ

1. **定期的に交流** — ペットの幸福度を維持するために定期的にインタラクションする
2. **ケアアクション** — ごはん、遊び、ケアなどペットのニーズに応える
3. **性格** — ペットの種類ごとに固有の特性がある
4. **名前の重要性** — 意味のある名前をつけるとよりよいインタラクションに

## ユースケース

### Web 開発

**新しいプロジェクトのセットアップ:**

```bash
lunacode "React + TypeScript + Vite + Tailwind CSS で新しいプロジェクトを作成して"
lunacode "src/, public/, components/ ディレクトリでプロジェクト構造をセットアップして"
```

**機能の段階的追加:**

```bash
lunacode "JWT を使った認証を追加して"
lunacode "ユーザー登録フォームを実装して"
lunacode "ユーザー管理用の API エンドポイントを作成して"
```

### バックエンド開発

**REST API の設計:**

```bash
lunacode "ブログアプリケーション用の RESTful API エンドポイントを設計して"
lunacode "ブログ投稿の CRUD 操作を実装して"
```

**データベース操作:**

```bash
lunacode "User と Post エンティティのデータベースモデルを作成して"
lunacode "データベースマイグレーションを実装して"
```

### DevOps

**デプロイスクリプトの作成:**

```bash
lunacode "Node.js アプリケーション用の Dockerfile を作成して"
lunacode "npm scripts を使ったデプロイスクリプトを書いて"
```

**CI/CD の設定:**

```bash
lunacode "テストとデプロイ用の GitHub Actions ワークフローを作成して"
```

### ドキュメント

**ドキュメントの生成:**

```bash
lunacode "すべての関数に JSDoc コメントを生成して"
lunacode "OpenAPI 仕様で API ドキュメントを作成して"
```

**ガイドの作成:**

```bash
lunacode "新しいコントリビューター向けの入門ガイドを書いて"
lunacode "よくある問題と解決策のトラブルシューティングガイドを作成して"
```

## ヘルプ・サポート

### ドキュメント

- [アーキテクチャ](./ARCHITECTURE.md) — 内部設計の詳細
- [開発計画](./inside/plan.md) — 全フェーズの開発計画と進捗

### コミュニティ

- [GitHub Issues](https://github.com/zephel01/lunacode/issues) — バグ報告・機能リクエスト
- [GitHub Discussions](https://github.com/zephel01/lunacode/discussions) — 一般的な質問・ディスカッション

### サポート

- 複雑な問題は `support` ラベル付きの Issue を作成してください
- 一般的な質問は Discussions をご利用ください
- 新しい Issue を作成する前に既存の Issue を確認してください
