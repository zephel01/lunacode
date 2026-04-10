# セットアップガイド

LunaCode のインストールと初期設定の手順を説明します。

## 目次

- [動作要件](#動作要件)
- [インストール](#インストール)
- [LLM プロバイダーの設定](#llm-プロバイダーの設定)
  - [OpenAI を使う場合](#openai-を使う場合)
  - [Ollama を使う場合（ローカル）](#ollama-を使う場合ローカル)
  - [LM Studio を使う場合（ローカル）](#lm-studio-を使う場合ローカル)
  - [LiteLLM を使う場合](#litellm-を使う場合)
- [設定ファイル](#設定ファイル)
- [接続テスト](#接続テスト)
- [アンインストール](#アンインストール)

---

## 動作要件

| 項目 | 要件 |
|---|---|
| ランタイム | [Bun](https://bun.sh) >= 1.0.0 または Node.js >= 18.0.0 |
| OS | macOS / Linux / Windows (WSL推奨) |
| LLM | OpenAI API キー、または Ollama / LM Studio のいずれか |
| ツール（オプション） | [ripgrep](https://github.com/BurntSushi/ripgrep) — `grep` ツールの高速検索に使用 |

## インストール

### 1. Bun のインストール（まだの場合）

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. LunaCode のクローンとセットアップ

```bash
git clone https://github.com/zephel01/lunacode.git
cd lunacode
bun install
```

### 3. グローバルインストール（オプション）

パスが通った場所からどこでも `lunacode` コマンドを使えるようにするには:

```bash
bun link
```

またはシェルスクリプト `lunacode.sh` にパスを通す方法もあります:

```bash
chmod +x lunacode.sh
ln -s "$(pwd)/lunacode.sh" /usr/local/bin/lunacode
```

---

## LLM プロバイダーの設定

LunaCode は複数の LLM プロバイダーに対応しています。**推奨は `lunacode init` による対話的セットアップ**です。

### 対話的セットアップ（推奨）

```bash
lunacode init
```

対話形式でプロバイダーとモデルを選択し、`.kairos/config.json` を自動生成します。Ollama / LM Studio の場合は API に接続してインストール済みモデルの一覧を取得し、番号で選択できます。

特定のプロバイダーを指定する場合:

```bash
lunacode init --provider ollama
```

### プロバイダー一覧

| プロバイダー | 特徴 | 必要なもの |
|---|---|---|
| `openai` | 最も安定・高品質 | API キー |
| `ollama` | ローカル実行、プライバシー重視 | Ollama + モデル |
| `lmstudio` | GUIでモデル管理 | LM Studio アプリ |
| `zai` | コーディング特化 GLM モデル | API キー |
| `litellm` | 100+ プロバイダー統合プロキシ | LiteLLM サーバー |

### OpenAI

```json
{
  "llm": {
    "provider": "openai",
    "openai": {
      "apiKey": "sk-...",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini"
    }
  }
}
```

### Ollama（ローカル）

1. [Ollama](https://ollama.com/) をインストール
2. モデルをダウンロード: `ollama pull llama3.1`
3. `lunacode init --provider ollama` でセットアップ（モデル一覧から自動選択可能）

```json
{
  "llm": {
    "provider": "ollama",
    "ollama": {
      "baseUrl": "http://localhost:11434",
      "model": "llama3.1"
    }
  }
}
```

モデルの変更:

```bash
# 利用可能なモデル一覧を表示
lunacode config models

# モデルを変更
lunacode config set llm.ollama.model codellama
```

### Z.AI Coding Plan

[Z.AI](https://z.ai/) の GLM モデルを使用できます。コーディング特化の専用エンドポイントに対応しています。

1. [Z.AI](https://z.ai/subscribe) でアカウント作成
2. [API キー管理ページ](https://z.ai/manage-apikey/apikey-list) で API キーを発行

```json
{
  "llm": {
    "provider": "zai",
    "zai": {
      "apiKey": "your-zai-api-key",
      "model": "glm-5.1",
      "useCodingEndpoint": true
    }
  }
}
```

利用可能なモデル: `glm-5.1`（最新）, `glm-5`, `glm-5-turbo`（高速）, `glm-4.7`, `glm-4.7-flashx`, `glm-4.5`

### LM Studio（ローカル）

```json
{
  "llm": {
    "provider": "lmstudio",
    "lmstudio": {
      "baseUrl": "http://localhost:1234/v1",
      "model": "local-model"
    }
  }
}
```

### LiteLLM

```json
{
  "llm": {
    "provider": "litellm",
    "litellm": {
      "baseUrl": "http://localhost:4000/v1",
      "apiKey": "your-key",
      "model": "gpt-4o-mini"
    }
  }
}
```

### 環境変数（フォールバック）

config.json が無い場合、環境変数から自動検出します（優先順位: LM Studio > Ollama > Z.AI > OpenAI）:

```bash
# OpenAI
export OPENAI_API_KEY="sk-..." OPENAI_MODEL="gpt-4o-mini"

# Ollama
export OLLAMA_BASE_URL="http://localhost:11434" OLLAMA_MODEL="llama3.1"

# Z.AI
export ZAI_API_KEY="your-key" ZAI_MODEL="glm-5.1"

# LM Studio
export LMSTUDIO_BASE_URL="http://localhost:1234/v1"
```

**config.json の設定値が環境変数より優先されます。**

---

## 設定ファイル（config.json）

`.kairos/config.json` に配置します。`lunacode init` で自動生成するか、手動で作成できます。テンプレートは `config.example.json` を参照してください。

### 設定の管理コマンド

```bash
# 現在の設定を表示
lunacode config show

# 設定値を変更
lunacode config set llm.provider ollama
lunacode config set llm.ollama.model codellama
lunacode config set llm.temperature 0.5
lunacode config set agent.maxIterations 100

# 現在のプロバイダーの利用可能モデル一覧
lunacode config models
```

### 設定の優先順位

1. **config.json のプロバイダー固有設定** (例: `llm.ollama.model`)
2. **config.json の共通設定** (例: `llm.model`)
3. **環境変数** (例: `OLLAMA_MODEL`)
4. **デフォルト値**

### 全体構造

```json
{
  "llm": {
    "provider": "ollama",
    "temperature": 0.7,
    "maxTokens": 4096,
    "ollama": { "baseUrl": "...", "model": "..." },
    "openai": { "apiKey": "...", "baseUrl": "...", "model": "..." },
    "zai": { "apiKey": "...", "model": "...", "useCodingEndpoint": true }
  },
  "agent": {
    "maxIterations": 50,
    "timeout": 15000
  },
  "memory": {
    "enabled": true,
    "maxTokens": 200
  },
  "daemon": {
    "enabled": false,
    "tickIntervalSeconds": 60
  }
}
```

**`llm`** — LLM プロバイダー設定。`provider` でアクティブなプロバイダーを指定。各プロバイダー固有の設定はネストオブジェクトで。

**`agent`** — エージェントループ設定。`maxIterations` は1クエリの最大ループ回数（デフォルト: 50）。

**`memory`** — メモリシステム設定。`enabled: false` でメモリ無効化。

**`daemon`** — KAIROS デーモン設定。`tickIntervalSeconds` は Tick 間隔（秒）。

---

## 接続テスト

```bash
lunacode test-provider
```

成功すると以下のように表示されます:

```
📡 Using ollama provider
🤖 Model: llama3.1
✅ Connection successful!
```

---

## 使用方法

### 1. 対話モード（REPL）— おすすめ

チャットのように何度も質問・会話できます。長めの作業（複数ステップのプロジェクト作成など）に最適。

```bash
lunacode           # または: lunacode chat, lunacode -i
```

対話モード内のコマンド:
- `/exit` または `/quit` — 終了
- `/clear` — 会話履歴をクリア
- `/status` — エージェント状態を表示
- `/memory` — メモリ統計を表示

**例：**
```
🌙 > JavaScript でテトリスを作成してください
🤖 テトリスの作成ですね... [回答と質問]

🌙 > はい、ゲームロジックから始めてください
🤖 ゲームボードの初期化... [実装開始]

🌙 > 描画機能も作成してください
🤖 Canvas API で描画... [続行]

🌙 > /exit
👋 Bye!
```

### 2. 自動実行モード — セットアンドフォーゲット

タスク完了まで自動でツール実行・ファイル作成を行います。確認なし、質問には自動応答。

```bash
lunacode --auto "JavaScript でテトリスの作成"
lunacode --auto "REST API を Python で作成" --rounds 15
```

オプション:
- `--rounds <N>` — 最大ラウンド数（デフォルト: 10）。複雑なタスクは `--rounds 20` など増やす。

**動作:**
1. LLM がツール実行（ファイル作成、コード編集など）を自動で決定
2. 質問が来たら「はい、お願いします」で自動応答
3. 完了キーワード（「完了」「作成しました」など）で終了

### 3. ワンショットモード — シンプル

1回のやり取りで質問・回答する。シンプルな質問や説明に最適。

```bash
lunacode "テトリスのおすすめ言語は"
lunacode "REST API の設計ベストプラクティス"
```

---

## 推奨される使い方

| 用途 | モード | 例 |
|---|---|---|
| **コードを作成してほしい** | 自動実行 (--auto) | `lunacode --auto "JavaScript で TODO アプリ作成"` |
| **複数ステップで細かく指示したい** | 対話 (chat) | `lunacode chat` → 一歩ずつ指示 |
| **説明や意見をもらいたい** | ワンショット | `lunacode "Python の学習順序は"` |
| **リアルタイムで会話したい** | 対話 (chat) | `lunacode` |

---

## アンインストール

```bash
# グローバルリンクを解除
bun unlink lunacode

# ディレクトリを削除
cd ..
rm -rf lunacode
```

---

次のステップ: [使い方ガイド](./usage.md) へ進んで、基本的な操作方法を学びましょう。
