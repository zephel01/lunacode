export interface ModelInfo {
  contextLength: number;
  defaultMaxTokens: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  category: "small" | "medium" | "large";
}

const KNOWN_MODELS: Record<string, ModelInfo> = {
  "llama3.1":        { contextLength: 131072, defaultMaxTokens: 4096, supportsTools: true,  supportsStreaming: true, category: "medium" },
  "llama3.1:8b":     { contextLength: 131072, defaultMaxTokens: 4096, supportsTools: true,  supportsStreaming: true, category: "medium" },
  "qwen2.5:14b":     { contextLength: 131072, defaultMaxTokens: 4096, supportsTools: true,  supportsStreaming: true, category: "large" },
  "qwen3.5:4b":      { contextLength: 32768,  defaultMaxTokens: 4096, supportsTools: false, supportsStreaming: true, category: "small" },
  "gemma4:e4b":      { contextLength: 131072, defaultMaxTokens: 4096, supportsTools: false, supportsStreaming: true, category: "medium" },
  "mistral:7b":      { contextLength: 32768,  defaultMaxTokens: 4096, supportsTools: true,  supportsStreaming: true, category: "medium" },
  "codellama:13b":   { contextLength: 16384,  defaultMaxTokens: 4096, supportsTools: false, supportsStreaming: true, category: "large" },
  "deepseek-coder:6.7b": { contextLength: 16384, defaultMaxTokens: 4096, supportsTools: false, supportsStreaming: true, category: "medium" },
};

// Default for unknown models
const DEFAULT_MODEL_INFO: ModelInfo = {
  contextLength: 8192,
  defaultMaxTokens: 4096,
  supportsTools: false,
  supportsStreaming: true,
  category: "medium",
};

export class ModelRegistry {
  private models: Map<string, ModelInfo> = new Map();
  
  constructor() {
    // Load known models
    for (const [name, info] of Object.entries(KNOWN_MODELS)) {
      this.models.set(name, info);
    }
  }

  async getModelInfo(modelName: string, ollamaBaseUrl?: string): Promise<ModelInfo> {
    // Check exact match
    if (this.models.has(modelName)) {
      return this.models.get(modelName)!;
    }
    
    // Check prefix match (e.g., "llama3.1:latest" matches "llama3.1")
    for (const [name, info] of this.models) {
      if (modelName.startsWith(name)) {
        return info;
      }
    }

    // Try fetching from Ollama /api/show
    if (ollamaBaseUrl) {
      try {
        const fetched = await this.fetchOllamaModelInfo(modelName, ollamaBaseUrl);
        if (fetched) {
          const info = { ...DEFAULT_MODEL_INFO, ...fetched };
          this.models.set(modelName, info);
          return info;
        }
      } catch {
        // Fall through to default
      }
    }

    return DEFAULT_MODEL_INFO;
  }

  private async fetchOllamaModelInfo(modelName: string, baseUrl: string): Promise<Partial<ModelInfo> | null> {
    try {
      const response = await fetch(`${baseUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: modelName }),
      });
      
      if (!response.ok) return null;
      
      const data = await response.json() as any;
      
      // Extract context length from model parameters
      const params = data.model_info || {};
      let contextLength = DEFAULT_MODEL_INFO.contextLength;
      
      // Look for context length in various fields
      for (const key of Object.keys(params)) {
        if (key.includes("context_length") || key.includes("max_position")) {
          const val = params[key];
          if (typeof val === "number" && val > 0) {
            contextLength = val;
            break;
          }
        }
      }

      return { contextLength };
    } catch {
      return null;
    }
  }

  registerModel(name: string, info: ModelInfo): void {
    this.models.set(name, info);
  }

  getKnownModels(): string[] {
    return Array.from(this.models.keys());
  }
}
