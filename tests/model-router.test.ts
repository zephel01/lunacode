import { describe, test, expect } from "bun:test";
import { ModelRouter } from "../src/agents/ModelRouter.js";
import type { RoutingConfig } from "../src/types/index.js";
import {
  ILLMProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  LLMProviderType,
  GenerateResponseOptions,
} from "../src/providers/LLMProvider.js";

function createMockProvider(
  model: string,
  type: LLMProviderType = "ollama",
): ILLMProvider {
  return {
    chatCompletion: async (
      req: ChatCompletionRequest,
    ): Promise<ChatCompletionResponse> => ({
      id: "1",
      object: "chat.completion",
      created: 0,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
    }),
    generateResponse: async (
      prompt: string,
      options?: GenerateResponseOptions,
    ): Promise<string> => "ok",
    getType: () => type,
    getDefaultModel: () => model,
    initialize: async () => {},
    cleanup: async () => {},
    testConnection: async () => true,
  };
}

describe("ModelRouter", () => {
  const lightProvider = createMockProvider("phi");
  const heavyProvider = createMockProvider("mistral");
  const router = new ModelRouter(lightProvider, heavyProvider);

  describe("selectProvider", () => {
    test("should route simple query to light provider", () => {
      const { provider, classification } =
        router.selectProvider("what is this?");
      expect(provider.getDefaultModel()).toBe("phi");
      expect(classification.complexity).toBe("simple");
      expect(classification.suggestedModel).toBe("light");
    });

    test("should route complex query to heavy provider", () => {
      const { provider, classification } = router.selectProvider(
        "refactor this code to improve maintainability and optimize performance across multiple files",
      );
      expect(provider.getDefaultModel()).toBe("mistral");
      expect(classification.complexity).toBe("complex");
      expect(classification.suggestedModel).toBe("heavy");
    });

    test("should route moderate query to heavy provider for safety", () => {
      const { provider, classification } =
        router.selectProvider("create a new file");
      expect(provider.getDefaultModel()).toBe("mistral");
      expect(classification.complexity).toBe("moderate");
      expect(classification.suggestedModel).toBe("heavy");
    });

    test("should return classification details", () => {
      const { classification } = router.selectProvider("explain this function");
      expect(classification).toHaveProperty("complexity");
      expect(classification).toHaveProperty("reason");
      expect(classification).toHaveProperty("suggestedModel");
    });

    test("should include iteration context in routing decision", () => {
      const { provider: provider1 } = router.selectProvider("continue", {
        iteration: 1,
      });
      const { provider: provider2 } = router.selectProvider("continue", {
        iteration: 5,
      });

      // Deep iteration should lean toward heavy provider
      expect(provider2.getDefaultModel()).toBe("mistral");
    });
  });

  describe("Provider getters", () => {
    test("getLightProvider should return light provider instance", () => {
      const light = router.getLightProvider();
      expect(light.getDefaultModel()).toBe("phi");
      expect(light).toBe(lightProvider);
    });

    test("getHeavyProvider should return heavy provider instance", () => {
      const heavy = router.getHeavyProvider();
      expect(heavy.getDefaultModel()).toBe("mistral");
      expect(heavy).toBe(heavyProvider);
    });
  });

  describe("Classifier access", () => {
    test("getClassifier should return TaskClassifier instance", () => {
      const classifier = router.getClassifier();
      expect(classifier).toBeDefined();

      // Verify classifier works
      const result = classifier.classify("test");
      expect(result).toHaveProperty("complexity");
      expect(result).toHaveProperty("suggestedModel");
    });
  });

  describe("Edge cases", () => {
    test("should handle empty input string", () => {
      const { provider, classification } = router.selectProvider("");
      expect(provider).toBeDefined();
      expect(classification.complexity).toBeDefined();
    });

    test("should handle very long input", () => {
      const longInput = "a ".repeat(500);
      const { provider, classification } = router.selectProvider(longInput);
      expect(provider).toBeDefined();
      expect(classification.suggestedModel).toBe("heavy");
    });

    test("should handle context with multiple properties", () => {
      const { classification } = router.selectProvider("test", {
        iteration: 3,
        toolResultCount: 5,
      });
      expect(classification.complexity).toBeDefined();
    });
  });

  describe("Integration", () => {
    test("should create consistent routing across multiple calls", () => {
      const input = "refactor this code";
      const result1 = router.selectProvider(input);
      const result2 = router.selectProvider(input);

      expect(result1.classification.complexity).toBe(
        result2.classification.complexity,
      );
      expect(result1.provider.getDefaultModel()).toBe(
        result2.provider.getDefaultModel(),
      );
    });

    test("should differentiate routing for different complexities", () => {
      const simple = router.selectProvider("help");
      const complex = router.selectProvider("refactor everything");

      expect(simple.provider.getDefaultModel()).not.toBe(
        complex.provider.getDefaultModel(),
      );
      expect(simple.classification.complexity).not.toBe(
        complex.classification.complexity,
      );
    });
  });
});

// ── Phase 15: 高度ルーティング ─────────────────────────────────────────────────

describe("ModelRouter (Phase 15: Advanced Routing)", () => {
  const lightProvider = createMockProvider("phi", "ollama");
  const heavyProvider = createMockProvider("mistral", "ollama");

  // プロバイダープール
  const ollamaProvider = createMockProvider("llama3.1", "ollama");
  const openaiProvider = createMockProvider("gpt-4o-mini", "openai");
  const lmstudioProvider = createMockProvider("local-model", "lmstudio");

  function makeAdvancedRouter(config?: Partial<RoutingConfig>): ModelRouter {
    const router = new ModelRouter(lightProvider, heavyProvider);
    const pool = new Map<string, ILLMProvider>([
      ["ollama", ollamaProvider],
      ["openai", openaiProvider],
      ["lmstudio", lmstudioProvider],
    ]);
    const routingConfig: RoutingConfig = {
      enabled: true,
      rules: [
        {
          taskType: "code_generation",
          provider: "ollama",
          model: "qwen2.5:14b",
        },
        { taskType: "debugging", provider: "openai", model: "gpt-4o-mini" },
        { taskType: "code_review", provider: "openai", model: "gpt-4o-mini" },
        { taskType: "summarization", provider: "ollama", model: "llama3.1" },
      ],
      defaultProvider: "ollama",
      fallbackChain: ["ollama", "openai", "lmstudio"],
      ...config,
    };
    router.enableAdvancedRouting(routingConfig, pool);
    return router;
  }

  describe("enableAdvancedRouting", () => {
    test("should enable advanced routing", () => {
      const router = makeAdvancedRouter();
      expect(router.isAdvancedRoutingEnabled()).toBe(true);
    });

    test("should not be enabled without calling enableAdvancedRouting", () => {
      const router = new ModelRouter(lightProvider, heavyProvider);
      expect(router.isAdvancedRoutingEnabled()).toBe(false);
    });

    test("should not be enabled if config.enabled is false", () => {
      const router = new ModelRouter(lightProvider, heavyProvider);
      const pool = new Map<string, ILLMProvider>([["ollama", ollamaProvider]]);
      router.enableAdvancedRouting(
        { enabled: false, rules: [], fallbackChain: [] },
        pool,
      );
      expect(router.isAdvancedRoutingEnabled()).toBe(false);
    });

    test("should not be enabled if provider pool is empty", () => {
      const router = new ModelRouter(lightProvider, heavyProvider);
      router.enableAdvancedRouting(
        { enabled: true, rules: [], fallbackChain: [] },
        new Map(),
      );
      expect(router.isAdvancedRoutingEnabled()).toBe(false);
    });
  });

  describe("selectProvider with rules", () => {
    test("should route debugging to openai by rule", () => {
      const router = makeAdvancedRouter();
      const result = router.selectProvider("debug this error");
      expect(result.provider.getType()).toBe("openai");
      expect(result.routedByRule).toBe(true);
      expect(result.matchedRule?.taskType).toBe("debugging");
    });

    test("should route code_generation to ollama by rule", () => {
      const router = makeAdvancedRouter();
      const result = router.selectProvider("implement a new feature");
      expect(result.provider.getType()).toBe("ollama");
      expect(result.routedByRule).toBe(true);
      expect(result.matchedRule?.taskType).toBe("code_generation");
    });

    test("should route code_review to openai by rule", () => {
      const router = makeAdvancedRouter();
      const result = router.selectProvider("review this code");
      expect(result.provider.getType()).toBe("openai");
      expect(result.routedByRule).toBe(true);
    });

    test("should route summarization to ollama by rule", () => {
      const router = makeAdvancedRouter();
      const result = router.selectProvider("summarize this file");
      expect(result.provider.getType()).toBe("ollama");
      expect(result.routedByRule).toBe(true);
    });

    test("should use defaultProvider for unmapped task types", () => {
      const router = makeAdvancedRouter();
      // "general" has no explicit rule → falls back to defaultProvider (ollama)
      const result = router.selectProvider("hello");
      expect(result.provider.getType()).toBe("ollama");
      expect(result.routedByRule).toBe(true);
    });

    test("should fall back to Phase 4 light/heavy if no defaultProvider", () => {
      const router = new ModelRouter(lightProvider, heavyProvider);
      const pool = new Map<string, ILLMProvider>([["openai", openaiProvider]]);
      router.enableAdvancedRouting(
        {
          enabled: true,
          rules: [{ taskType: "debugging", provider: "openai" }],
          // no defaultProvider
        },
        pool,
      );
      // "hello" → general → no rule match, no defaultProvider → Phase 4
      const result = router.selectProvider("hello");
      expect(result.routedByRule).toBe(false);
      // Should use light or heavy based on classification
    });

    test("should include classification in result", () => {
      const router = makeAdvancedRouter();
      const result = router.selectProvider("fix the bug");
      expect(result.classification).toBeDefined();
      expect(result.classification.taskType).toBe("debugging");
    });
  });

  describe("getNextFallback", () => {
    test("should return next provider in fallback chain", () => {
      const router = makeAdvancedRouter();
      const next = router.getNextFallback("ollama");
      expect(next).toBeDefined();
      expect(next!.getType()).toBe("openai");
    });

    test("should return lmstudio after openai in chain", () => {
      const router = makeAdvancedRouter();
      const next = router.getNextFallback("openai");
      expect(next).toBeDefined();
      expect(next!.getType()).toBe("lmstudio");
    });

    test("should return undefined at end of chain", () => {
      const router = makeAdvancedRouter();
      const next = router.getNextFallback("lmstudio");
      expect(next).toBeUndefined();
    });

    test("should return undefined with empty fallback chain", () => {
      const router = makeAdvancedRouter({ fallbackChain: [] });
      const next = router.getNextFallback("ollama");
      expect(next).toBeUndefined();
    });

    test("should skip unknown providers in chain and find next valid one", () => {
      const router = new ModelRouter(lightProvider, heavyProvider);
      const pool = new Map<string, ILLMProvider>([
        ["ollama", ollamaProvider],
        ["openai", openaiProvider],
      ]);
      router.enableAdvancedRouting(
        {
          enabled: true,
          rules: [],
          fallbackChain: ["ollama", "nonexistent", "openai"],
        },
        pool,
      );
      const next = router.getNextFallback("ollama");
      expect(next).toBeDefined();
      expect(next!.getType()).toBe("openai");
    });

    test("should return first valid provider for unknown current provider", () => {
      const router = makeAdvancedRouter();
      const next = router.getNextFallback("nonexistent");
      expect(next).toBeDefined();
      expect(next!.getType()).toBe("ollama");
    });
  });

  describe("getProviderPool / getRoutingConfig", () => {
    test("should return the provider pool", () => {
      const router = makeAdvancedRouter();
      const pool = router.getProviderPool();
      expect(pool.size).toBe(3);
      expect(pool.has("ollama")).toBe(true);
      expect(pool.has("openai")).toBe(true);
      expect(pool.has("lmstudio")).toBe(true);
    });

    test("should return the routing config", () => {
      const router = makeAdvancedRouter();
      const config = router.getRoutingConfig();
      expect(config).toBeDefined();
      expect(config!.enabled).toBe(true);
      expect(config!.rules!.length).toBe(4);
    });
  });

  describe("backward compatibility", () => {
    test("should work without advanced routing (Phase 4 only)", () => {
      const router = new ModelRouter(lightProvider, heavyProvider);
      const result = router.selectProvider("debug this error");
      expect(result.routedByRule).toBe(false);
      expect(result.provider).toBeDefined();
      // Phase 4: debugging is complex → heavy
      expect(result.classification.taskType).toBe("debugging");
    });

    test("should still expose light/heavy providers", () => {
      const router = makeAdvancedRouter();
      expect(router.getLightProvider().getDefaultModel()).toBe("phi");
      expect(router.getHeavyProvider().getDefaultModel()).toBe("mistral");
    });
  });
});
