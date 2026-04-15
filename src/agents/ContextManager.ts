import { AgentMessage } from "../types/index.js";
import { ModelInfo } from "../providers/ModelRegistry.js";
import { TokenCounter } from "../utils/TokenCounter.js";

export class ContextManager {
  private modelInfo: ModelInfo;
  private reservedTokens: number;

  constructor(modelInfo: ModelInfo) {
    this.modelInfo = modelInfo;
    this.reservedTokens = modelInfo.defaultMaxTokens;
  }

  get availableTokens(): number {
    return this.modelInfo.contextLength - this.reservedTokens;
  }

  get contextLength(): number {
    return this.modelInfo.contextLength;
  }

  // Fit messages within context window
  fitMessages(messages: AgentMessage[]): AgentMessage[] {
    const totalTokens = TokenCounter.estimateMessages(
      messages as { role: string; content?: string | null }[],
    );

    if (totalTokens <= this.availableTokens) {
      return messages;
    }

    // Strategy: always keep system messages, drop oldest non-system messages
    const systemMessages = messages.filter((m) => m.role === "system");
    const otherMessages = messages.filter((m) => m.role !== "system");

    const systemTokens = TokenCounter.estimateMessages(
      systemMessages as {
        role: string;
        content?: string | null;
        tool_calls?: unknown[];
      }[],
    );
    let budget = this.availableTokens - systemTokens;

    if (budget <= 0) {
      // System message alone exceeds limit - truncate system and keep latest user message
      console.warn("⚠️ System message exceeds context window. Truncating.");
      return [...systemMessages, ...otherMessages.slice(-2)];
    }

    // Keep messages from newest to oldest
    const kept: AgentMessage[] = [];
    for (let i = otherMessages.length - 1; i >= 0; i--) {
      const tokens = TokenCounter.estimateMessages([otherMessages[i]] as {
        role: string;
        content?: string | null;
        tool_calls?: unknown[];
      }[]);
      if (budget - tokens < 0) break;
      budget -= tokens;
      kept.unshift(otherMessages[i]);
    }

    const removed = otherMessages.length - kept.length;
    if (removed > 0) {
      console.log(
        `📦 Context window: trimmed ${removed} old messages (${totalTokens} → ~${totalTokens - removed * 50} est. tokens)`,
      );
    }

    return [...systemMessages, ...kept];
  }

  // Get current token usage info
  getUsageInfo(messages: AgentMessage[]): {
    used: number;
    available: number;
    total: number;
    percentage: number;
  } {
    const used = TokenCounter.estimateMessages(
      messages as { role: string; content?: string | null }[],
    );
    return {
      used,
      available: this.availableTokens,
      total: this.modelInfo.contextLength,
      percentage: Math.round((used / this.availableTokens) * 100),
    };
  }

  // Calibrate estimates with actual usage data from provider
  calibrate(actual: { prompt_tokens: number }, estimated: number): void {
    // Could implement adaptive correction factor here in the future
    const ratio = actual.prompt_tokens / Math.max(estimated, 1);
    if (ratio > 1.5 || ratio < 0.5) {
      console.log(
        `📊 Token estimate calibration: estimated=${estimated}, actual=${actual.prompt_tokens}, ratio=${ratio.toFixed(2)}`,
      );
    }
  }
}
