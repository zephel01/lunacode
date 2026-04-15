import {
  ILLMProvider,
  LLMProviderConfig,
  LLMProviderType,
  OpenAICompatibleConfig,
  OllamaConfig,
} from "./LLMProvider.js";
import { OpenAIProvider } from "./OpenAIProvider.js";
import { OllamaProvider } from "./OllamaProvider.js";
import { LMStudioProvider } from "./LMStudioProvider.js";
import { ZAIProvider } from "./ZAIProvider.js";

export class LLMProviderFactory {
  /**
   * プロバイダー設定からLLMプロバイダーを作成
   */
  static createProvider(config: LLMProviderConfig): ILLMProvider {
    switch (config.type) {
      case "openai":
        return new OpenAIProvider(config as OpenAICompatibleConfig);
      case "ollama":
        return new OllamaProvider(config as OllamaConfig);
      case "lmstudio":
        return new LMStudioProvider(config as OpenAICompatibleConfig);
      case "litellm":
        // LiteLLMはOpenAI互換のAPIを使用
        return new LMStudioProvider({
          ...config,
          type: "lmstudio",
          baseUrl: config.baseUrl || "http://localhost:4000/v1",
        });
      case "zai":
        return new ZAIProvider({
          ...config,
          type: "zai",
        });
      default:
        throw new Error(`Unknown provider type: ${(config as any).type}`);
    }
  }

  /**
   * 環境変数から自動検出してプロバイダーを作成
   * config.json が存在しない場合のフォールバック用
   * 優先順位: LM Studio > Ollama > Z.AI > OpenAI
   */
  static autoDetectFromEnv(): ILLMProvider {
    if (process.env.LMSTUDIO_BASE_URL) {
      return LLMProviderFactory.createProvider({
        type: "lmstudio",
        baseUrl: process.env.LMSTUDIO_BASE_URL,
        model: process.env.LMSTUDIO_MODEL,
      });
    }

    if (process.env.OLLAMA_BASE_URL) {
      return LLMProviderFactory.createProvider({
        type: "ollama",
        baseUrl: process.env.OLLAMA_BASE_URL,
        model: process.env.OLLAMA_MODEL,
      });
    }

    if (process.env.ZAI_API_KEY || process.env.ZHIPUAI_API_KEY) {
      return LLMProviderFactory.createProvider({
        type: "zai",
        apiKey: process.env.ZAI_API_KEY || process.env.ZHIPUAI_API_KEY,
        model: process.env.ZAI_MODEL,
      });
    }

    if (process.env.OPENAI_API_KEY || process.env.LUNACODE_API_KEY) {
      return LLMProviderFactory.createProvider({
        type: "openai",
        apiKey: process.env.OPENAI_API_KEY || process.env.LUNACODE_API_KEY,
        model: process.env.OPENAI_MODEL,
      });
    }

    throw new Error(
      "No LLM provider detected.\n" +
        "Please configure .kairos/config.json or set environment variables:\n" +
        "  - OPENAI_API_KEY (for OpenAI)\n" +
        "  - ZAI_API_KEY (for Z.AI / GLM)\n" +
        "  - LMSTUDIO_BASE_URL (for LM Studio)\n" +
        "  - OLLAMA_BASE_URL (for Ollama)\n" +
        "\nSee: lunacode init  (to generate config.json)\n",
    );
  }

  /**
   * @deprecated autoDetectFromEnv() を使用してください
   */
  static autoDetectProvider(): ILLMProvider {
    return LLMProviderFactory.autoDetectFromEnv();
  }

  /**
   * プロバイダータイプの説明を取得
   */
  static getProviderDescription(type: LLMProviderType): string {
    const descriptions: Record<LLMProviderType, string> = {
      openai:
        "OpenAI - Cloud-based AI API (requires API key). Best performance and quality.",
      ollama:
        "Ollama - Local LLM runner. Run models locally on your machine. Requires Ollama installation.",
      lmstudio:
        "LM Studio - Local LLM with OpenAI-compatible API. Easy to use, requires LM Studio app.",
      litellm:
        "LiteLLM - Unified API for 100+ LLM providers. Requires LiteLLM proxy server.",
      zai:
        "Z.AI (GLM) - Coding Plan with GLM-5.1/5-Turbo models. Dedicated coding endpoint for agents & IDEs.",
    };
    return descriptions[type];
  }

  /**
   * 利用可能なプロバイダータイプのリスト
   */
  static getAvailableProviders(): LLMProviderType[] {
    return ["openai", "ollama", "lmstudio", "litellm", "zai"];
  }

  /**
   * プロバイダーのデフォルト設定を取得
   */
  static getDefaultConfig(type: LLMProviderType): Partial<LLMProviderConfig> {
    const defaults: Record<LLMProviderType, Partial<LLMProviderConfig>> = {
      openai: {
        type: "openai",
        model: "gpt-4o-mini",
        temperature: 0.7,
        maxTokens: 1000,
      },
      ollama: {
        type: "ollama",
        baseUrl: "http://localhost:11434",
        model: "llama3.1",
        temperature: 0.7,
        maxTokens: 1000,
      },
      lmstudio: {
        type: "lmstudio",
        baseUrl: "http://localhost:1234/v1",
        model: "local-model",
        temperature: 0.7,
        maxTokens: 1000,
      },
      litellm: {
        type: "litellm",
        baseUrl: "http://localhost:4000/v1",
        model: "gpt-4o-mini",
        temperature: 0.7,
        maxTokens: 1000,
      },
      zai: {
        type: "zai",
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
        model: "glm-5.1",
        temperature: 0.7,
        maxTokens: 4096,
      },
    };
    return defaults[type];
  }
}
