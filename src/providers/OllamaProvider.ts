import {
  ILLMProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  OllamaConfig,
  ToolCall,
  GenerateResponseOptions,
  defaultGenerateResponse,
} from "./LLMProvider.js";

export class OllamaProvider implements ILLMProvider {
  private baseUrl: string;
  private model: string;
  private config: OllamaConfig;
  private useNativeTools: boolean = true; // ネイティブ Tool Calling を試行するか

  constructor(config: OllamaConfig) {
    this.config = {
      type: "ollama",
      baseUrl: config.baseUrl || "http://localhost:11434",
      model: config.model || "llama3.1",
    };

    this.baseUrl = this.config.baseUrl;
    this.model = this.config.model;
  }

  async chatCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    return this.useNativeTools
      ? this.chatCompletionWithNativeTools(request)
      : this.chatCompletionWithTextExtraction(request);
  }

  /**
   * ネイティブ Tool Calling API を使用
   * 空レスポンスの場合はテキスト抽出方式にフォールバック
   */
  private async chatCompletionWithNativeTools(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const ollamaTools = request.tools?.map((tool) => ({
      type: "function",
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      },
    }));

    const body: Record<string, unknown> = {
      model: request.model || this.model,
      messages: this.convertMessages(request.messages),
      stream: false,
      options: {
        temperature: request.temperature || 0.7,
        num_predict: request.max_tokens || 4096,
      },
    };

    if (ollamaTools && ollamaTools.length > 0) {
      body.tools = ollamaTools;
    }

    console.log(
      `[DEBUG] Ollama request (native): tools=${ollamaTools?.length || 0}, model=${body.model}`,
    );

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      message: {
        role: string;
        content: string;
        tool_calls?: Array<{
          function: {
            name: string;
            arguments: Record<string, unknown>;
          };
        }>;
      };
    };

    const contentLen = data.message.content?.length || 0;
    const nativeToolCalls = data.message.tool_calls?.length || 0;

    console.log(
      `[DEBUG] Ollama response (native): content_length=${contentLen}, native_tool_calls=${nativeToolCalls}`,
    );

    // 空レスポンス検出: content も tool_calls もない → モデルが非対応
    if (contentLen === 0 && nativeToolCalls === 0) {
      console.log(
        `[DEBUG] ⚠️ Empty response with native tools. Switching to text extraction mode for model: ${this.model}`,
      );
      this.useNativeTools = false;
      return this.chatCompletionWithTextExtraction(request);
    }

    let toolCalls: ToolCall[] = [];

    if (data.message.tool_calls && data.message.tool_calls.length > 0) {
      toolCalls = data.message.tool_calls.map((tc, i) => ({
        id: `tool_${i}_${Date.now()}`,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments:
            typeof tc.function.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments),
        },
      }));

      console.log(
        `[DEBUG] Native tool calls: ${toolCalls.length} calls`,
      );
      toolCalls.forEach((tc) => {
        console.log(`[DEBUG]   ✅ ${tc.function.name}`);
      });
    } else if (data.message.content) {
      toolCalls = this.extractToolCallsFromText(data.message.content);
      if (toolCalls.length > 0) {
        console.log(
          `[DEBUG] Text-extracted tool calls: ${toolCalls.length} calls`,
        );
      }
    }

    return {
      id: `ollama-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.model || this.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: toolCalls.length > 0 ? null : data.message.content,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        },
      ],
    };
  }

  /**
   * テキスト抽出方式（ネイティブ非対応モデル用フォールバック）
   * tools パラメータを送信せず、システムプロンプトで指示
   */
  private async chatCompletionWithTextExtraction(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    // ツール説明をシステムプロンプトに注入
    const toolDescriptions = request.tools
      ?.map(
        (t) =>
          `- ${t.function.name}: ${t.function.description}\n  Parameters: ${JSON.stringify(t.function.parameters)}`,
      )
      .join("\n");

    const toolInstructions = toolDescriptions
      ? `\n\nWhen you need to use a tool, format your response EXACTLY like this:\n<tool_call>\n{"name": "tool_name", "arguments": {"param1": "value1"}}\n</tool_call>\n\nAvailable tools:\n${toolDescriptions}`
      : "";

    // システムメッセージにツール指示を追加
    const messages = request.messages.map((msg) => {
      if (msg.role === "system") {
        return { ...msg, content: msg.content + toolInstructions };
      }
      return msg;
    });

    const body: Record<string, unknown> = {
      model: request.model || this.model,
      messages: this.convertMessages(messages),
      stream: false,
      options: {
        temperature: request.temperature || 0.7,
        num_predict: request.max_tokens || 4096,
      },
    };

    console.log(
      `[DEBUG] Ollama request (text-extraction fallback): model=${body.model}`,
    );

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      message: { role: string; content: string };
    };

    console.log(
      `[DEBUG] Ollama response (text-extraction): content_length=${data.message.content?.length || 0}`,
    );

    let toolCalls: ToolCall[] = [];

    if (data.message.content) {
      toolCalls = this.extractToolCallsFromText(data.message.content);
      if (toolCalls.length > 0) {
        console.log(
          `[DEBUG] Text-extracted tool calls: ${toolCalls.length} calls`,
        );
        toolCalls.forEach((tc) => {
          console.log(`[DEBUG]   ✅ ${tc.function.name}`);
        });
      }
    }

    return {
      id: `ollama-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.model || this.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: toolCalls.length > 0 ? null : data.message.content,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        },
      ],
    };
  }

  /**
   * メッセージを Ollama API 形式に変換
   * tool ロールのメッセージを適切に変換
   */
  private convertMessages(messages: any[]): any[] {
    return messages.map((msg) => {
      const converted: Record<string, unknown> = {
        role: msg.role,
        content: msg.content || "",
      };

      // tool_calls がある場合（assistant メッセージ）
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        converted.tool_calls = msg.tool_calls.map((tc: ToolCall) => ({
          function: {
            name: tc.function.name,
            arguments:
              typeof tc.function.arguments === "string"
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments,
          },
        }));
      }

      return converted;
    });
  }

  /**
   * フォールバック: テキストからツール呼び出しを抽出
   * ネイティブ Tool Calling をサポートしないモデル向け
   * 複数のフォーマットパターンに対応
   */
  private extractToolCallsFromText(content: string): ToolCall[] {
    const toolCalls: ToolCall[] = [];
    let match;

    // パターン1: <tool_call>...</tool_call> タグ形式
    const toolCallPattern =
      /<tool_call>\s*\n?\s*([\s\S]*?)\s*\n?\s*<\/tool_call>/g;

    while ((match = toolCallPattern.exec(content)) !== null) {
      const parsed = this.tryParseToolCall(match[1].trim());
      if (parsed) toolCalls.push(this.createToolCall(toolCalls.length, parsed));
    }

    // パターン2: JSON ブロック形式 (バックティック囲い)
    if (toolCalls.length === 0) {
      const jsonBlockPattern = /```(?:json)?\s*([\s\S]*?)\s*```/g;
      while ((match = jsonBlockPattern.exec(content)) !== null) {
        const parsed = this.tryParseToolCall(match[1].trim());
        if (parsed) toolCalls.push(this.createToolCall(toolCalls.length, parsed));
      }
    }

    // パターン3: Mistral [TOOL_CALLS] 形式
    // 例: [TOOL_CALLS] [{"name": "write_file", "arguments": {...}}]
    if (toolCalls.length === 0) {
      const mistralPattern = /\[TOOL_CALLS\]\s*(\[[\s\S]*?\])/gi;
      while ((match = mistralPattern.exec(content)) !== null) {
        try {
          const arr = JSON.parse(match[1]);
          if (Array.isArray(arr)) {
            for (const item of arr) {
              const parsed = this.normalizeToolData(item);
              if (parsed) toolCalls.push(this.createToolCall(toolCalls.length, parsed));
            }
          }
        } catch (e) {
          // パースエラーは継続
        }
      }
    }

    // パターン4: Gemma "Tool call: name{...}" 形式
    // 例: Tool call: write_file{"path": "/tmp/test.txt", "content": "hello"}
    if (toolCalls.length === 0) {
      const gemmaPattern = /Tool\s*call:\s*(\w+)\s*(\{[\s\S]*?\})/gi;
      while ((match = gemmaPattern.exec(content)) !== null) {
        try {
          const args = JSON.parse(match[2]);
          toolCalls.push(this.createToolCall(toolCalls.length, {
            name: match[1],
            arguments: args,
          }));
        } catch (e) {
          // パースエラーは継続
        }
      }
    }

    // パターン5: Mistral 関数呼び出し形式
    // 例: [{"name": "write_file", "arguments": {...}}]
    if (toolCalls.length === 0) {
      const arrayPattern = /(?:^|\n)\s*(\[\s*\{[\s\S]*?"name"\s*:[\s\S]*?\}\s*\])/g;
      while ((match = arrayPattern.exec(content)) !== null) {
        try {
          const arr = JSON.parse(match[1]);
          if (Array.isArray(arr)) {
            for (const item of arr) {
              const parsed = this.normalizeToolData(item);
              if (parsed) toolCalls.push(this.createToolCall(toolCalls.length, parsed));
            }
          }
        } catch (e) {
          // パースエラーは継続
        }
      }
    }

    // パターン6: 生の JSON オブジェクト（最終手段）
    // テキスト中の {"name": "...", "arguments": {...}} を直接検出
    if (toolCalls.length === 0) {
      const rawJsonPattern = /\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
      while ((match = rawJsonPattern.exec(content)) !== null) {
        try {
          const args = JSON.parse(match[2]);
          toolCalls.push(this.createToolCall(toolCalls.length, {
            name: match[1],
            arguments: args,
          }));
        } catch (e) {
          // パースエラーは継続
        }
      }
    }

    if (toolCalls.length > 0) {
      console.log(`[DEBUG] Extracted ${toolCalls.length} tool call(s) using text patterns`);
    }

    return toolCalls;
  }

  /**
   * JSON テキストをツール呼び出しデータとしてパース試行
   */
  private tryParseToolCall(text: string): { name: string; arguments: Record<string, unknown> } | null {
    try {
      const data = JSON.parse(text);
      return this.normalizeToolData(data);
    } catch {
      return null;
    }
  }

  /**
   * 様々なフォーマットのツールデータを正規化
   * { name, arguments } / { function: { name, arguments } } / { tool: name, ... } に対応
   */
  private normalizeToolData(data: any): { name: string; arguments: Record<string, unknown> } | null {
    if (!data || typeof data !== "object") return null;

    // 標準形式: { name, arguments }
    if (data.name && data.arguments) {
      return { name: data.name, arguments: data.arguments };
    }
    // 代替形式: { name, parameters } (llama3.1 リトライ時など)
    if (data.name && data.parameters) {
      return { name: data.name, arguments: data.parameters };
    }
    // OpenAI 形式: { function: { name, arguments } }
    if (data.function?.name && data.function?.arguments) {
      return { name: data.function.name, arguments: data.function.arguments };
    }
    // OpenAI 代替形式: { function: { name, parameters } }
    if (data.function?.name && data.function?.parameters) {
      return { name: data.function.name, arguments: data.function.parameters };
    }
    // 代替形式: { tool: "name", parameters: {...} }
    if (data.tool && data.parameters) {
      return { name: data.tool, arguments: data.parameters };
    }
    // 代替形式: { action: "name", params: {...} }
    if (data.action && data.params) {
      return { name: data.action, arguments: data.params };
    }
    return null;
  }

  /**
   * ToolCall オブジェクトを生成
   */
  private createToolCall(index: number, data: { name: string; arguments: Record<string, unknown> }): ToolCall {
    return {
      id: `tool_${index}_${Date.now()}`,
      type: "function",
      function: {
        name: data.name,
        arguments: typeof data.arguments === "string"
          ? data.arguments
          : JSON.stringify(data.arguments),
      },
    };
  }

  async generateResponse(
    prompt: string,
    options?: GenerateResponseOptions,
  ): Promise<string> {
    return defaultGenerateResponse(this, prompt, options);
  }

  getType(): "ollama" {
    return "ollama";
  }

  getDefaultModel(): string {
    return this.model;
  }

  async initialize(): Promise<void> {
    await this.testConnection();
  }

  async cleanup(): Promise<void> {
    // クリーンアップ
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch (error) {
      console.error("Ollama connection test failed:", error);
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      const data = (await response.json()) as {
        models: Array<{ name: string }>;
      };
      return data.models.map((model) => model.name);
    } catch (error) {
      console.error("Failed to list Ollama models:", error);
      return [];
    }
  }
}
