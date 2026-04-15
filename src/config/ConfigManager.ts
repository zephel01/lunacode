import * as fs from "fs/promises";
import * as path from "path";
import { LLMProviderConfig } from "../providers/LLMProvider.js";

export interface CheckpointConfig {
  enabled?: boolean;
  maxCheckpoints?: number;
  autoCheckpoint?: boolean;
}

export interface ApprovalConfig {
  mode?: "auto" | "selective" | "always";
  showDiff?: boolean;
  autoApproveReadOnly?: boolean;
  timeoutSeconds?: number;
}

export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MCPConfig {
  servers?: MCPServerConfig[];
}

export interface LunaCodeConfig {
  // LLMプロバイダー設定
  llm: {
    provider: "openai" | "ollama" | "lmstudio" | "litellm" | "zai";
    model?: string;
    temperature?: number;
    maxTokens?: number;
    openai?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
    };
    ollama?: {
      baseUrl?: string;
      model?: string;
    };
    lmstudio?: {
      baseUrl?: string;
      model?: string;
    };
    litellm?: {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
    };
    zai?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      useCodingEndpoint?: boolean;
    };
  };
  // エージェント設定
  agent: {
    maxIterations: number;
    timeout: number;
  };
  // メモリ設定
  memory: {
    enabled: boolean;
    maxTokens: number;
  };
  // デーモン設定
  daemon: {
    enabled: boolean;
    tickIntervalSeconds: number;
  };
  // チェックポイント設定（Phase 5）
  checkpoint?: CheckpointConfig;
  // 承認フロー設定（Phase 6）
  approval?: ApprovalConfig;
  // MCP設定（Phase 9）
  mcp?: MCPConfig;
  // 拡張設定（プラグイン等からの任意セクション）
  [key: string]: unknown;
}

export class ConfigManager {
  private configPath: string;
  private config: LunaCodeConfig;
  private configLoaded: boolean = false;

  constructor(basePath: string) {
    this.configPath = path.join(basePath, "config.json");
    this.config = this.getDefaultConfig();
  }

  private getDefaultConfig(): LunaCodeConfig {
    return {
      llm: {
        provider: "openai",
        model: "gpt-4o-mini",
        temperature: 0.7,
        maxTokens: 1000,
      },
      agent: {
        maxIterations: 50,
        timeout: 15000,
      },
      memory: {
        enabled: true,
        maxTokens: 200,
      },
      daemon: {
        enabled: false,
        tickIntervalSeconds: 60,
      },
    };
  }

  /**
   * オブジェクトのディープマージ
   */
  private deepMerge<T extends Record<string, unknown>>(
    target: T,
    source: Partial<T>,
  ): T {
    const result = { ...target };
    for (const key of Object.keys(source) as Array<keyof T>) {
      const sourceVal = source[key];
      const targetVal = target[key];
      if (
        sourceVal &&
        typeof sourceVal === "object" &&
        !Array.isArray(sourceVal) &&
        targetVal &&
        typeof targetVal === "object" &&
        !Array.isArray(targetVal)
      ) {
        result[key] = this.deepMerge(
          targetVal as Record<string, unknown>,
          sourceVal as Record<string, unknown>,
        ) as T[keyof T];
      } else if (sourceVal !== undefined) {
        result[key] = sourceVal as T[keyof T];
      }
    }
    return result;
  }

  async load(): Promise<LunaCodeConfig> {
    try {
      const content = await fs.readFile(this.configPath, "utf-8");
      const loaded = JSON.parse(content);
      this.config = this.deepMerge(this.config, loaded);
      this.configLoaded = true;
      console.log(`✅ Configuration loaded from ${this.configPath}`);
      return this.config;
    } catch (error) {
      // ファイルが存在しない場合はデフォルト設定を使用
      console.log("ℹ️  No config.json found, using default configuration");
      console.log(
        "   Run 'lunacode init' or create .kairos/config.json to configure",
      );
      return this.config;
    }
  }

  async save(): Promise<void> {
    await fs.writeFile(
      this.configPath,
      JSON.stringify(this.config, null, 2),
      "utf-8",
    );
  }

  /**
   * LLMプロバイダー設定を取得
   * 優先順位: config.json (プロバイダー固有) > config.json (共通) > 環境変数 > デフォルト値
   */
  getLLMProviderConfig(): LLMProviderConfig {
    const provider = this.config.llm.provider;

    switch (provider) {
      case "openai":
        return {
          type: "openai",
          apiKey:
            this.config.llm.openai?.apiKey ||
            process.env.OPENAI_API_KEY ||
            process.env.LUNACODE_API_KEY,
          baseUrl:
            this.config.llm.openai?.baseUrl || process.env.OPENAI_BASE_URL,
          model:
            this.config.llm.openai?.model ||
            this.config.llm.model ||
            process.env.OPENAI_MODEL ||
            "gpt-4o-mini",
          temperature: this.config.llm.temperature,
          maxTokens: this.config.llm.maxTokens,
        };
      case "ollama":
        return {
          type: "ollama",
          baseUrl:
            this.config.llm.ollama?.baseUrl ||
            process.env.OLLAMA_BASE_URL ||
            "http://localhost:11434",
          model:
            this.config.llm.ollama?.model ||
            this.config.llm.model ||
            process.env.OLLAMA_MODEL ||
            "llama3.1",
          temperature: this.config.llm.temperature,
          maxTokens: this.config.llm.maxTokens,
        };
      case "lmstudio":
        return {
          type: "lmstudio",
          baseUrl:
            this.config.llm.lmstudio?.baseUrl ||
            process.env.LMSTUDIO_BASE_URL ||
            "http://localhost:1234/v1",
          model:
            this.config.llm.lmstudio?.model ||
            this.config.llm.model ||
            process.env.LMSTUDIO_MODEL ||
            "local-model",
          temperature: this.config.llm.temperature,
          maxTokens: this.config.llm.maxTokens,
        };
      case "litellm":
        return {
          type: "litellm",
          baseUrl:
            this.config.llm.litellm?.baseUrl ||
            process.env.LITELLM_BASE_URL ||
            "http://localhost:4000/v1",
          apiKey:
            this.config.llm.litellm?.apiKey || process.env.LITELLM_API_KEY,
          model:
            this.config.llm.litellm?.model ||
            this.config.llm.model ||
            process.env.LITELLM_MODEL ||
            "gpt-4o-mini",
          temperature: this.config.llm.temperature,
          maxTokens: this.config.llm.maxTokens,
        };
      case "zai":
        return {
          type: "zai",
          apiKey:
            this.config.llm.zai?.apiKey ||
            process.env.ZAI_API_KEY ||
            process.env.ZHIPUAI_API_KEY,
          baseUrl: this.config.llm.zai?.baseUrl || process.env.ZAI_BASE_URL,
          model:
            this.config.llm.zai?.model ||
            this.config.llm.model ||
            process.env.ZAI_MODEL ||
            "glm-5.1",
          temperature: this.config.llm.temperature,
          maxTokens: this.config.llm.maxTokens,
          useCodingEndpoint: this.config.llm.zai?.useCodingEndpoint,
        };
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  /**
   * config.json が存在し、プロバイダーが明示的に設定されているかチェック
   */
  isProviderConfigured(): boolean {
    return this.configLoaded;
  }

  /**
   * 設定セクションを名前で取得（Phase 5/6/9 等の拡張設定に対応）
   * config.json の任意のトップレベルキーを取得できる
   */
  get(section: string): unknown {
    return (this.config as Record<string, unknown>)[section] ?? undefined;
  }

  getAgentConfig() {
    return this.config.agent;
  }

  getMemoryConfig() {
    return this.config.memory;
  }

  getDaemonConfig() {
    return this.config.daemon;
  }

  updateLLMProvider(config: Partial<LunaCodeConfig["llm"]>): void {
    this.config.llm = { ...this.config.llm, ...config };
  }

  updateAgentConfig(config: Partial<LunaCodeConfig["agent"]>): void {
    this.config.agent = { ...this.config.agent, ...config };
  }
}
