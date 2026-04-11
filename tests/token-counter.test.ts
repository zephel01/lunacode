import { describe, it, expect } from "bun:test";
import { TokenCounter } from "../src/utils/TokenCounter.js";

describe("TokenCounter", () => {
  describe("estimate", () => {
    it("returns 0 for empty string", () => {
      expect(TokenCounter.estimate("")).toBe(0);
    });

    it("estimates ASCII text correctly", () => {
      const result = TokenCounter.estimate("hello world");
      // "hello world" is 11 chars, ASCII only
      // 11 chars * 0.25 (4 chars per token) = 2.75, rounds to 3
      expect(result).toBe(3);
    });

    it("estimates CJK text correctly", () => {
      const result = TokenCounter.estimate("こんにちは");
      // 5 CJK characters, each 0.67 tokens = 3.35, rounds to 4
      expect(result).toBe(4);
    });

    it("estimates mixed content correctly", () => {
      const result = TokenCounter.estimate("hello こんにちは world");
      // "hello " = 6 chars * 0.25 = 1.5
      // "こんにちは" = 5 chars * 0.67 = 3.35
      // " world" = 6 chars * 0.25 = 1.5
      // total = 6.35, rounds to 7
      expect(result).toBe(7);
    });

    it("handles long text", () => {
      const longText = "a".repeat(1000);
      const result = TokenCounter.estimate(longText);
      // 1000 * 0.25 = 250
      expect(result).toBe(250);
    });
  });

  describe("estimateMessages", () => {
    it("estimates single message", () => {
      const messages = [
        { role: "user", content: "hello" },
      ];
      const result = TokenCounter.estimateMessages(messages);
      // Message overhead: 4
      // "hello" = 5 * 0.25 = 1.25
      // End-of-sequence: 2
      // Total = 4 + 1.25 + 2 = 7.25, rounds to 8
      expect(result).toBeGreaterThan(0);
    });

    it("estimates multiple messages", () => {
      const messages = [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ];
      const result = TokenCounter.estimateMessages(messages);
      expect(result).toBeGreaterThan(10);
    });

    it("handles messages with tool_calls", () => {
      const messages = [
        {
          role: "assistant",
          content: "calling tool",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "test_func", arguments: '{"key": "value"}' },
            },
          ],
        },
      ];
      const result = TokenCounter.estimateMessages(messages);
      expect(result).toBeGreaterThan(0);
    });

    it("handles null content", () => {
      const messages = [
        { role: "assistant", content: null },
      ];
      const result = TokenCounter.estimateMessages(messages);
      // Should just have message overhead + end-of-sequence
      expect(result).toBeGreaterThan(0);
    });

    it("empty array returns end-of-sequence overhead", () => {
      const messages: any[] = [];
      const result = TokenCounter.estimateMessages(messages);
      // Only end-of-sequence overhead: 2
      expect(result).toBe(2);
    });
  });
});
