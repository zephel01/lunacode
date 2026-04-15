export class TokenCounter {
  // Estimate token count from text
  // CJK: ~1.5 chars per token, ASCII: ~4 chars per token
  static estimate(text: string): number {
    if (!text) return 0;
    let tokens = 0;
    for (const char of text) {
      if (char.charCodeAt(0) > 0x7f) {
        tokens += 0.67; // Non-ASCII ≈ 1.5 chars per token
      } else {
        tokens += 0.25; // ASCII ≈ 4 chars per token
      }
    }
    return Math.ceil(tokens);
  }

  // Estimate total tokens for a message array
  static estimateMessages(
    messages: Array<{
      role: string;
      content?: string | null;
      tool_calls?: any[];
    }>,
  ): number {
    let total = 0;
    for (const msg of messages) {
      total += 4; // Message overhead (role, separators)
      total += this.estimate(msg.content || "");
      if (msg.tool_calls) {
        total += this.estimate(JSON.stringify(msg.tool_calls));
      }
    }
    total += 2; // End-of-sequence overhead
    return total;
  }
}
