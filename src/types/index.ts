// エージェントループのメッセージ型
export interface AgentMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

// ツールコールの型
export interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

// ツールの定義
export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute: (params: unknown) => Promise<ToolResult>;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
}

// ツールの実行結果
export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

// エージェントループの状態
export interface AgentState {
  phase: string;
  thought: string;
  action: string | null;
  observation: string | null;
  iteration: number;
  maxIterations: number;
}

// メモリの型
export interface Memory {
  type: "MEMORY" | "TOPIC" | "LOG";
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ユーザープロファイル
export interface UserProfile {
  name?: string;
  preferences?: Record<string, unknown>;
  collaborationStyle?: string;
  avoidActions?: string[];
  lastActive: number;
}

// ドリームモードの設定
export interface DreamConfig {
  enabled: boolean;
  intervalHours: number;
  minSessions: number;
  maxDurationMinutes: number;
}

// デーモン設定
export interface DaemonConfig {
  enabled: boolean;
  tickIntervalSeconds: number;
  autoDreamEnabled: boolean;
  notificationsEnabled: boolean;
}

// メモリ圧縮設定
export interface MemoryCompactionConfig {
  enabled: boolean;
  maxContextLines: number;
  maxMemoryTokens: number;
  autoCompactThreshold: number;
}

// トピック情報
export interface TopicInfo {
  name: string;
  content: string;
  lineCount: number;
  lastUpdated: number;
}

// メモリ検索結果
export interface MemorySearchResult {
  source: "memory" | "topic" | "log";
  content: string;
  relevance: number;
  timestamp: number;
}

// サーキットブレーカー状態
export interface CircuitBreakerState {
  isOpen: boolean;
  failureCount: number;
  lastFailureTime: number;
  nextAttemptTime: number;
}

// コンテキスト圧縮結果
export interface CompactionResult {
  originalLines: number;
  compressedLines: number;
  compressionRatio: number;
  topicsCreated: number;
  topicsMerged: number;
}

// ========================================
// Phase 2: デーモン関連の型定義
// ========================================

// Tickイベント型
export interface TickEvent {
  timestamp: number;
  tickNumber: number;
  interval: number;
}

// Tickハンドラーの型
export type TickHandler = (event: TickEvent) => Promise<void>;

// Tick優先度
export enum TickPriority {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
}

// Tickタスク
export interface TickTask {
  id: string;
  handler: TickHandler;
  priority: TickPriority;
  name: string;
  description: string;
}

// プロアクティブ判断結果
export interface ProactiveResult {
  shouldAct: boolean;
  actionType: "notification" | "consolidation" | "analysis" | "none";
  reason: string;
  suggestedAction?: string;
}

// デーモン状態
export interface DaemonState {
  isRunning: boolean;
  startTime: number;
  uptimeSeconds: number;
  tickCount: number;
  lastTickTime: number;
  pid?: number;
}

// イベントタイプ
export enum EventType {
  TICK = "tick",
  USER_INPUT = "user_input",
  MEMORY_UPDATE = "memory_update",
  TOOL_EXECUTION = "tool_execution",
  ERROR = "error",
  PROACTIVE_ACTION = "proactive_action",
  DREAM_START = "dream_start",
  DREAM_END = "dream_end",
  DAEMON_START = "daemon_start",
  DAEMON_STOP = "daemon_stop",
}

// イベント
export interface DaemonEvent {
  type: EventType;
  timestamp: number;
  data?: Record<string, unknown>;
}

// イベントリスナー
export type EventListener = (event: DaemonEvent) => void;

// プロアクティブ条件
export interface ProactiveCondition {
  type: "idle_time" | "memory_pressure" | "error_recovery" | "scheduled";
  enabled: boolean;
  threshold?: number;
  lastTriggerTime?: number;
}

// ドリーム状態
export interface DreamState {
  isRunning: boolean;
  startTime: number;
  durationSeconds: number;
  memoryConsolidated: boolean;
  contradictionsResolved: number;
  insightsExtracted: number;
}

// ドリーム設定
export interface DreamSettings {
  autoTrigger: boolean;
  idleThresholdMinutes: number;
  maxDurationMinutes: number;
  minSessionsSinceDream: number;
  consolidationIntervalHours: number;
}

// 通知設定
export interface NotificationConfig {
  enabled: boolean;
  channels: ("console" | "os" | "push")[];
  priority: "low" | "medium" | "high";
  quietHours?: {
    start: string; // HH:MM format
    end: string; // HH:MM format
  };
}

// ========================================
// スキルシステム
// ========================================

// スキルマニフェスト（skill.json）
export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  triggers: string[]; // 自動検出キーワード（"excel", "spreadsheet" 等）
  author?: string;
  category?: SkillCategory;
  tools?: string; // 追加ツール定義ファイル（相対パス）
  config?: Record<string, unknown>;
}

// スキルカテゴリ
export type SkillCategory =
  | "document" // ドキュメント生成（docx, pdf, pptx）
  | "data" // データ処理（xlsx, csv）
  | "code" // コーディング支援
  | "devops" // DevOps / CI/CD
  | "custom"; // ユーザー定義

// ロード済みスキル
export interface LoadedSkill {
  manifest: SkillManifest;
  skillMdContent: string; // SKILL.md の内容
  dirPath: string; // スキルディレクトリパス
  tools: Tool[]; // 追加ツール（オプション）
  isEnabled: boolean;
}

// スキル検索結果
export interface SkillMatch {
  skill: LoadedSkill;
  matchedTriggers: string[]; // マッチしたトリガーワード
  relevance: number; // 関連度スコア（0-1）
}

// ========================================
// Phase 1: ストリーミング
// ========================================

// ストリーミングチャンクの型
export interface StreamChunk {
  type:
    | "content"
    | "tool_call_start"
    | "tool_call_delta"
    | "tool_call_end"
    | "done"
    | "error";
  delta?: string;
  toolCallIndex?: number;
  toolCall?: Partial<ToolCall>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: string;
}

// ストリーミングコールバック
export interface StreamCallbacks {
  onToken?: (token: string) => void;
  onToolCall?: (toolCall: ToolCall) => void;
  onUsage?: (usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    durationMs?: number;
  }) => void;
  onError?: (error: string) => void;
}

// ========================================
// Phase 7: Hooks（ライフサイクルイベント）
// ========================================

export type HookEvent =
  | "session:start"
  | "session:end"
  | "tool:before"
  | "tool:after"
  | "tool:error"
  | "iteration:start"
  | "iteration:end"
  | "response:complete"
  | "mcp:connected"
  | "mcp:disconnected"
  | "mcp:tool_called"
  | "mcp:error";

export interface HookContext {
  event: HookEvent;
  timestamp: number;
  sessionId: string;
  iteration?: number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: { success: boolean; output: string; error?: string };
  error?: Error;
  abort?: () => void;
  modifyArgs?: (args: Record<string, unknown>) => void;
}

export interface HookDefinition {
  name: string;
  event: HookEvent | HookEvent[];
  handler: (context: HookContext) => Promise<void> | void;
  priority?: number;
  enabled?: boolean;
}

// ========================================
// Phase 8: サブエージェント
// ========================================

export type SubAgentRole =
  | "explorer"
  | "worker"
  | "reviewer"
  | "planner"
  | "coder"
  | "tester";

export interface SubAgentConfig {
  id?: string;
  role: SubAgentRole;
  task: string;
  model?: string;
  maxIterations?: number;
  timeout?: number;
}

export interface SubAgentResult {
  id: string;
  role: SubAgentRole;
  task: string;
  status: "completed" | "failed" | "timeout";
  output: string;
  filesModified: string[];
  toolsUsed: string[];
  iterations: number;
  durationMs: number;
  error?: string;
}

// ========================================
// Phase 5: チェックポイント＆ロールバック
// ========================================

export interface Checkpoint {
  id: string;
  iteration: number;
  timestamp: number;
  description: string;
  commitHash?: string;
  filesChanged: string[];
}

export interface CheckpointManagerConfig {
  enabled: boolean;
  strategy: "stash" | "branch";
  maxCheckpoints: number;
  autoCheckpoint: boolean;
}

// ========================================
// Phase 6: Diff プレビュー＆承認フロー
// ========================================

export type ApprovalMode = "auto" | "confirm" | "selective";
export type ApprovalResult = "approved" | "rejected" | "edited";

export interface ApprovalConfig {
  mode: ApprovalMode;
  showDiff: boolean;
  autoApproveReadOnly: boolean;
  timeoutSeconds: number;
}

export interface ApprovalRequest {
  toolName: string;
  args: Record<string, unknown>;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  diff?: string;
  description: string;
}

// ========================================
// Phase 9: MCP (Model Context Protocol)
// ========================================

export type MCPTransport = "stdio" | "sse";

export interface MCPServerConfig {
  name: string;
  transport: MCPTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface MCPResource {
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
}

// ========================================
// 長期メモリ + ベクトル検索（Memory強化）
// ========================================

/** メモリエントリのタイプ */
export type MemoryEntryType =
  | "task" // タスクの実行・結果
  | "error" // エラー・解決パターン
  | "code" // コードスニペット・変更
  | "conversation" // 会話の要約
  | "fact"; // プロジェクトに関する事実

/** ベクトルストアのエントリ */
export interface VectorMemoryEntry {
  id: string;
  content: string;
  embedding: number[];
  metadata: {
    type: MemoryEntryType;
    timestamp: number;
    sessionId?: string;
    tags?: string[];
    importance?: number;
    source?: string;
  };
}

/** ベクトル検索結果 */
export interface VectorSearchResult {
  entry: VectorMemoryEntry;
  similarity: number; // コサイン類似度 (0-1)
}

/** Embedding プロバイダーの設定 */
export interface EmbeddingConfig {
  type: "ollama" | "openai" | "tfidf";
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
}

/** 長期メモリの設定 */
export interface LongTermMemoryConfig {
  basePath: string;
  maxEntries?: number;
  minSimilarity?: number;
  defaultTopK?: number;
  autoSaveIntervalMs?: number;
  ollamaBaseUrl?: string;
  openAIApiKey?: string;
}

/** AgentLoop に注入するメモリコンテキスト */
export interface MemoryContext {
  contextText: string;
  entries: VectorSearchResult[];
  embeddingProvider: string;
}

// ========================================
// パイプラインオーケストレーション
// ========================================

/**
 * パイプラインの各ステージを担当するエージェントの役割
 * Planner → Coder → Tester → Reviewer の順序で実行される
 */
export type PipelineRole = "planner" | "coder" | "tester" | "reviewer";

/**
 * パイプラインの各ステージの実行結果
 */
export interface PipelineStageResult {
  stage: PipelineRole;
  status: "success" | "failed" | "skipped" | "timeout";
  output: string;
  durationMs: number;
  iteration: number; // 何回目の試行か（Coder/Testerはリトライがある）
  error?: string;
}

/**
 * パイプライン全体を通じて蓄積されるアーティファクト
 */
export interface PipelineArtifacts {
  plan?: string; // Plannerが生成した実装計画
  code?: string; // Coderが生成・修正したコード
  testResults?: string; // Testerが実行したテスト結果
  review?: string; // Reviewerが提供したレビュー
}

/**
 * パイプラインの実行設定
 */
export interface PipelineConfig {
  /** テスト失敗時に Coder → Tester をリトライする最大回数（デフォルト: 3）*/
  maxRetries?: number;
  /** 各ステージのタイムアウト（ミリ秒、デフォルト: 120000）*/
  stageTimeout?: number;
  /** スキップするステージ */
  skipStages?: PipelineRole[];
  /** ステージ完了時のコールバック */
  onStageComplete?: (
    result: PipelineStageResult,
    artifacts: PipelineArtifacts,
  ) => void;
  /** ステージ開始時のコールバック */
  onStageStart?: (stage: PipelineRole, iteration: number) => void;
}

/**
 * パイプライン全体の実行結果
 */
export interface PipelineResult {
  taskDescription: string;
  status: "success" | "failed";
  stages: PipelineStageResult[];
  artifacts: PipelineArtifacts;
  totalDurationMs: number;
  coderIterations: number; // Coderが何回実行されたか
  error?: string;
}
