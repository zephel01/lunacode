import OpenAI from "openai";
import {
  ILLMProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  OpenAICompatibleConfig,
  GenerateResponseOptions,
  defaultGenerateResponse,
} from "./LLMProvider.js";

export class OpenAIProvider implements ILLMProvider {
  private client: OpenAI;
  private config: OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    this.config = {
      type: "openai",
      baseUrl: config.baseUrl || "https://api.openai.com/v1",
      model: config.model || "gpt-4o-mini",
      apiKey:
        config.apiKey ||
        process.env.OPENAI_API_KEY ||
        process.env.LUNACODE_API_KEY,
      temperature: config.temperature || 0.7,
      maxTokens: config.maxTokens || 1000,
    };

    if (!this.config.apiKey) {
      throw new Error("API key is required for OpenAI provider");
    }

    this.client = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl,
    });
  }

  async chatCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const response = await this.client.chat.completions.create({
      model: request.model || this.config.model || "gpt-4o-mini",
      messages: request.messages as any,
      temperature: request.temperature || this.config.temperature || 0.7,
      max_tokens: request.max_tokens || this.config.maxTokens || 1000,
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

  getType(): "openai" {
    return "openai";
  }

  getDefaultModel(): string {
    return this.config.model || "gpt-4o-mini";
  }

  async initialize(): Promise<void> {
    // 接続テスト
    await this.testConnection();
  }

  async cleanup(): Promise<void> {
    // クライアントのクリーンアップ
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.client.chat.completions.create({
        model: this.config.model || "gpt-4o-mini",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 1,
      });
      return true;
    } catch (error) {
      console.error("OpenAI connection test failed:", error);
      return false;
    }
  }
}
