import {
  ILLMProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  OllamaConfig,
  ToolCall,
  ChatMessage,
  GenerateResponseOptions,
  defaultGenerateResponse,
} from "./LLMProvider.js";
import { StreamChunk } from "../types/index.js";
import { Logger } from "../utils/Logger.js";
import type pino from "pino";

export class OllamaProvider implements ILLMProvider {
  private baseUrl: string;
  private model: string;
  private config: OllamaConfig;
  private useNativeTools: boolean = true; // ネイティブ Tool Calling を試行するか
  /** リクエストタイムアウト（ミリ秒）。デフォルト 5 分 */
  private requestTimeout: number;
  private log: pino.Logger;

  constructor(config: OllamaConfig) {
    const baseUrl = config.baseUrl ?? "http://localhost:11434";
    const model = config.model ?? "llama3.1";

    this.config = {
      type: "ollama",
      baseUrl,
      model,
    };

    this.baseUrl = baseUrl;
    this.model = model;
    this.requestTimeout = config.requestTimeout ?? 300_000; // デフォルト 5 分
    this.log = Logger.get("OllamaProvider");
  }

  /**
   * タイムアウト付き fetch ヘルパー
   * AbortController で指定 ms 後に自動キャンセル
   */
  private fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number = this.requestTimeout,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal }).finally(() =>
      clearTimeout(timer),
    );
  }

  async chatCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    return this.useNativeTools
      ? this.chatCompletionWithNativeTools(request)
      : this.chatCompletionWithTextExtraction(request);
  }

  supportsStreaming(): boolean {
    return true;
  }

  /**
   * ストリーミング対応チャットコンプリション
   * Ollama の /api/chat エンドポイントをストリーミングモードで使用
   */
  async *chatCompletionStream(
    request: ChatCompletionRequest,
  ): AsyncGenerator<StreamChunk> {
    try {
      // テキスト抽出モードの場合、ツール指示をシステムプロンプトに注入
      let effectiveRequest = request;
      if (!this.useNativeTools && request.tools && request.tools.length > 0) {
        const toolDescriptions = request.tools
          .map((t) => {
            const params = this.formatParametersForPrompt(
              t.function.parameters,
            );
            return `- ${t.function.name}: ${t.function.description}\n  Parameters: ${params}`;
          })
          .join("\n");

        const toolInstructions = `\n\nWhen you need to use a tool, format your response EXACTLY like this:\n<tool_call>\n{"name": "tool_name", "arguments": {"param1": "value1"}}\n</tool_call>\n\nAvailable tools:\n${toolDescriptions}`;

        const messages = request.messages.map((msg) => {
          if (msg.role === "system") {
            return { ...msg, content: msg.content + toolInstructions };
          }
          return msg;
        });

        effectiveRequest = { ...request, messages };
        this.log.debug(
          `Streaming with text-extraction mode: tool instructions injected into system prompt`,
        );
      }

      const body = this.buildRequestBody(effectiveRequest, true);

      this.log.debug(
        `Ollama streaming request: model=${body.model}, stream=true, useNativeTools=${this.useNativeTools}`,
      );

      const response = await this.fetchWithTimeout(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        // ネイティブモードで Bad Request → モデルが tools パラメータ非対応
        // テキスト抽出モードにフォールバックしてリトライ
        if (this.useNativeTools && response.status === 400) {
          this.log.debug(
            `⚠️ Ollama returned 400 Bad Request with native tools. Model may not support tool calling. Switching to text extraction mode.`,
          );
          this.useNativeTools = false;
          // ストリーミングを再帰的にやり直す（今度は tools なしで）
          yield* this.chatCompletionStream(request);
          return;
        }
        throw new Error(`Ollama API error: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error("Response body is null");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";
      let promptTokens = 0;
      let completionTokens = 0;
      let evalDurationMs = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (!line.trim()) continue;

            try {
              const json = JSON.parse(line);

              // コンテンツチャンク
              if (json.message?.content) {
                const content = json.message.content;
                fullContent += content;
                yield {
                  type: "content",
                  delta: content,
                };
              }

              // ストリーム終了時のトークンカウント
              if (json.done === true) {
                promptTokens = json.prompt_eval_count || 0;
                completionTokens = json.eval_count || 0;
                // eval_duration はナノ秒単位なのでミリ秒に変換
                evalDurationMs = json.eval_duration
                  ? Math.round(json.eval_duration / 1_000_000)
                  : 0;

                let streamToolCalls: Array<{
                  id: string;
                  type: "function";
                  function: { name: string; arguments: string };
                }> = [];

                // ネイティブツールモードでの tool_calls
                if (this.useNativeTools && json.message?.tool_calls) {
                  streamToolCalls = json.message.tool_calls.map(
                    (
                      tc: {
                        function: {
                          name: string;
                          arguments: Record<string, unknown>;
                        };
                      },
                      i: number,
                    ) => ({
                      id: `tool_${i}_${Date.now()}`,
                      type: "function" as const,
                      function: {
                        name: tc.function.name,
                        arguments:
                          typeof tc.function.arguments === "string"
                            ? tc.function.arguments
                            : JSON.stringify(tc.function.arguments),
                      },
                    }),
                  );

                  if (streamToolCalls.length > 0) {
                    this.log.debug(
                      `Native tool calls in stream: ${streamToolCalls.length}`,
                    );
                  }
                }

                // ネイティブ tool_calls がなかった場合 → テキスト抽出にフォールバック
                // （useNativeTools の状態に関係なく、テキスト内の <tool_call> を常にチェック）
                if (streamToolCalls.length === 0 && fullContent) {
                  const extractedCalls =
                    this.extractToolCallsFromText(fullContent);
                  if (extractedCalls.length > 0) {
                    this.log.debug(
                      `Extracted ${extractedCalls.length} tool call(s) from streamed content (fallback)`,
                    );
                    streamToolCalls = extractedCalls as typeof streamToolCalls;
                  }
                }

                // 空レスポンス検出: ネイティブモードで content も tool_calls もない
                // → 次回以降テキスト抽出モードに切り替え
                if (
                  this.useNativeTools &&
                  !fullContent &&
                  streamToolCalls.length === 0
                ) {
                  this.log.debug(
                    `⚠️ Empty streaming response with native tools. Switching to text extraction mode for model: ${request.model || this.model}`,
                  );
                  this.useNativeTools = false;
                }

                // ツール呼び出しを yield
                for (const toolCall of streamToolCalls) {
                  yield {
                    type: "tool_call_start",
                    toolCall,
                  };
                  yield {
                    type: "tool_call_end",
                  };
                }

                // 完了チャンク
                yield {
                  type: "done",
                  usage: {
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                    total_tokens: promptTokens + completionTokens,
                    ...(evalDurationMs > 0
                      ? { durationMs: evalDurationMs }
                      : {}),
                  },
                };
              }
            } catch (e) {
              // JSON パースエラーは無視（部分的なチャンクの場合がある）
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[ERROR] Streaming error: ${errorMsg}`);
      yield {
        type: "error",
        error: errorMsg,
      };
    }
  }

  /**
   * リクエストボディを構築（共通処理）
   */
  private buildRequestBody(
    request: ChatCompletionRequest,
    stream: boolean = false,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model || this.model,
      messages: this.convertMessages(request.messages),
      stream,
      options: {
        temperature: request.temperature || 0.7,
        // -1 = Ollama の無制限生成（モデルのコンテキストウィンドウまで）
        // ユーザーが max_tokens を明示した場合のみその値を使う
        num_predict: request.max_tokens ?? -1,
      },
    };

    if (this.useNativeTools) {
      const ollamaTools = request.tools?.map((tool) => ({
        type: "function",
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        },
      }));

      if (ollamaTools && ollamaTools.length > 0) {
        body.tools = ollamaTools;
      }
    }

    return body;
  }

  /**
   * ネイティブ Tool Calling API を使用
   * 空レスポンスの場合はテキスト抽出方式にフォールバック
   */
  private async chatCompletionWithNativeTools(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const body = this.buildRequestBody(request, false);

    this.log.debug(
      `Ollama request (native): tools=${(body.tools as unknown[])?.length || 0}, model=${body.model}`,
    );

    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // ネイティブモードで 400 → tools パラメータ非対応、テキスト抽出にフォールバック
      if (response.status === 400) {
        this.log.debug(
          `⚠️ Ollama returned 400 Bad Request with native tools. Switching to text extraction mode.`,
        );
        this.useNativeTools = false;
        return this.chatCompletionWithTextExtraction(request);
      }
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

    this.log.debug(
      `Ollama response (native): content_length=${contentLen}, native_tool_calls=${nativeToolCalls}`,
    );

    // 空レスポンス検出: content も tool_calls もない → モデルが非対応
    if (contentLen === 0 && nativeToolCalls === 0) {
      this.log.debug(
        `⚠️ Empty response with native tools. Switching to text extraction mode for model: ${this.model}`,
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

      this.log.debug(`Native tool calls: ${toolCalls.length} calls`);
      toolCalls.forEach((tc) => {
        this.log.debug(`  ✅ ${tc.function.name}`);
      });
    } else if (data.message.content) {
      toolCalls = this.extractToolCallsFromText(data.message.content);
      if (toolCalls.length > 0) {
        this.log.debug(`Text-extracted tool calls: ${toolCalls.length} calls`);
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
    // description にインライン例が含まれている場合はそれを活用し、
    // パラメータスキーマは簡潔な形式で表示
    const toolDescriptions = request.tools
      ?.map((t) => {
        const params = this.formatParametersForPrompt(t.function.parameters);
        return `- ${t.function.name}: ${t.function.description}\n  Parameters: ${params}`;
      })
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

    const modifiedRequest = { ...request, messages };
    const body = this.buildRequestBody(modifiedRequest, false);

    this.log.debug(
      `Ollama request (text-extraction fallback): model=${body.model}`,
    );

    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/chat`, {
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

    this.log.debug(
      `Ollama response (text-extraction): content_length=${data.message.content?.length || 0}`,
    );

    let toolCalls: ToolCall[] = [];

    if (data.message.content) {
      toolCalls = this.extractToolCallsFromText(data.message.content);
      if (toolCalls.length > 0) {
        this.log.debug(`Text-extracted tool calls: ${toolCalls.length} calls`);
        toolCalls.forEach((tc) => {
          this.log.debug(`  ✅ ${tc.function.name}`);
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
  private convertMessages(messages: ChatMessage[]): Record<string, unknown>[] {
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

    // パターン1b: <tool_call> タグはあるが </tool_call> がない場合
    // （モデルが大きな JSON を生成したが閉じタグを付けなかった場合）
    if (toolCalls.length === 0) {
      const openTagPattern = /<tool_call>\s*\n?\s*\{/g;
      while ((match = openTagPattern.exec(content)) !== null) {
        const jsonStart = content.indexOf("{", match.index);
        if (jsonStart !== -1) {
          const jsonStr = this.extractBalancedJson(content, jsonStart);
          if (jsonStr) {
            const parsed = this.tryParseToolCall(jsonStr);
            if (parsed) {
              this.log.debug(
                "[DEBUG] Pattern 1b: extracted tool call from unclosed <tool_call> tag",
              );
              toolCalls.push(this.createToolCall(toolCalls.length, parsed));
            }
          }
        }
      }
    }

    // パターン2: JSON ブロック形式 (バックティック囲い)
    if (toolCalls.length === 0) {
      const jsonBlockPattern = /```(?:json)?\s*([\s\S]*?)\s*```/g;
      while ((match = jsonBlockPattern.exec(content)) !== null) {
        const parsed = this.tryParseToolCall(match[1].trim());
        if (parsed)
          toolCalls.push(this.createToolCall(toolCalls.length, parsed));
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
              if (parsed)
                toolCalls.push(this.createToolCall(toolCalls.length, parsed));
            }
          }
        } catch (e) {
          // パースエラーは継続
        }
      }
    }

    // パターン4: Gemma "Tool call: name{...}" 形式
    // 例: Tool call: write_file{"path": "/tmp/test.txt", "content": "hello"}
    // ネストされた JSON（配列・オブジェクト）にも対応するためブレースバランスで抽出
    if (toolCalls.length === 0) {
      const gemmaHeaderPattern = /Tool\s*call:\s*(\w+)\s*\{/gi;
      while ((match = gemmaHeaderPattern.exec(content)) !== null) {
        try {
          const jsonStart = match.index + match[0].length - 1; // '{' の位置
          const jsonStr = this.extractBalancedJson(content, jsonStart);
          if (jsonStr) {
            const args = JSON.parse(jsonStr);
            toolCalls.push(
              this.createToolCall(toolCalls.length, {
                name: match[1],
                arguments: args,
              }),
            );
          }
        } catch (e) {
          // パースエラーは継続
        }
      }
    }

    // パターン5: Mistral 関数呼び出し形式
    // 例: [{"name": "write_file", "arguments": {...}}]
    if (toolCalls.length === 0) {
      const arrayPattern =
        /(?:^|\n)\s*(\[\s*\{[\s\S]*?"name"\s*:[\s\S]*?\}\s*\])/g;
      while ((match = arrayPattern.exec(content)) !== null) {
        try {
          const arr = JSON.parse(match[1]);
          if (Array.isArray(arr)) {
            for (const item of arr) {
              const parsed = this.normalizeToolData(item);
              if (parsed)
                toolCalls.push(this.createToolCall(toolCalls.length, parsed));
            }
          }
        } catch (e) {
          // パースエラーは継続
        }
      }
    }

    // パターン6: 生の JSON オブジェクト（最終手段）
    // テキスト中の {"name": "...", "arguments": {...}} を直接検出
    // ネストされた arguments にも対応するためブレースバランスで抽出
    if (toolCalls.length === 0) {
      const rawJsonHeaderPattern =
        /\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*\{/g;
      while ((match = rawJsonHeaderPattern.exec(content)) !== null) {
        try {
          // "arguments": { の '{' から開始してバランスの取れた JSON を抽出
          const argsStart = content.indexOf(
            "{",
            match.index + match[0].length - 1,
          );
          const argsStr = this.extractBalancedJson(content, argsStart);
          if (argsStr) {
            const args = JSON.parse(argsStr);
            toolCalls.push(
              this.createToolCall(toolCalls.length, {
                name: match[1],
                arguments: args,
              }),
            );
          }
        } catch (e) {
          // パースエラーは継続
        }
      }
    }

    if (toolCalls.length > 0) {
      this.log.debug(
        `Extracted ${toolCalls.length} tool call(s) using text patterns`,
      );
    }

    return toolCalls;
  }

  /**
   * パラメータスキーマをプロンプト用の簡潔な形式に変換
   * ネストが深い場合は要約し、LLM が理解しやすい記述にする
   */
  private formatParametersForPrompt(
    schema: Record<string, unknown> | undefined,
  ): string {
    if (!schema || !schema.properties) return "{}";

    const parts: string[] = [];
    type SchemaProp = {
      type?: string;
      enum?: unknown[];
      items?: { type?: string; properties?: Record<string, SchemaProp> };
    };
    for (const [key, prop] of Object.entries(schema.properties) as [
      string,
      SchemaProp,
    ][]) {
      const required = (schema.required as string[] | undefined)?.includes(key)
        ? " (required)"
        : "";

      if (prop.type === "array" && prop.items?.type === "object") {
        // ネストされた配列オブジェクトは簡潔に記述
        const itemProps = prop.items.properties
          ? Object.entries(prop.items.properties)
              .map(([k, v]: [string, SchemaProp]) => {
                const enumValues = v.enum ? ` [${v.enum.join("|")}]` : "";
                return `${k}: ${v.type}${enumValues}`;
              })
              .join(", ")
          : "...";
        parts.push(`${key}: array of {${itemProps}}${required}`);
      } else if (prop.enum) {
        parts.push(`${key}: ${prop.type} [${prop.enum.join("|")}]${required}`);
      } else {
        parts.push(`${key}: ${prop.type}${required}`);
      }
    }
    return `{${parts.join(", ")}}`;
  }

  /**
   * テキスト中のバランスの取れた JSON オブジェクトを抽出
   * ネストされた {} や [] を正しくハンドリングする
   */
  private extractBalancedJson(text: string, startIndex: number): string | null {
    if (
      startIndex < 0 ||
      startIndex >= text.length ||
      text[startIndex] !== "{"
    ) {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < text.length; i++) {
      const ch = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === "\\") {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === "{" || ch === "[") {
        depth++;
      } else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          return text.substring(startIndex, i + 1);
        }
      }
    }

    return null; // バランスが取れていない
  }

  /**
   * JSON テキストをツール呼び出しデータとしてパース試行
   */
  private tryParseToolCall(
    text: string,
  ): { name: string; arguments: Record<string, unknown> } | null {
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
  private normalizeToolData(
    data: Record<string, unknown>,
  ): { name: string; arguments: Record<string, unknown> } | null {
    if (!data || typeof data !== "object") return null;

    type FnShape = {
      name?: string;
      arguments?: Record<string, unknown>;
      parameters?: Record<string, unknown>;
    };

    // 標準形式: { name, arguments }
    if (data.name && data.arguments) {
      return {
        name: data.name as string,
        arguments: data.arguments as Record<string, unknown>,
      };
    }
    // 代替形式: { name, parameters } (llama3.1 リトライ時など)
    if (data.name && data.parameters) {
      return {
        name: data.name as string,
        arguments: data.parameters as Record<string, unknown>,
      };
    }
    // OpenAI 形式: { function: { name, arguments } }
    const fn = data.function as FnShape | undefined;
    if (fn?.name && fn?.arguments) {
      return { name: fn.name, arguments: fn.arguments };
    }
    // OpenAI 代替形式: { function: { name, parameters } }
    if (fn?.name && fn?.parameters) {
      return { name: fn.name, arguments: fn.parameters };
    }
    // 代替形式: { tool: "name", parameters: {...} }
    if (data.tool && data.parameters) {
      return {
        name: data.tool as string,
        arguments: data.parameters as Record<string, unknown>,
      };
    }
    // 代替形式: { action: "name", params: {...} }
    if (data.action && data.params) {
      return {
        name: data.action as string,
        arguments: data.params as Record<string, unknown>,
      };
    }
    return null;
  }

  /**
   * ToolCall オブジェクトを生成
   */
  private createToolCall(
    index: number,
    data: { name: string; arguments: Record<string, unknown> },
  ): ToolCall {
    return {
      id: `tool_${index}_${Date.now()}`,
      type: "function",
      function: {
        name: data.name,
        arguments:
          typeof data.arguments === "string"
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
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/api/tags`,
        {},
        10_000, // 接続確認は 10 秒で十分
      );
      return response.ok;
    } catch (error) {
      console.error("Ollama connection test failed:", error);
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/api/tags`,
        {},
        10_000,
      );
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
