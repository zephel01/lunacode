// LLMプロバイダーのタイプ
export type LLMProviderType =
  | "openai"
  | "ollama"
  | "lmstudio"
  | "litellm"
  | "zai";

// チャットメッセージ
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

// ツールコール
export interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

// チャットコンプリションのリクエスト
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  tools?: any[];
  stream?: boolean;
}

// チャットコンプリションのレスポンス
export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// LLMプロバイダー設定
export interface LLMProviderConfig {
  type: LLMProviderType;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  useCodingEndpoint?: boolean; // Z.AI専用: coding endpoint使用フラグ
}

// OpenAI互換プロバイダー設定
export interface OpenAICompatibleConfig extends LLMProviderConfig {
  type: "openai" | "lmstudio" | "litellm" | "zai";
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

// Ollama設定
export interface OllamaConfig extends LLMProviderConfig {
  type: "ollama";
  baseUrl?: string;
  model?: string;
  /** リクエストタイムアウト（ミリ秒）。大型モデルは長めに設定推奨。デフォルト: 300000 (5分) */
  requestTimeout?: number;
}

// generateResponseのオプション
export interface GenerateResponseOptions {
  temperature?: number;
  maxTokens?: number;
}

// LLMプロバイダー抽象インターフェース
export interface ILLMProvider {
  // チャットコンプリションを実行
  chatCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse>;

  // シンプルなテキスト生成（chatCompletionのラッパー）
  generateResponse(
    prompt: string,
    options?: GenerateResponseOptions,
  ): Promise<string>;

  // プロバイダータイプを取得
  getType(): LLMProviderType;

  // デフォルトモデルを取得
  getDefaultModel(): string;

  // プロバイダーを初期化
  initialize(): Promise<void>;

  // プロバイダーをクリーンアップ
  cleanup(): Promise<void>;

  // 接続をテスト
  testConnection(): Promise<boolean>;

  // ストリーミング対応チャットコンプリション
  chatCompletionStream?(request: ChatCompletionRequest): AsyncGenerator<any>;

  // ストリーミング対応かを判定
  supportsStreaming?(): boolean;
}

/**
 * generateResponseのデフォルト実装を提供するヘルパー
 * 各プロバイダーで再利用可能
 */
export async function defaultGenerateResponse(
  provider: ILLMProvider,
  prompt: string,
  options?: GenerateResponseOptions,
): Promise<string> {
  const request: ChatCompletionRequest = {
    model: provider.getDefaultModel(),
    messages: [{ role: "user", content: prompt }],
    temperature: options?.temperature,
    max_tokens: options?.maxTokens,
  };

  const response = await provider.chatCompletion(request);
  return response.choices[0]?.message?.content || "";
}
