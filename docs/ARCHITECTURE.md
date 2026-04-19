# LunaCode 内部アーキテクチャ

開発者向けの技術ドキュメントです。LunaCode の内部設計、ツール実行パイプライン、テスト戦略について記述します。

## 全体構成

```
src/
├── cli.ts                 # エントリーポイント（コマンド解析・モード分岐）
├── agents/
│   ├── AgentLoop.ts       # ReAct パターンメインループ
│   ├── MultiAgentCoordinator.ts  # マルチエージェント制御
│   ├── ContextManager.ts  # コンテキストウィンドウ管理
│   ├── TaskClassifier.ts  # タスク複雑度分類
│   ├── ModelRouter.ts     # モデル自動ルーティング
│   └── SubAgentManager.ts # サブエージェント管理
├── providers/
│   ├── LLMProvider.ts     # プロバイダー共通インターフェース
│   ├── LLMProviderFactory.ts  # Factory パターン
│   ├── OllamaProvider.ts  # Ollama 統合（ネイティブ + フォールバック）
│   ├── OpenAIProvider.ts  # OpenAI API
│   ├── LMStudioProvider.ts # LM Studio
│   ├── ZAIProvider.ts     # Z.AI / GLM
│   ├── ModelRegistry.ts   # モデル情報レジストリ
│   ├── CircuitBreaker.ts  # サーキットブレーカー
│   └── FallbackProvider.ts # フォールバックプロバイダー
├── tools/
│   ├── ToolRegistry.ts    # ツール管理・実行
│   ├── BaseTool.ts        # ツール基底クラス
│   ├── BasicTools.ts      # 7つのコアツール
│   ├── ParallelToolExecutor.ts  # 並列実行エンジン
│   └── SubAgentTool.ts    # サブエージェント委譲ツール
├── hooks/
│   ├── HookManager.ts     # ライフサイクルフック管理
│   └── FileHookLoader.ts  # ファイルベースフック読込
├── memory/
│   ├── MemorySystem.ts    # 3層メモリ + 自動圧縮
│   ├── EmbeddingProvider.ts  # 埋め込みベクトル生成（Ollama / OpenAI / TF-IDF）
│   ├── VectorStore.ts     # ベクトルストア（コサイン類似度 + JSON永続化）
│   └── LongTermMemory.ts  # 長期メモリ管理（ベクトル検索 + ハイブリッド RRF）
├── config/
│   └── ConfigManager.ts   # 設定管理（デフォルト + ファイルマージ）
├── daemon/
│   ├── KAIROSDaemon.ts    # 常駐デーモン
│   └── AutoDream.ts       # バックグラウンド統合
├── security/
│   ├── AccessControl.ts   # RBAC
│   └── SandboxEnvironment.ts  # @deprecated Phase 25 (src/sandbox/ に置き換え)
├── buddy/
│   └── BuddyMode.ts      # コンパニオンAI
├── notifications/
│   └── NotificationManager.ts  # 通知システム
├── ui/
│   └── TUI.ts             # React Ink UI
├── utils/
│   ├── Spinner.ts         # スピナーアニメーション
│   └── TokenCounter.ts    # トークン数推定
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

## Phase 1-9 拡張コンポーネント

### ストリーミング応答（Phase 1）

LLM の応答をリアルタイムで表示するため、OllamaProvider にストリーミング対応を実装。

**OllamaProvider.chatCompletionStream()**
- 戻り値: `AsyncGenerator<StreamChunk>`
- Ollama の `/api/chat` エンドポイントに `stream: true` パラメータで接続
- NDJSON フォーマットで段階的にトークンを受信

**StreamChunk の型**
```typescript
interface StreamChunk {
  type: "content" | "tool_call_start" | "tool_call_delta" | "tool_call_end" | "done" | "error";
  delta?: string;           // content チャンク
  toolCallIndex?: number;   // tool_call チャンク
  toolCall?: Partial<ToolCall>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  error?: string;
}
```

### コンテキストウィンドウ管理（Phase 2）

長いセッション中にコンテキスト長を超過しないよう、メッセージを自動的に削減。

**TokenCounter**
- CJK 文字（漢字・ひらがな・カタカナ）: ~0.67 tokens/char
- ASCII 文字: ~0.25 tokens/char
- メッセージのオーバーヘッド: role + name で 4 tokens、content 開始で +2 tokens

**ContextManager**
- `fitMessages(messages, maxTokens)`: メッセージ配列をコンテキスト長内に収める
- システムメッセージは常に保持
- 非システムメッセージは古い順に削除

**ModelRegistry**
- 8つの既知モデルのコンテキスト長を管理
- 動的ルックアップ: Ollama `/api/show` エンドポイント経由で未知モデルの情報取得

### プロバイダーフォールバック（Phase 3）

複数の LLM プロバイダーを組み合わせて、可用性と信頼性を向上。

**CircuitBreaker**
- 状態遷移: closed → open → half-open → closed
- failureThreshold: 3（3回失敗で open）
- resetTimeSeconds: 60（60秒後に half-open）
- open 状態では即座にエラーを返す（API 呼び出しを遮断）

**FallbackProvider**
- 複数の `ILLMProvider` をラップ
- ラウンドロビン方式で順番に試行
- sticky active provider: 最後に成功したプロバイダーを優先

### モデル自動ルーティング（Phase 4）

タスクの複雑度を判定し、軽量（fast）と重量（heavy）モデルを自動選択。

**TaskClassifier**
- キーワードスコアリング:
  - 複雑キーワード（分析・最適化・設計など）: +1
  - 単純キーワード（読む・表示・一覧など）: -1
  - メッセージ長 > 1000: +0.5
  - 反復回数 > 3: +0.5
- 判定基準:
  - スコア ≥ 1.5: **complex**（重量モデル）
  - スコア ≤ -0.5: **simple**（軽量モデル）
  - その他: **normal**（デフォルト）

**ModelRouter**
- light provider（fast）と heavy provider を設定
- `selectProvider(context, taskInput)` で最適なプロバイダーを返す
- 戻り値: `{ provider: ILLMProvider, classification: TaskComplexity }`

### ライフサイクルフック（Phase 7）

セッションやツール実行の特定タイミングで処理を挿入。

**HookManager**
- `register(event, callback, priority)`: イベントリスナー登録（優先度順）
- `emit(event, context)` で非同期実行、`abort()` で中断可能、`modifyArgs()` で引数変更可能

**FileHookLoader**
- `.kairos/hooks.json` から hooks を読込
- 変数補間: `${HOME}`, `${PROJECT_ROOT}`, `${timestamp}` に対応

**対応イベント（11種）**
- `session:start` / `session:end` — セッション開始・終了
- `tool:before` / `tool:after` / `tool:error` — ツール実行ライフサイクル
- `iteration:start` / `iteration:end` — ReAct イテレーション
- `response:complete` — LLM 応答完了
- `mcp:connected` / `mcp:disconnected` / `mcp:tool_called` / `mcp:error` — MCP イベント

### チェックポイント＆ロールバック（Phase 5）

Git ベースのチェックポイントシステム。write_file/edit_file/bash 実行前に自動保存。

**CheckpointManager**
- `initialize()` — .git 確認、セッション用ブランチ作成
- `create(description)` — `git add -A && git commit` でスナップショット保存
- `rollback(checkpointId)` — `git reset --hard {commitHash}` で指定時点に復元
- `undo()` — 直前チェックポイントの状態に戻す
- `diff(fromId, toId?)` — `git diff` でチェックポイント間の差分取得
- `cleanup()` — 元ブランチに復帰、セッションブランチ削除
- maxCheckpoints によるプルーニング（古い順に自動削除）

### Diff プレビュー＆承認フロー（Phase 6）

ファイル変更前に diff プレビューを表示し、ユーザー承認を求める。

**DiffGenerator**
- `generateUnifiedDiff(old, new, path)` — 行ベース unified diff 生成
- `generateWriteDiff(path, content)` — 既存ファイルとの差分（新規は /dev/null）
- `generateEditDiff(path, old, new, content)` — `indexOf()` でマルチライン対応
- `colorize(diff)` — ANSI エスケープ（赤:削除 / 緑:追加 / シアン:ヘッダー）

**ApprovalManager**
- 3 モード: `auto`（常時承認） / `confirm`（常時確認） / `selective`（リスクベース）
- リスクレベル: LOW（read-only）/ MEDIUM / HIGH（bash, rm 等）
- selective モードでは LOW=自動承認、MEDIUM/HIGH=確認要求
- コールバックベース UI 統合（カスタムプロンプト対応）

### 長期メモリ + ベクトル検索（Phase 10）

セッションを跨いだ学習・想起を可能にするベクトルベースのメモリシステム。外部 DB 不要の純 TypeScript 実装。

**EmbeddingProvider**（`src/memory/EmbeddingProvider.ts`）

3種類の埋め込みプロバイダーを提供し、利用可能なものを自動選択:

| プロバイダー | モデル | 備考 |
|---|---|---|
| `OllamaEmbeddingProvider` | nomic-embed-text（768次元） | ローカル・完全オフライン |
| `OpenAIEmbeddingProvider` | text-embedding-3-small（1536次元） | APIキー要 |
| `TFIDFEmbeddingProvider` | TF-IDF スパースベクトル | フォールバック、常に動作 |

```typescript
const provider = await createAutoEmbeddingProvider(ollamaBaseUrl?, openAIApiKey?);
```

**VectorStore**（`src/memory/VectorStore.ts`）

- インメモリ + JSON 永続化（`.kairos/vector-memory.json`）
- コサイン類似度による Top-K 検索
- メタデータフィルタリング（type / sessionId）
- キーワード検索（TF-IDF スコアリング）
- 最大エントリ数の自動 FIFO プルーニング

```typescript
export function cosineSimilarity(a: number[], b: number[]): number
```

**LongTermMemory**（`src/memory/LongTermMemory.ts`）

高レベル API。AgentLoop から自動呼び出しされる。

```typescript
await longTermMemory.store(content, { type, sessionId, tags })
await longTermMemory.storeTaskResult(task, result, sessionId, success)
await longTermMemory.storeError(errorMessage, context, resolution, sessionId)
await longTermMemory.storeCode(description, code, filePath, sessionId)
const context = await longTermMemory.buildContext(userQuery, maxTokens?)
```

**ハイブリッド検索（RRF）**
- ベクトル類似度検索 + キーワード検索を並行実行
- Reciprocal Rank Fusion でスコアを統合
- `buildContext()` で取得した結果をシステムプロンプトに自動注入

**AgentLoop 統合**
- `initialize()`: 埋め込みプロバイダーを自動選択し `LongTermMemory` を初期化
- `processUserInput()`: `buildContext()` でクエリ関連の過去記憶を取得し注入
- ツール実行後: エラーを `storeError()`、ファイル書き込みを `storeCode()` で記録
- `cleanup()`: 会話サマリーを保存し `flush()` でディスクに永続化

### MCP 統合（Phase 9）

JSON-RPC 2.0 over stdio で外部 MCP サーバーと連携。

**MCPConnection**
- MCP ハンドシェイク: `initialize` → `notifications/initialized`
- `listTools()` / `callTool()` / `listResources()` / `readResource()`
- リクエスト ID によるレスポンスマッチング、30 秒タイムアウト

**MCPClientManager**
- 複数サーバー管理（`connectAll(servers)`）
- ツール名前空間: `mcp_{serverName}_{toolName}` で ToolRegistry に自動登録
- サーバー単位の障害隔離（1 サーバー失敗でも他は正常稼働）

### サブエージェント（Phase 8）

複数のエージェントを並列実行し、タスクを分割処理。

**SubAgentManager**
- `spawn(role, systemPrompt)` で単一サブエージェントを生成
- `spawnParallel(roles, prompts)` で複数エージェントを同時実行
- role ベースのツール権限制御:
  - `explorer`: 読み取り専用（read_file のみ）
  - `worker`: 全ツール使用可能
  - `reviewer`: read_file + bash のみ

**SubAgentTool（"delegate_task"）**
- ToolRegistry に登録
- 最大 6 サブタスク同時実行
- 分割・集約パターンに対応

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
    │ tools / provider /      │  ← 単体・統合: 個別コンポーネント
    │ security / daemon /     │     Phase 1-9 拡張コンポーネント
    │ Phase 1-9 components    │
    │ (218+ tests)            │
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

**Phase 10: 長期メモリ + ベクトル検索テスト**

**vector-memory.test.ts（37テスト）**
`cosineSimilarity` 数値精度、`VectorStore` の追加・Top-K 検索・メタデータフィルタ・キーワード検索・JSON 永続化・FIFO プルーニング、`TFIDFEmbeddingProvider`、`LongTermMemory` の全 4 store メソッド・ハイブリッド検索・コンテキストビルド・トークン上限制御を検証。

**Phase 1-9 拡張コンポーネントテスト**

**streaming.test.ts（8テスト）**
OllamaProvider.chatCompletionStream() のストリーミング機能、NDJSON パース、StreamChunk 型の各種パターン（content / tool_call_start / tool_call_end / done / error）、エラーハンドリングを検証。

**token-counter.test.ts（10テスト）**
ASCII 文字・CJK 文字・混合テキストのトークン数推定、メッセージオーバーヘッド、複数メッセージの累積カウント、エッジケース（空文字列・特殊文字）を検証。

**context-manager.test.ts（14テスト）**
fitMessages() でのメッセージ削減、システムメッセージ保持、優先度ベース削除、トークン正確性、複数ラウンドでの連続削減、境界値ケースを検証。

**circuit-breaker.test.ts（8テスト）**
状態遷移（closed → open → half-open → closed）、failureThreshold・resetTime の設定、open 時の即座エラー返却、half-open での試行実行、タイムアウト処理を検証。

**fallback-provider.test.ts（13テスト）**
複数プロバイダーの登録・順序、ラウンドロビン実行、一つ失敗時の次プロバイダー移行、sticky active provider の優先度、エラー伝播を検証。

**task-classifier.test.ts（21テスト）**
キーワードスコアリング（複雑・単純キーワード）、メッセージ長ボーナス、反復回数ボーナス、複雑度判定（complex / normal / simple）の各閾値、複合パターンを検証。

**model-router.test.ts（13テスト）**
light / heavy プロバイダーの設定、selectProvider() の判定ロジック、TaskClassifier との統合、プロバイダー切替、設定値の境界値を検証。

**hook-manager.test.ts（11テスト）**
register() での優先度ソート、emit() での非同期実行、abort() による中断、modifyArgs() での引数変更、複数 hook の順次実行、エラーハンドリングを検証。

**file-hook-loader.test.ts（11テスト）**
.kairos/hooks.json の読込、変数補間（${HOME} / ${PROJECT_ROOT} / ${timestamp}）、複数 event の登録、無効な JSON のエラー処理、ホットリロードを検証。

**sub-agent-manager.test.ts（20テスト）**
spawn() で単一エージェント生成、spawnParallel() で複数並列実行、role ベースツール権限（explorer / worker / reviewer）、最大 6 タスク同時実行制限、結果の集約、エラー時の回復を検証。

**checkpoint-manager.test.ts（18テスト）**
Git ベースチェックポイント作成、ロールバック（指定 ID / 直前状態）、undo、diff 生成、maxCheckpoints 自動プルーニング、無変更時のスキップ、クリーンアップ、disabled モード、統計情報を検証。

**diff-generator.test.ts（15テスト）**
unified diff 生成（追加・削除・変更）、新規ファイル diff、空→内容への diff、ANSI カラー化（赤:削除/緑:追加/シアン:ヘッダー）、マルチライン文字列の edit diff、大規模 diff、特殊文字を検証。

**approval-manager.test.ts（18テスト）**
3 承認モード（auto=常時承認 / confirm=常時確認 / selective=リスクベース）、拒否・編集フロー、read-only ツール自動承認、diff 生成連携、bash 説明文、統計情報を検証。

**mcp-connection.test.ts（11テスト）**
JSON-RPC 2.0 通信、MCP ハンドシェイク（initialize → notifications/initialized）、ツール一覧取得・実行、リソース読み取り、切断処理、30 秒タイムアウト、エラーハンドリングを検証。

**mcp-client-manager.test.ts（11テスト）**
複数 MCP サーバー管理、接続・切断、ステータス取得、ツール名前空間プレフィクス（`mcp_{server}_{tool}`）、ToolRegistry 動的登録、接続失敗時の回復を検証。

**daemon.test.ts（23テスト）**
KAIROSDaemon 初期化・起動・停止、PID ファイル管理、Tick システム、イベント発行・リスナー、通知設定（静止時間含む）、ドリーム設定、プロアクティブ条件、ヘルスチェック、AutoDream 状態・履歴を検証。

**合計: 352+ テスト pass / 0 fail**（Phase 1-9: 202件 + Phase 10 ベクトルメモリ: 37件 + コアコンポーネント: 113件+）

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

## コード品質

| チェック | 状態 |
|---|---|
| `eslint src --ext .ts,.tsx` | ✅ 0 errors, 0 warnings |
| `tsc --noEmit` | ✅ 0 errors |
| `prettier --check "src/**/*.ts"` | ✅ All files formatted |

主な型定義の改善:
- `ToolDefinition` / `ToolFunction` インターフェースの追加（`any[]` から厳密な型へ）
- `ILLMProvider.chatCompletionStream` の戻り型を `AsyncGenerator<StreamChunk>` に明示
- `ConfigManager.get()` の `unknown` 返却に対する各呼び出し元の安全なキャスト

## 今後の改善方針

Phase 1-9 + 長期メモリ（Phase 10）の実装が完了。今後の改善候補:

1. **マルチエージェントオーケストレーション** — Planner / Coder / Tester の役割ベース連携
2. **自動 Git ワークフロー** — commit / test / PR 作成の自動化
3. **ツール結果のコンテキスト最適化** — 長いツール出力の自動要約
4. **Web UI** — ブラウザベースのインターフェース
5. **MCP サーバー拡充** — コミュニティ MCP サーバーとの統合テスト
6. **承認フロー CLI/TUI 統合** — ApprovalManager のインタラクティブ UI
