import OpenAI from "openai";
import {
  ILLMProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  GenerateResponseOptions,
  defaultGenerateResponse,
} from "./LLMProvider.js";

/**
 * Z.AI (GLM) Coding Plan 用の設定
 */
export interface ZAIProviderConfig {
  type: "zai";
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** true の場合 Coding 専用エンドポイントを使用 */
  useCodingEndpoint?: boolean;
}

/**
 * Z.AI のデフォルトエンドポイント
 */
const ZAI_GENERAL_BASE_URL = "https://api.z.ai/api/paas/v4";
const ZAI_CODING_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

/**
 * Z.AI (GLM) Coding Plan プロバイダー
 *
 * OpenAI 互換 API を提供する Z.AI の GLM モデルに接続します。
 * Coding 専用エンドポイントと汎用エンドポイントの切り替えに対応。
 *
 * 対応モデル:
 *   - glm-5.1       (最新フラグシップ、エージェント向け)
 *   - glm-5         (高性能)
 *   - glm-5-turbo   (高速)
 *   - glm-4.7       (バランス型)
 *   - glm-4.7-flashx(高速軽量)
 *   - glm-4.5       / glm-4.5-flash / glm-4.5-air
 */
export class ZAIProvider implements ILLMProvider {
  private client: OpenAI;
  private config: Required<
    Pick<ZAIProviderConfig, "type" | "model" | "temperature" | "maxTokens">
  > &
    ZAIProviderConfig;

  constructor(config: ZAIProviderConfig) {
    const apiKey =
      config.apiKey ||
      process.env.ZAI_API_KEY ||
      process.env.ZHIPUAI_API_KEY;

    if (!apiKey) {
      throw new Error(
        "API key is required for Z.AI provider. Set ZAI_API_KEY or ZHIPUAI_API_KEY environment variable.",
      );
    }

    const useCoding =
      config.useCodingEndpoint !== undefined
        ? config.useCodingEndpoint
        : true; // デフォルトで Coding エンドポイントを使用

    const baseUrl =
      config.baseUrl ||
      (useCoding ? ZAI_CODING_BASE_URL : ZAI_GENERAL_BASE_URL);

    this.config = {
      type: "zai",
      apiKey,
      baseUrl,
      model: config.model || process.env.ZAI_MODEL || "glm-5.1",
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 4096,
      useCodingEndpoint: useCoding,
    };

    this.client = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl,
    });
  }

  async chatCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const response = await this.client.chat.completions.create({
      model: request.model || this.config.model,
      messages: request.messages as any,
      temperature: request.temperature ?? this.config.temperature,
      max_tokens: request.max_tokens ?? this.config.maxTokens,
      tools: request.tools,
      stream: false,
    });

    return {
      id: response.id,
      object: response.object,
      created: response.created,
      model: response.model,
      choices: response.choices.map((choice) => ({
        index: choice.index,
        message: {
          role: choice.message.role,
          content: choice.message.content,
          tool_calls: choice.message.tool_calls?.map((tc) => ({
            id: tc.id,
            type: tc.type,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        },
        finish_reason: choice.finish_reason,
      })),
      usage: response.usage
        ? {
            prompt_tokens: response.usage.prompt_tokens,
            completion_tokens: response.usage.completion_tokens,
            total_tokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }

  async generateResponse(
    prompt: string,
    options?: GenerateResponseOptions,
  ): Promise<string> {
    return defaultGenerateResponse(this, prompt, options);
  }

  getType(): "zai" {
    return "zai";
  }

  getDefaultModel(): string {
    return this.config.model;
  }

  /**
   * 使用中のエンドポイントタイプを返す
   */
  getEndpointType(): "coding" | "general" {
    return this.config.useCodingEndpoint ? "coding" : "general";
  }

  /**
   * 利用可能なモデル一覧を返す
   */
  static getAvailableModels(): { id: string; description: string }[] {
    return [
      { id: "glm-5.1", description: "最新フラグシップ（エージェント向け）" },
      { id: "glm-5", description: "高性能モデル" },
      { id: "glm-5-turbo", description: "高速モデル" },
      { id: "glm-4.7", description: "バランス型" },
      { id: "glm-4.7-flashx", description: "高速軽量" },
      { id: "glm-4.5", description: "安定版" },
      { id: "glm-4.5-flash", description: "高速安定版" },
    ];
  }

  async initialize(): Promise<void> {
    await this.testConnection();
  }

  async cleanup(): Promise<void> {
    // クライアントのクリーンアップ
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.client.chat.completions.create({
        model: this.config.model,
        messages: [{ role: "user", content: "test" }],
        max_tokens: 1,
      });
      return true;
    } catch (error) {
      console.error("Z.AI connection test failed:", error);
      return false;
    }
  }
}
