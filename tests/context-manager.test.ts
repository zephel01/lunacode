import { describe, it, expect } from "bun:test";
import { ContextManager } from "../src/agents/ContextManager.js";
import { ModelInfo } from "../src/providers/ModelRegistry.js";
import { AgentMessage } from "../src/types/index.js";

describe("ContextManager", () => {
  const createTestModel = (contextLength: number, defaultMaxTokens: number = 4096): ModelInfo => ({
    contextLength,
    defaultMaxTokens,
    supportsTools: true,
    supportsStreaming: true,
    category: "medium",
  });

  describe("basic properties", () => {
    it("initializes with correct context length", () => {
      const modelInfo = createTestModel(8192);
      const manager = new ContextManager(modelInfo);
      expect(manager.contextLength).toBe(8192);
    });

    it("calculates available tokens correctly", () => {
      const modelInfo = createTestModel(8192, 4096);
      const manager = new ContextManager(modelInfo);
      expect(manager.availableTokens).toBe(4096); // 8192 - 4096
    });
  });

  describe("fitMessages", () => {
    it("returns unchanged messages when they fit", () => {
      const modelInfo = createTestModel(10000, 1000); // 9000 available
      const manager = new ContextManager(modelInfo);
      
      const messages: AgentMessage[] = [
        { role: "user", content: "short message" },
      ];

      const result = manager.fitMessages(messages);
      expect(result.length).toBe(1);
      expect(result[0].content).toBe("short message");
    });

    it("preserves system messages", () => {
      const modelInfo = createTestModel(500, 400); // 100 available
      const manager = new ContextManager(modelInfo);

      const messages: AgentMessage[] = [
        { role: "system", content: "system instruction" },
        { role: "user", content: "user message" },
        { role: "assistant", content: "assistant response" },
      ];

      const result = manager.fitMessages(messages);
      const systemMsg = result.find(m => m.role === "system");
      expect(systemMsg).toBeDefined();
      expect(systemMsg?.content).toBe("system instruction");
    });

    it("drops oldest non-system messages when exceeding context", () => {
      const modelInfo = createTestModel(600, 400); // ~200 available
      const manager = new ContextManager(modelInfo);

      const messages: AgentMessage[] = [
        { role: "user", content: "first user message" },
        { role: "assistant", content: "first assistant response" },
        { role: "user", content: "second user message" },
        { role: "assistant", content: "second assistant response" },
      ];

      const result = manager.fitMessages(messages);
      // Newest messages should be kept, oldest dropped
      expect(result[result.length - 1].content).toBe("second assistant response");
    });

    it("handles system message exceeding context limit", () => {
      const modelInfo = createTestModel(100, 50); // 50 available
      const manager = new ContextManager(modelInfo);

      const messages: AgentMessage[] = [
        { role: "system", content: "a".repeat(200) }, // Large system message
        { role: "user", content: "user message" },
      ];

      const result = manager.fitMessages(messages);
      // Should still have system and latest user message
      expect(result.some(m => m.role === "system")).toBe(true);
      expect(result.some(m => m.role === "user")).toBe(true);
    });

    it("maintains message order when fitting", () => {
      const modelInfo = createTestModel(1000, 600); // 400 available
      const manager = new ContextManager(modelInfo);

      const messages: AgentMessage[] = [
        { role: "user", content: "m1" },
        { role: "assistant", content: "m2" },
        { role: "user", content: "m3" },
      ];

      const result = manager.fitMessages(messages);
      // Check order is preserved
      let lastIndex = -1;
      for (const msg of messages) {
        const currentIndex = result.findIndex(m => m.content === msg.content);
        if (currentIndex !== -1) {
          expect(currentIndex).toBeGreaterThan(lastIndex);
          lastIndex = currentIndex;
        }
      }
    });
  });

  describe("getUsageInfo", () => {
    it("returns correct usage percentages", () => {
      const modelInfo = createTestModel(8192, 4096);
      const manager = new ContextManager(modelInfo);

      const messages: AgentMessage[] = [
        { role: "user", content: "test" },
      ];

      const usage = manager.getUsageInfo(messages);
      expect(usage.total).toBe(8192);
      expect(usage.available).toBe(4096);
      expect(usage.used).toBeGreaterThan(0);
      expect(usage.percentage).toBeGreaterThanOrEqual(0);
      expect(usage.percentage).toBeLessThanOrEqual(100);
    });

    it("percentage increases with more messages", () => {
      const modelInfo = createTestModel(10000, 8000);
      const manager = new ContextManager(modelInfo);

      const messages1: AgentMessage[] = [
        { role: "user", content: "a" },
      ];
      const usage1 = manager.getUsageInfo(messages1);

      const messages2: AgentMessage[] = [
        { role: "user", content: "a".repeat(1000) },
      ];
      const usage2 = manager.getUsageInfo(messages2);

      expect(usage2.percentage).toBeGreaterThan(usage1.percentage);
    });
  });

  describe("calibrate", () => {
    it("logs calibration info when ratio is off", () => {
      const modelInfo = createTestModel(8192);
      const manager = new ContextManager(modelInfo);

      // Should not throw
      manager.calibrate({ prompt_tokens: 200 }, 100);
    });

    it("handles perfect match", () => {
      const modelInfo = createTestModel(8192);
      const manager = new ContextManager(modelInfo);

      manager.calibrate({ prompt_tokens: 100 }, 100);
      // Should not throw
    });
  });

  describe("edge cases", () => {
    it("handles very small context window", () => {
      const modelInfo = createTestModel(100, 50);
      const manager = new ContextManager(modelInfo);

      const messages: AgentMessage[] = [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ];

      const result = manager.fitMessages(messages);
      expect(result.length).toBeGreaterThan(0);
      expect(result.some(m => m.role === "system")).toBe(true);
    });

    it("handles empty message array", () => {
      const modelInfo = createTestModel(8192);
      const manager = new ContextManager(modelInfo);

      const result = manager.fitMessages([]);
      expect(result.length).toBe(0);
    });

    it("handles messages with tool calls", () => {
      const modelInfo = createTestModel(8192);
      const manager = new ContextManager(modelInfo);

      const messages: AgentMessage[] = [
        {
          role: "assistant",
          content: "calling tool",
          toolCalls: [
            {
              id: "1",
              type: "function",
              function: { name: "test", arguments: '{}' },
            },
          ],
        },
      ];

      const result = manager.fitMessages(messages);
      expect(result.length).toBe(1);
    });
  });
});
