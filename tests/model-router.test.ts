import { describe, test, expect } from "bun:test";
import { ModelRouter } from "../src/agents/ModelRouter.js";
import {
  ILLMProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  LLMProviderType,
  GenerateResponseOptions,
} from "../src/providers/LLMProvider.js";

function createMockProvider(model: string): ILLMProvider {
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
    getType: () => "ollama" as LLMProviderType,
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
      const { provider, classification } = router.selectProvider("what is this?");
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
      const { provider, classification } = router.selectProvider(
        "create a new file",
      );
      expect(provider.getDefaultModel()).toBe("mistral");
      expect(classification.complexity).toBe("moderate");
      expect(classification.suggestedModel).toBe("heavy");
    });

    test("should return classification details", () => {
      const { classification } = router.selectProvider(
        "explain this function",
      );
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
