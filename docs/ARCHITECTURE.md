# LunaCode 内部アーキテクチャ

開発者向けの技術ドキュメントです。LunaCode の内部設計、ツール実行パイプライン、テスト戦略について記述します。

## 全体構成

```
src/
├── cli.ts                 # エントリーポイント（コマンド解析・モード分岐）
├── agents/
│   ├── AgentLoop.ts       # ReAct パターンメインループ
│   └── MultiAgentCoordinator.ts  # マルチエージェント制御
├── providers/
│   ├── LLMProvider.ts     # プロバイダー共通インターフェース
│   ├── LLMProviderFactory.ts  # Factory パターン
│   ├── OllamaProvider.ts  # Ollama 統合（ネイティブ + フォールバック）
│   ├── OpenAIProvider.ts  # OpenAI API
│   ├── LMStudioProvider.ts # LM Studio
│   └── ZAIProvider.ts     # Z.AI / GLM
├── tools/
│   ├── ToolRegistry.ts    # ツール管理・実行
│   ├── BaseTool.ts        # ツール基底クラス
│   ├── BasicTools.ts      # 7つのコアツール
│   └── ParallelToolExecutor.ts  # 並列実行エンジン
├── memory/
│   └── MemorySystem.ts    # 3層メモリ + 自動圧縮
├── config/
│   └── ConfigManager.ts   # 設定管理（デフォルト + ファイルマージ）
├── daemon/
│   ├── KAIROSDaemon.ts    # 常駐デーモン
│   └── AutoDream.ts       # バックグラウンド統合
├── security/
│   ├── AccessControl.ts   # RBAC
│   └── SandboxEnvironment.ts  # サンドボックス
├── buddy/
│   └── BuddyMode.ts      # コンパニオンAI
├── notifications/
│   └── NotificationManager.ts  # 通知システム
├── ui/
│   └── TUI.ts             # React Ink UI
├── utils/
│   └── Spinner.ts         # スピナーアニメーション
└── types/
    └── index.ts           # 全型定義
```

## ツール実行パイプライン

LunaCode の中核は「ユーザーの指示を受け取り、LLM がツール呼び出しを生成し、実際にファイル操作を行う」パイプラインです。

### 1. エントリーポイント → AgentLoop

```
cli.ts
  ↓ --auto モード
  ↓ AgentLoop.processUserInput(userInput)
  ↓
  ├── ConfigManager.load()          # config.json からモデル・maxIterations 等を読込
  ├── MemorySystem.searchMemory()   # 過去の関連コンテキスト検索
  ├── システムプロンプト構築         # ツール説明 + メモリ + ReAct 指示
  └── runLoop() 開始
```

### 2. ReAct ループ（runLoop）

```
while (iteration < maxIterations):
  ├── LLMProvider.chatCompletion(messages, tools)
  │     ↓
  │   ┌─ tool_calls あり ─────────────────────┐
  │   │  ToolRegistry.executeTool(name, args)  │
  │   │  結果を messages に追加                  │
  │   │  → ループ継続                           │
  │   └────────────────────────────────────────┘
  │     ↓
  │   ┌─ tool_calls なし ─────────────────────┐
  │   │  content.length < 200 && iteration<=3  │──→ リトライ（最大2回）
  │   │  それ以外                               │──→ タスク完了、ループ終了
  │   └────────────────────────────────────────┘
```

リトライ時は、`<tool_call>` タグの具体的な書式例を含むメッセージを追加して再リクエストします。

### 3. OllamaProvider のツール呼び出しフロー

```
chatCompletion(request)
  ↓
  useNativeTools === true?
  ├── YES → chatCompletionWithNativeTools()
  │         ├── /api/chat に tools パラメータ付きで送信
  │         ├── tool_calls あり → ToolCall[] に変換して返却
  │         ├── content あり & tool_calls なし → extractToolCallsFromText()
  │         └── 両方なし（空レスポンス） → useNativeTools = false に切替
  │                                         → chatCompletionWithTextExtraction() にフォールバック
  │
  └── NO → chatCompletionWithTextExtraction()
            ├── tools を送信せず、システムプロンプトにツール説明を注入
            ├── テキスト応答から extractToolCallsFromText() で抽出
            └── 6パターンのマッチング
```

**重要な設計判断**: `useNativeTools` フラグは **インスタンス単位** で管理されます。一度フォールバックしたモデルは、そのセッション中はテキスト抽出モードを継続します。

### 4. テキスト抽出パターン（extractToolCallsFromText）

優先度順に評価。最初にマッチしたパターンで抽出を終了します。

| 優先度 | パターン | 正規表現 | 対応モデル |
|---|---|---|---|
| 1 | `<tool_call>` タグ | `/<tool_call>\s*\n?\s*([\s\S]*?)\s*\n?\s*<\/tool_call>/g` | 汎用 |
| 2 | コードブロック | `/```(?:json)?\s*([\s\S]*?)\s*```/g` | 汎用 |
| 3 | Mistral `[TOOL_CALLS]` | `/\[TOOL_CALLS\]\s*(\[[\s\S]*?\])/gi` | mistral 系 |
| 4 | Gemma `Tool call:` | `/Tool\s*call:\s*(\w+)\s*(\{[\s\S]*?\})/gi` | gemma4 系 |
| 5 | JSON 配列 | `/(?:^|\n)\s*(\[\s*\{[\s\S]*?"name"\s*:[\s\S]*?\}\s*\])/g` | 配列出力モデル |
| 6 | 生 JSON | `/\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g` | 最終手段 |

### 5. データ正規化（normalizeToolData）

異なるモデルが異なる JSON 構造を出力するため、6つのフォーマットを統一的に処理します。

```typescript
// 入力フォーマット → 出力: { name: string, arguments: Record }
{ name, arguments }          // 標準形式
{ name, parameters }         // llama3.1 リトライ時
{ function: { name, arguments } }  // OpenAI 形式
{ function: { name, parameters } } // OpenAI 代替
{ tool, parameters }         // 代替形式
{ action, params }           // 代替形式
```

## ConfigManager

`ConfigManager` は `.kairos/config.json` を読み込み、デフォルト値とディープマージします。

```typescript
// デフォルト設定
{
  llm: { provider: "ollama", model: "llama3.1" },
  agent: { maxIterations: 50, timeout: 15000 },
  memory: { ... },
  daemon: { ... }
}
```

**重要**: `AgentLoop.initialize()` で `configManager.load()` を呼び出します。これを忘れるとデフォルト値（maxIterations=50）が使われます。

## セキュリティ

### 危険コマンド検出（BashTool）

以下のパターンにマッチするコマンドはブロックされます。

```
rm -rf /          # ルートディレクトリ削除
rm -rf /*         # ルート配下全削除
dd if=/dev/zero   # ディスク破壊
mkfs              # フォーマット
chmod 777 /       # パーミッション変更
:(){ :|:& };:     # Fork bomb
sudo rm           # 特権削除
curl ... | bash   # リモートスクリプト実行
wget ... | sh     # リモートスクリプト実行
> /dev/sda        # デバイス上書き
mv /* /dev/null   # 全ファイル消失
```

## テスト戦略

### テストピラミッド

```
         ┌───────────────┐
         │ coding-task   │  ← E2E: 実 Ollama でファイル作成→実行→出力検証
         │  (3 tests)    │
         ├───────────────┤
         │ benchmark     │  ← 統合: ツール速度、LLM応答、検出精度
         │  (8 tests)    │
         ├───────────────┤
         │ agent-loop    │  ← 統合: MockLLM でループ検証
         │  (6 tests)    │
    ┌────┴───────────────┴────┐
    │ tools / provider /      │  ← 単体: 個別コンポーネント
    │ security / daemon       │
    │ (59 tests)              │
    └─────────────────────────┘
```

### テストファイル詳細

**tools.test.ts（16テスト）**
ToolRegistry の登録・取得・説明文生成、write_file / read_file / edit_file / bash の各ツールを個別検証。bash は危険コマンドのブロックと安全コマンドの許可を含む。

**ollama-provider.test.ts（18テスト）**
初期化、ネイティブ Tool Calling（Ollama 起動時のみ）、テキスト抽出の全6パターン、normalizeToolData の全6フォーマット、自動フォールバックフラグの状態。

**agent-loop.test.ts（6テスト）**
MockLLMProvider を使い、テキスト応答・ツール呼び出し→ファイル作成・複数ツール連鎖・失敗時の継続・write→read→edit チェーン・状態リセットを検証。

**security.test.ts（25テスト）**
15種の危険コマンドがブロックされること、10種の安全コマンドが許可されることを検証。

**benchmark.test.ts（8テスト）**
ツール実行速度（write 10KB / read 100KB / edit 12KB / bash echo）の統計、全 Ollama モデルの応答時間・検出精度・E2E ファイル作成を計測。

**coding-task.test.ts（3テスト）**
推奨モデル全てで hello.js 作成、FizzBuzz 実装（Node.js 実行検証）、JSON データ処理（フィルタリング出力検証）の実践タスクを実行。モデルごと60秒タイムアウト付き。

### テスト実行

```bash
# 全テスト
bun test

# Ollama 不要（モック・単体のみ）
bun test tests/tools.test.ts tests/security.test.ts tests/agent-loop.test.ts

# Ollama 必要（統合・E2E）
bun test tests/ollama-provider.test.ts tests/benchmark.test.ts tests/coding-task.test.ts
```

## 設定ファイル（.kairos/config.json）

```json
{
  "llm": {
    "provider": "ollama",
    "model": "llama3.1"
  },
  "agent": {
    "maxIterations": 50,
    "timeout": 15000
  },
  "memory": {
    "maxMainMemorySize": 50000,
    "autoCompactThreshold": 30000
  },
  "daemon": {
    "tickInterval": 60000,
    "autoDream": {
      "enabled": true,
      "idleThreshold": 300000
    }
  }
}
```

## 今後の改善方針

1. **ストリーミング対応** — LLM レスポンスのリアルタイム表示
2. **ツール結果のコンテキスト最適化** — 長いツール出力の自動要約
3. **モデル自動選択** — タスク複雑度に応じたモデル切替
4. **プロンプトキャッシュ** — 同一システムプロンプトのキャッシュ
5. **Web UI** — ブラウザベースのインターフェース
