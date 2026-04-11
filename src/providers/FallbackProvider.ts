import {
  ILLMProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  LLMProviderType,
  GenerateResponseOptions,
  defaultGenerateResponse,
} from "./LLMProvider.js";
import { StreamChunk } from "../types/index.js";
import { CircuitBreaker, CircuitBreakerOptions } from "./CircuitBreaker.js";

export class FallbackProvider implements ILLMProvider {
  private providers: ILLMProvider[];
  private breakers: Map<number, CircuitBreaker>;
  private activeIndex: number = 0;

  constructor(providers: ILLMProvider[], breakerOptions?: CircuitBreakerOptions) {
    if (providers.length === 0) {
      throw new Error("FallbackProvider requires at least one provider");
    }
    this.providers = providers;
    this.breakers = new Map();
    providers.forEach((_, i) => {
      this.breakers.set(i, new CircuitBreaker(breakerOptions));
    });
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const errors: Error[] = [];

    for (let i = 0; i < this.providers.length; i++) {
      const index = (this.activeIndex + i) % this.providers.length;
      const breaker = this.breakers.get(index)!;

      if (breaker.isOpen()) {
        continue;
      }

      try {
        const result = await this.providers[index].chatCompletion(request);
        breaker.recordSuccess();
        this.activeIndex = index;
        return result;
      } catch (error) {
        breaker.recordFailure();
        const providerType = this.providers[index].getType();
        console.warn(`⚠️ ${providerType} failed: ${error instanceof Error ? error.message : error}`);
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    throw new AggregateError(errors, "All providers failed");
  }

  async *chatCompletionStream(request: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
    for (let i = 0; i < this.providers.length; i++) {
      const index = (this.activeIndex + i) % this.providers.length;
      const breaker = this.breakers.get(index)!;

      if (breaker.isOpen()) continue;

      const provider = this.providers[index];

      try {
        if (provider.supportsStreaming?.() && provider.chatCompletionStream) {
          const stream = provider.chatCompletionStream(request);
          for await (const chunk of stream) {
            yield chunk;
          }
          breaker.recordSuccess();
          this.activeIndex = index;
          return;
        } else {
          // Fallback: wrap non-streaming response as stream chunks
          const result = await provider.chatCompletion(request);
          breaker.recordSuccess();
          this.activeIndex = index;

          const content = result.choices[0]?.message?.content;
          if (content) {
            yield { type: "content", delta: content };
          }
          if (result.choices[0]?.message?.tool_calls) {
            for (const tc of result.choices[0].message.tool_calls) {
              yield { type: "tool_call_start", toolCallIndex: 0, toolCall: tc };
              yield { type: "tool_call_end", toolCallIndex: 0 };
            }
          }
          yield { type: "done", usage: result.usage };
          return;
        }
      } catch (error) {
        breaker.recordFailure();
        console.warn(`⚠️ ${provider.getType()} stream failed: ${error instanceof Error ? error.message : error}`);
      }
    }

    yield { type: "error", error: "All providers failed" };
  }

  supportsStreaming(): boolean {
    return this.providers[this.activeIndex]?.supportsStreaming?.() ?? false;
  }

  async generateResponse(prompt: string, options?: GenerateResponseOptions): Promise<string> {
    return defaultGenerateResponse(this, prompt, options);
  }

  getType(): LLMProviderType {
    return this.providers[this.activeIndex]?.getType() ?? "ollama";
  }

  getDefaultModel(): string {
    return this.providers[this.activeIndex]?.getDefaultModel() ?? "unknown";
  }

  async initialize(): Promise<void> {
    // Initialize only the first provider to avoid unnecessary connections
    await this.providers[0].initialize();
  }

  async cleanup(): Promise<void> {
    for (const provider of this.providers) {
      await provider.cleanup();
    }
  }

  async testConnection(): Promise<boolean> {
    for (const provider of this.providers) {
      try {
        if (await provider.testConnection()) return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  // Get the currently active provider
  getActiveProvider(): ILLMProvider {
    return this.providers[this.activeIndex];
  }

  getActiveIndex(): number {
    return this.activeIndex;
  }
}
