import { describe, test, expect, beforeEach } from "bun:test";
import { FallbackProvider } from "../src/providers/FallbackProvider.js";
import {
  ILLMProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  LLMProviderType,
  GenerateResponseOptions,
  StreamChunk,
} from "../src/providers/LLMProvider.js";

// Mock provider helper
function createMockProvider(
  type: string,
  shouldFail: boolean = false,
): ILLMProvider {
  return {
    chatCompletion: async (req: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      if (shouldFail) throw new Error(`${type} failed`);
      return {
        id: `${type}-123`,
        object: "chat.completion",
        created: Date.now(),
        model: `${type}-model`,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `Response from ${type}` },
            finish_reason: "stop",
          },
        ],
      };
    },
    chatCompletionStream: async function* (req: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
      if (shouldFail) throw new Error(`${type} stream failed`);
      yield { type: "content", delta: `Streamed from ${type}` };
      yield { type: "done" };
    },
    supportsStreaming: () => true,
    generateResponse: async (prompt: string, options?: GenerateResponseOptions): Promise<string> => {
      return `Response from ${type}`;
    },
    getType: () => type as LLMProviderType,
    getDefaultModel: () => `${type}-model`,
    initialize: async () => {},
    cleanup: async () => {},
    testConnection: async () => !shouldFail,
  };
}

describe("FallbackProvider", () => {
  let provider1: ILLMProvider;
  let provider2: ILLMProvider;
  let provider3: ILLMProvider;

  beforeEach(() => {
    provider1 = createMockProvider("provider1");
    provider2 = createMockProvider("provider2");
    provider3 = createMockProvider("provider3");
  });

  test("constructor throws with empty provider array", () => {
    expect(() => {
      new FallbackProvider([]);
    }).toThrow("FallbackProvider requires at least one provider");
  });

  test("uses first provider when available", async () => {
    const fallback = new FallbackProvider([provider1, provider2]);
    const request: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "user", content: "test" }],
    };

    const response = await fallback.chatCompletion(request);
    expect(response.choices[0].message.content).toBe("Response from provider1");
  });

  test("falls back to second provider when first fails", async () => {
    const failingProvider = createMockProvider("failing", true);
    const fallback = new FallbackProvider([failingProvider, provider2]);
    const request: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "user", content: "test" }],
    };

    const response = await fallback.chatCompletion(request);
    expect(response.choices[0].message.content).toBe("Response from provider2");
  });

  test("falls back to third when first two fail", async () => {
    const failingProvider1 = createMockProvider("failing1", true);
    const failingProvider2 = createMockProvider("failing2", true);
    const fallback = new FallbackProvider([failingProvider1, failingProvider2, provider3]);
    const request: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "user", content: "test" }],
    };

    const response = await fallback.chatCompletion(request);
    expect(response.choices[0].message.content).toBe("Response from provider3");
  });

  test("throws AggregateError when all providers fail", async () => {
    const failingProvider1 = createMockProvider("failing1", true);
    const failingProvider2 = createMockProvider("failing2", true);
    const failingProvider3 = createMockProvider("failing3", true);
    const fallback = new FallbackProvider([failingProvider1, failingProvider2, failingProvider3]);
    const request: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "user", content: "test" }],
    };

    try {
      await fallback.chatCompletion(request);
      expect.unreachable("Should have thrown AggregateError");
    } catch (error) {
      if (error instanceof AggregateError) {
        expect(error.message).toContain("All providers failed");
        expect(error.errors.length).toBe(3);
      } else {
        expect.unreachable("Should be AggregateError");
      }
    }
  });

  test("circuit breaker opens after threshold failures", async () => {
    const failingProvider = createMockProvider("failing", true);
    const fallback = new FallbackProvider([failingProvider, provider2], {
      failureThreshold: 2,
    });
    const request: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "user", content: "test" }],
    };

    // First failure
    try {
      await fallback.chatCompletion(request);
    } catch (error) {
      // Expected
    }

    // Second failure - circuit breaker should open
    try {
      await fallback.chatCompletion(request);
    } catch (error) {
      // Expected
    }

    // Third attempt should use provider2 directly since provider1 is open
    const response = await fallback.chatCompletion(request);
    expect(response.choices[0].message.content).toBe("Response from provider2");
  });

  test("remembers active provider on success", async () => {
    const fallback = new FallbackProvider([provider1, provider2]);
    const request: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "user", content: "test" }],
    };

    // First call uses provider1
    let response = await fallback.chatCompletion(request);
    expect(response.choices[0].message.content).toBe("Response from provider1");
    expect(fallback.getActiveIndex()).toBe(0);

    // Second call should still use provider1
    response = await fallback.chatCompletion(request);
    expect(response.choices[0].message.content).toBe("Response from provider1");
    expect(fallback.getActiveIndex()).toBe(0);
  });

  test("testConnection returns true if any provider works", async () => {
    const failingProvider = createMockProvider("failing", true);
    const fallback = new FallbackProvider([failingProvider, provider2]);

    const result = await fallback.testConnection();
    expect(result).toBe(true);
  });

  test("testConnection returns false if all providers fail", async () => {
    const failingProvider1 = createMockProvider("failing1", true);
    const failingProvider2 = createMockProvider("failing2", true);
    const fallback = new FallbackProvider([failingProvider1, failingProvider2]);

    const result = await fallback.testConnection();
    expect(result).toBe(false);
  });

  test("getType returns active provider's type", async () => {
    const fallback = new FallbackProvider([provider1, provider2]);
    expect(fallback.getType()).toBe("provider1");
  });

  test("getDefaultModel returns active provider's default model", async () => {
    const fallback = new FallbackProvider([provider1, provider2]);
    expect(fallback.getDefaultModel()).toBe("provider1-model");
  });

  test("getActiveProvider returns current active provider", async () => {
    const fallback = new FallbackProvider([provider1, provider2]);
    expect(fallback.getActiveProvider()).toBe(provider1);
  });

  test("streaming falls back to second provider when first fails", async () => {
    const failingProvider = createMockProvider("failing", true);
    const fallback = new FallbackProvider([failingProvider, provider2]);
    const request: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "user", content: "test" }],
    };

    const chunks: StreamChunk[] = [];
    for await (const chunk of fallback.chatCompletionStream(request)) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    const contentChunk = chunks.find((c) => c.type === "content");
    expect(contentChunk?.delta).toBe("Streamed from provider2");
  });
});
