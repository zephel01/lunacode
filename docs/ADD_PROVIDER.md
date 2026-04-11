# LLMプロバイダーの追加方法

このガイドはLunaCodeに新しいLLMプロバイダーを追加する方法を説明します。

## 概要

LunaCodeは`ILLMProvider`インターフェースを実装することで、様々なLLMプロバイダーをサポートしています。既存のプロバイダー（OpenAI、Ollama、LM Studio、Z.AI）のパターンに従って、新しいプロバイダーを追加できます。

## 手順

### ステップ1: プロバイダークラスを作成

`src/providers/NewProvider.ts`（適切な名前に変更）を作成します。

**最もシンプルなパターン - OpenAI互換APIの場合:**

```typescript
import OpenAI from "openai";
import {
  ILLMProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  OpenAICompatibleConfig,
  GenerateResponseOptions,
  defaultGenerateResponse,
} from "./LLMProvider.js";

export class NewProvider implements ILLMProvider {
  private client: OpenAI;
  private config: OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    this.config = {
      type: "newprovider", // このタイプをLLMProviderTypeに追加
      baseUrl: config.baseUrl || "https://api.example.com/v1",
      model: config.model || "default-model",
      apiKey: config.apiKey || "",
      temperature: config.temperature || 0.7,
      maxTokens: config.maxTokens || 1000,
    };

    this.client = new OpenAI({
      apiKey: this.config.apiKey || "not-needed",
      baseURL: this.config.baseUrl,
    });
  }

  async chatCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const response = await this.client.chat.completions.create({
      model: request.model || this.config.model || "default-model",
      messages: request.messages as any,
      temperature: request.temperature || this.config.temperature || 0.7,
      max_tokens: request.max_tokens || this.config.maxTokens || 1000,
      tools: request.tools,
      stream: false,
    });

    return {
      id: response.id,
      object: response.object,
      created: response.created,
      model: response.model,
      choices: response.choices.map((choice) => ({
        index: choice.index,
        message: {
          role: choice.message.role,
          content: choice.message.content,
          tool_calls: choice.message.tool_calls?.map((tc) => ({
            id: tc.id,
            type: tc.type,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        },
        finish_reason: choice.finish_reason,
      })),
      usage: response.usage
        ? {
            prompt_tokens: response.usage.prompt_tokens,
            completion_tokens: response.usage.completion_tokens,
            total_tokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }

  async generateResponse(
    prompt: string,
    options?: GenerateResponseOptions,
  ): Promise<string> {
    return defaultGenerateResponse(this, prompt, options);
  }

  getType(): "newprovider" {
    return "newprovider";
  }

  getDefaultModel(): string {
    return this.config.model || "default-model";
  }

  async initialize(): Promise<void> {
    await this.testConnection();
  }

  async cleanup(): Promise<void> {
    // クライアントのクリーンアップが必要な場合
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.client.chat.completions.create({
        model: this.config.model || "default-model",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 1,
      });
      return true;
    } catch (error) {
      console.error("NewProvider connection test failed:", error);
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.config.baseUrl}/models`);
      const data = await response.json();
      return data.data.map((model: any) => model.id);
    } catch (error) {
      console.error("Failed to list NewProvider models:", error);
      return [];
    }
  }
}
```

**カスタムAPIの場合:**

```typescript
import {
  ILLMProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  GenerateResponseOptions,
  defaultGenerateResponse,
} from "./LLMProvider.js";

interface NewProviderConfig extends LLMProviderConfig {
  type: "newprovider";
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export class NewProvider implements ILLMProvider {
  private config: NewProviderConfig;

  constructor(config: NewProviderConfig) {
    this.config = {
      type: "newprovider",
      baseUrl: config.baseUrl || "https://api.example.com",
      model: config.model || "default-model",
      apiKey: config.apiKey || "",
      temperature: config.temperature || 0.7,
      maxTokens: config.maxTokens || 1000,
    };
  }

  async chatCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const response = await fetch(`${this.config.baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model || this.config.model,
        messages: request.messages,
        temperature: request.temperature || this.config.temperature,
        max_tokens: request.max_tokens || this.config.maxTokens,
        tools: request.tools,
      }),
    });

    if (!response.ok) {
      throw new Error(`NewProvider API error: ${response.statusText}`);
    }

    const data = await response.json();
    
    return {
      id: data.id || `newprovider-${Date.now()}`,
      object: "chat.completion",
      created: data.created || Math.floor(Date.now() / 1000),
      model: data.model || request.model || this.config.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: data.message?.content || null,
            tool_calls: data.message?.tool_calls,
          },
          finish_reason: data.finish_reason || "stop",
        },
      ],
      usage: data.usage
        ? {
            prompt_tokens: data.usage.prompt_tokens,
            completion_tokens: data.usage.completion_tokens,
            total_tokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }

  // ... 他のメソッドは上記と同様
}
```

### ステップ2: LLMProviderTypeを更新

`src/providers/LLMProvider.ts`の型定義に新しいプロバイダータイプを追加します:

```typescript
export type LLMProviderType = "openai" | "ollama" | "lmstudio" | "litellm" | "zai" | "newprovider";
```

### ステップ3: 設定インターフェースを追加（必要な場合）

カスタムAPIで追加の設定が必要な場合:

```typescript
// src/providers/LLMProvider.ts

// NewProvider専用の設定インターフェース
export interface NewProviderConfig extends LLMProviderConfig {
  type: "newprovider";
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  customParam?: string; // プロバイダー固有のパラメータ
}
```

### ステップ4: LLMProviderFactoryに登録

`src/providers/LLMProviderFactory.ts`を更新します:

```typescript
import { NewProvider } from "./NewProvider.js";

export class LLMProviderFactory {
  static createProvider(config: LLMProviderConfig): ILLMProvider {
    switch (config.type) {
      // ... 既存のケース
      case "newprovider":
        return new NewProvider(config as any);
      default:
        throw new Error(`Unknown provider type: ${(config as any).type}`);
    }
  }

  static getProviderDescription(type: LLMProviderType): string {
    const descriptions: Record<LLMProviderType, string> = {
      // ... 既存の記述
      newprovider:
        "NewProvider - Description of your provider. Explain what it is and when to use it.",
    };
    return descriptions[type];
  }

  static getAvailableProviders(): LLMProviderType[] {
    return ["openai", "ollama", "lmstudio", "litellm", "zai", "newprovider"];
  }

  static getDefaultConfig(type: LLMProviderType): Partial<LLMProviderConfig> {
    const defaults: Record<LLMProviderType, Partial<LLMProviderConfig>> = {
      // ... 既存のデフォルト
      newprovider: {
        type: "newprovider",
        baseUrl: "https://api.example.com/v1",
        model: "default-model",
        temperature: 0.7,
        maxTokens: 1000,
      },
    };
    return defaults[type];
  }
}
```

### ステップ5: ModelRegistryにモデル情報を追加

プロバイダーが使用する主要モデルの情報を`src/providers/ModelRegistry.ts`に追加します:

```typescript
const KNOWN_MODELS: Record<string, ModelInfo> = {
  // ... 既存のモデル
  "newprovider-model": {
    contextLength: 32768,
    defaultMaxTokens: 4096,
    supportsTools: true,
    supportsStreaming: true,
    category: "medium",
  },
  "newprovider-large": {
    contextLength: 131072,
    defaultMaxTokens: 8192,
    supportsTools: true,
    supportsStreaming: true,
    category: "large",
  },
};
```

### ステップ6: CLIで選択可能にする

`src/cli.ts`の`handleInitCommand`メソッドに新しいプロバイダーを追加します:

```typescript
async function handleInitCommand(kairosPath: string, args: string[]): Promise<void> {
  // ... 既存のコード

  const providers = [
    "openai    - OpenAI API (GPT-4o, GPT-4o-mini)",
    "ollama    - ローカル LLM (Llama, Gemma, Qwen 等)",
    "lmstudio  - LM Studio (ローカル)",
    "zai       - Z.AI Coding Plan (GLM-5.1)",
    "litellm   - LiteLLM Proxy (100+ プロバイダー)",
    "newprovider - NewProvider (説明を追加)",
  ];
  
  const providerNames = ["openai", "ollama", "lmstudio", "litellm", "zai", "newprovider"];
  
  // ... 既存のコード

  switch (provider) {
    // ... 既存のケース
    case "newprovider": {
      const apiKey = await prompt("API Key: ");
      const baseUrl = await prompt("Base URL [default: https://api.example.com/v1]: ") || "https://api.example.com/v1";
      const model = await prompt("Model [default: default-model]: ") || "default-model";
      config.llm.newprovider = {
        apiKey,
        baseUrl,
        model,
      };
      break;
    }
  }
  
  // ... 既存のコード
}
```

### ステップ7: テストを書く

`tests/newprovider-provider.test.ts`を作成します:

```typescript
import { describe, test, expect } from "bun:test";
import { NewProvider } from "../src/providers/NewProvider.js";

describe("NewProvider", () => {
  let provider: NewProvider;

  test("プロバイダーを作成できる", () => {
    provider = new NewProvider({
      type: "newprovider",
      baseUrl: "https://api.example.com/v1",
      model: "default-model",
      apiKey: "test-key",
    });
    expect(provider.getType()).toBe("newprovider");
    expect(provider.getDefaultModel()).toBe("default-model");
  });

  test("接続テストを実行できる", async () => {
    // モックを使用するか、実際のテストAPIに接続
    const result = await provider.testConnection();
    // 実際のテストでは適切な値を期待
    expect(typeof result).toBe("boolean");
  });

  test("chatCompletionを実行できる", async () => {
    const request = {
      model: "default-model",
      messages: [{ role: "user" as const, content: "Hello" }],
    };

    // モックを使用するか、実際のテストAPIに接続
    // const response = await provider.chatCompletion(request);
    // expect(response.choices).toBeDefined();
    // expect(response.choices[0].message.content).toBeTruthy();
  });
});
```

### ステップ8: ドキュメントを更新

1. **README.md**: プロバイダーリストと使用例を追加
2. **docs/guide/getting-started.md**: 初期化手順を更新
3. **AGENTS.md**: 新しいプロバイダーの説明を追加
4. **CHANGELOG.md**: 変更を記録

## 重要な考慮事項

### ストリーミング対応

APIがストリーミングをサポートする場合、`chatCompletionStream`メソッドを実装します:

```typescript
async *chatCompletionStream(
  request: ChatCompletionRequest,
): AsyncGenerator<StreamChunk> {
  const response = await fetch(`${this.config.baseUrl}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.config.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model || this.config.model,
      messages: request.messages,
      stream: true, // ストリーミングを有効化
    }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Response body is null");
  }

  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      // APIフォーマットに応じて解析
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const json = JSON.parse(line);

          if (json.choices?.[0]?.delta?.content) {
            yield {
              type: "content",
              delta: json.choices[0].delta.content,
            };
          }

          if (json.done) {
            yield {
              type: "done",
              usage: {
                prompt_tokens: json.usage?.prompt_tokens || 0,
                completion_tokens: json.usage?.completion_tokens || 0,
                total_tokens: json.usage?.total_tokens || 0,
              },
            };
          }
        } catch (e) {
          // JSONパースエラーは無視
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

supportsStreaming(): boolean {
  return true;
}
```

### ツール呼び出し対応

APIがツール呼び出しをサポートする場合:
- `tools`パラメータをAPIに渡す
- レスポンスから`tool_calls`を抽出
- `ILLMProvider`インターフェースの型に従う

APIがツール呼び出しをネイティブにサポートしない場合:
- OllamaProviderの`chatCompletionWithTextExtraction`パターンを参考に
- システムプロンプトにツール説明を注入
- テキストレスポンスからツール呼び出しを抽出

### 環境変数

`src/cli.ts`の`handleInitCommand`で環境変数チェックを追加:

```typescript
case "newprovider": {
  const apiKey = process.env.NEWPROVIDER_API_KEY || await prompt("API Key: ");
  const baseUrl = process.env.NEWPROVIDER_BASE_URL || await prompt("Base URL [default: https://api.example.com/v1]: ") || "https://api.example.com/v1";
  const model = process.env.NEWPROVIDER_MODEL || await prompt("Model [default: default-model]: ") || "default-model";
  config.llm.newprovider = { apiKey, baseUrl, model };
  break;
}
```

### エラーハンドリング

- 接続エラーを適切にログ
- ユーザーに明確なエラーメッセージを提供
- 可能な場合は再試行ロジックを実装

### セキュリティ

- APIキーをログに出力しない
- `.env.example`に必要な環境変数を追加
- ドキュメントでAPIキーの保護方法を説明

## 例: 完全なプロバイダー追加

以下は、新しいプロバイダーを追加するための全ファイルの変更点です:

### src/providers/LLMProvider.ts
```typescript
export type LLMProviderType = "openai" | "ollama" | "lmstudio" | "litellm" | "zai" | "newprovider";

export interface NewProviderConfig extends LLMProviderConfig {
  type: "newprovider";
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}
```

### src/providers/NewProvider.ts
```typescript
// 上記の完全な実装を参照
```

### src/providers/LLMProviderFactory.ts
```typescript
import { NewProvider } from "./NewProvider.js";

// createProvider, getProviderDescription, getAvailableProviders, getDefaultConfigを更新
```

### src/cli.ts
```typescript
// handleInitCommandのproviders配列、providerNames、switch文を更新
```

### tests/newprovider-provider.test.ts
```typescript
// 上記のテスト例を参照
```

## ベストプラクティス

1. **既存のパターンに従う**: OpenAI互換APIの場合はLMStudioProviderを、カスタムAPIの場合はOllamaProviderを参照
2. **小さく始める**: 最初は基本的な`chatCompletion`から開始
3. **徹底的にテスト**: 単体テスト、統合テスト、実際の使用シナリオ
4. **ドキュメント**: コメント、型定義、READMEを含む
5. **エラーハンドリング**: すべての失敗モードを処理
6. **ログ**: デバッグしやすいログを追加（`[DEBUG]`プレフィックス）
7. **段階的に機能追加**: 基本機能→ストリーミング→ツール呼び出し

## トラブルシューティング

### 接続エラー
- APIキーが正しいか確認
- `baseUrl`が正しいか確認
- ファイアウォール/プロキシ設定を確認

### ツール呼び出しが動作しない
- APIがツール呼び出しをサポートしているか確認
- `tools`パラメータのフォーマットが正しいか確認
- レスポンス構造をログで確認

### ストリーミングエラー
- ストリームを正しく読んでいるか確認
- `reader.releaseLock()`をfinallyブロックで呼ぶ
- チャンクの境界処理が正しいか確認

### テスト失敗
- モックと実際のAPIの違いを確認
- 非同期処理が正しく待機されているか確認
- エラーメッセージを詳細に確認

## 関連リソース

- [ILLMProviderインターフェース](../src/providers/LLMProvider.ts)
- [既存のプロバイダー実装](../src/providers/)
- [LLMProviderFactory](../src/providers/LLMProviderFactory.ts)
- [ModelRegistry](../src/providers/ModelRegistry.ts)
- [テスト例](../tests/)
