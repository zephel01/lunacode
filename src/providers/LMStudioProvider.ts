import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import {
  ILLMProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  OpenAICompatibleConfig,
  GenerateResponseOptions,
  defaultGenerateResponse,
} from "./LLMProvider.js";

export class LMStudioProvider implements ILLMProvider {
  private client: OpenAI;
  private config: OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    this.config = {
      type: "lmstudio",
      baseUrl: config.baseUrl || "http://localhost:1234/v1",
      model: config.model || "local-model",
      apiKey: "not-needed", // LM StudioはAPIキーを必要としない
      temperature: config.temperature || 0.7,
      maxTokens: config.maxTokens || 1000,
    };

    this.client = new OpenAI({
      apiKey: "not-needed", // LM StudioはAPIキーを必要としない
      baseURL: this.config.baseUrl,
    });
  }

  async chatCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const response = await this.client.chat.completions.create({
      model: request.model || this.config.model || "local-model",
      messages: request.messages as unknown as ChatCompletionMessageParam[],
      temperature: request.temperature || this.config.temperature || 0.7,
      max_tokens: request.max_tokens || this.config.maxTokens || 1000,
      tools: request.tools as unknown as ChatCompletionTool[] | undefined,
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

  getType(): "lmstudio" {
    return "lmstudio";
  }

  getDefaultModel(): string {
    return this.config.model || "local-model";
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
        model: this.config.model || "local-model",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 1,
      });
      return true;
    } catch (error) {
      console.error("LM Studio connection test failed:", error);
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.config.baseUrl}/models`);
      const data = (await response.json()) as { data: Array<{ id: string }> };
      return data.data.map((model) => model.id);
    } catch (error) {
      console.error("Failed to list LM Studio models:", error);
      return [];
    }
  }
}
