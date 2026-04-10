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
  triggers: string[];          // 自動検出キーワード（"excel", "spreadsheet" 等）
  author?: string;
  category?: SkillCategory;
  tools?: string;              // 追加ツール定義ファイル（相対パス）
  config?: Record<string, unknown>;
}

// スキルカテゴリ
export type SkillCategory =
  | "document"     // ドキュメント生成（docx, pdf, pptx）
  | "data"         // データ処理（xlsx, csv）
  | "code"         // コーディング支援
  | "devops"       // DevOps / CI/CD
  | "custom";      // ユーザー定義

// ロード済みスキル
export interface LoadedSkill {
  manifest: SkillManifest;
  skillMdContent: string;      // SKILL.md の内容
  dirPath: string;             // スキルディレクトリパス
  tools: Tool[];               // 追加ツール（オプション）
  isEnabled: boolean;
}

// スキル検索結果
export interface SkillMatch {
  skill: LoadedSkill;
  matchedTriggers: string[];   // マッチしたトリガーワード
  relevance: number;           // 関連度スコア（0-1）
}
