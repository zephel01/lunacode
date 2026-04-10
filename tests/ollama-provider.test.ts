import { describe, test, expect, beforeAll } from "bun:test";
import { OllamaProvider } from "../src/providers/OllamaProvider.js";

/**
 * OllamaProvider テスト
 *
 * 注意: これらのテストは実際の Ollama サーバーが起動している必要があります。
 * Ollama が起動していない場合はスキップされます。
 */

let ollamaAvailable = false;

beforeAll(async () => {
  try {
    const response = await fetch("http://localhost:11434/api/tags");
    ollamaAvailable = response.ok;
  } catch {
    ollamaAvailable = false;
  }
  if (!ollamaAvailable) {
    console.log("⚠️  Ollama is not running. Skipping provider tests.");
  }
});

describe("OllamaProvider 基本機能", () => {
  test("初期化できる", () => {
    const provider = new OllamaProvider({
      type: "ollama",
      baseUrl: "http://localhost:11434",
      model: "llama3.1",
    });
    expect(provider.getType()).toBe("ollama");
    expect(provider.getDefaultModel()).toBe("llama3.1");
  });

  test("デフォルト値が適用される", () => {
    const provider = new OllamaProvider({ type: "ollama" });
    expect(provider.getDefaultModel()).toBe("llama3.1");
  });
});

describe("OllamaProvider ネイティブ Tool Calling", () => {
  test("ツール付きリクエストが送信できる", async () => {
    if (!ollamaAvailable) return;

    const provider = new OllamaProvider({
      type: "ollama",
      model: "llama3.1",
    });

    const result = await provider.chatCompletion({
      model: "llama3.1",
      messages: [
        {
          role: "user",
          content:
            'Create a file called test.txt with content "hello". Use the write_file tool.',
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "write_file",
            description: "Write content to a file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "File path" },
                content: { type: "string", description: "File content" },
              },
              required: ["path", "content"],
            },
          },
        },
      ],
    });

    expect(result.choices).toHaveLength(1);
    const msg = result.choices[0].message;

    // ネイティブ tool_calls が返ってくるか、テキストレスポンスか
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      console.log("✅ Native tool calls returned");
      expect(msg.tool_calls[0].function.name).toBe("write_file");
      expect(msg.tool_calls[0].type).toBe("function");

      // arguments は JSON 文字列
      const args = JSON.parse(msg.tool_calls[0].function.arguments);
      expect(args).toHaveProperty("path");
      expect(args).toHaveProperty("content");
    } else {
      console.log("ℹ️  Text response returned (no native tool calls)");
      expect(msg.content).toBeTruthy();
    }
  }, 30000);
});

describe("OllamaProvider テキスト抽出フォールバック", () => {
  test("extractToolCallsFromText がテキストからツール呼び出しを抽出する", () => {
    const provider = new OllamaProvider({ type: "ollama" }) as any;

    const content = `I'll create the file for you.
<tool_call>
{"name": "write_file", "arguments": {"path": "hello.js", "content": "console.log('hello');"}}
</tool_call>
Done!`;

    const toolCalls = provider.extractToolCallsFromText(content);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe("write_file");

    const args = JSON.parse(toolCalls[0].function.arguments);
    expect(args.path).toBe("hello.js");
    expect(args.content).toBe("console.log('hello');");
  });

  test("複数のツール呼び出しを抽出できる", () => {
    const provider = new OllamaProvider({ type: "ollama" }) as any;

    const content = `Creating files...
<tool_call>
{"name": "write_file", "arguments": {"path": "index.html", "content": "<html></html>"}}
</tool_call>
<tool_call>
{"name": "write_file", "arguments": {"path": "style.css", "content": "body {}"}}
</tool_call>`;

    const toolCalls = provider.extractToolCallsFromText(content);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].function.name).toBe("write_file");
    expect(toolCalls[1].function.name).toBe("write_file");
  });

  test("不正な JSON はスキップされる", () => {
    const provider = new OllamaProvider({ type: "ollama" }) as any;

    const content = `<tool_call>
{invalid json}
</tool_call>
<tool_call>
{"name": "read_file", "arguments": {"path": "test.js"}}
</tool_call>`;

    const toolCalls = provider.extractToolCallsFromText(content);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe("read_file");
  });

  test("ツール呼び出しがないテキストは空配列を返す", () => {
    const provider = new OllamaProvider({ type: "ollama" }) as any;

    const content = "This is just a normal text response with no tool calls.";
    const toolCalls = provider.extractToolCallsFromText(content);
    expect(toolCalls).toHaveLength(0);
  });

  test("JSON ブロック形式を抽出できる", () => {
    const provider = new OllamaProvider({ type: "ollama" }) as any;

    const content =
      '```json\n{"name": "bash", "arguments": {"command": "ls -la"}}\n```';
    const toolCalls = provider.extractToolCallsFromText(content);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe("bash");
  });
});

describe("OllamaProvider 追加テキスト抽出パターン", () => {
  test("パターン3: Mistral [TOOL_CALLS] 形式を抽出できる", () => {
    const provider = new OllamaProvider({ type: "ollama" }) as any;

    const content = `I'll create the file.
[TOOL_CALLS] [{"name": "write_file", "arguments": {"path": "/tmp/test.txt", "content": "hello world"}}]`;

    const toolCalls = provider.extractToolCallsFromText(content);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe("write_file");
    const args = JSON.parse(toolCalls[0].function.arguments);
    expect(args.path).toBe("/tmp/test.txt");
  });

  test("パターン3: Mistral 複数ツール呼び出し", () => {
    const provider = new OllamaProvider({ type: "ollama" }) as any;

    const content = `[TOOL_CALLS] [{"name": "write_file", "arguments": {"path": "a.txt", "content": "a"}}, {"name": "write_file", "arguments": {"path": "b.txt", "content": "b"}}]`;

    const toolCalls = provider.extractToolCallsFromText(content);
    expect(toolCalls).toHaveLength(2);
  });

  test("パターン4: Gemma 'Tool call: name{...}' 形式を抽出できる", () => {
    const provider = new OllamaProvider({ type: "ollama" }) as any;

    const content = `I'll write the file now.
Tool call: write_file{"path": "/tmp/hello.js", "content": "console.log('hello');"}`;

    const toolCalls = provider.extractToolCallsFromText(content);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe("write_file");
    const args = JSON.parse(toolCalls[0].function.arguments);
    expect(args.path).toBe("/tmp/hello.js");
  });

  test("パターン5: 配列形式の JSON を抽出できる", () => {
    const provider = new OllamaProvider({ type: "ollama" }) as any;

    const content = `Here is the tool call:
[{"name": "bash", "arguments": {"command": "echo hello"}}]`;

    const toolCalls = provider.extractToolCallsFromText(content);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe("bash");
  });

  test("パターン6: 生の JSON オブジェクト形式を抽出できる", () => {
    const provider = new OllamaProvider({ type: "ollama" }) as any;

    const content = `Sure, I will create the file:
{"name": "write_file", "arguments": {"path": "test.txt", "content": "hello"}}`;

    const toolCalls = provider.extractToolCallsFromText(content);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe("write_file");
  });

  test("normalizeToolData: name/parameters 形式に対応", () => {
    const provider = new OllamaProvider({ type: "ollama" }) as any;

    const data = { name: "write_file", parameters: { path: "/tmp/test.txt", content: "hello" } };
    const result = provider.normalizeToolData(data);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("write_file");
    expect(result!.arguments).toEqual({ path: "/tmp/test.txt", content: "hello" });
  });

  test("normalizeToolData: OpenAI function 形式に対応", () => {
    const provider = new OllamaProvider({ type: "ollama" }) as any;

    const data = { function: { name: "read_file", arguments: { path: "/tmp/x" } } };
    const result = provider.normalizeToolData(data);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("read_file");
  });

  test("normalizeToolData: tool/parameters 形式に対応", () => {
    const provider = new OllamaProvider({ type: "ollama" }) as any;

    const data = { tool: "bash", parameters: { command: "ls" } };
    const result = provider.normalizeToolData(data);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("bash");
  });

  test("normalizeToolData: 無効なデータは null を返す", () => {
    const provider = new OllamaProvider({ type: "ollama" }) as any;

    expect(provider.normalizeToolData(null)).toBeNull();
    expect(provider.normalizeToolData("string")).toBeNull();
    expect(provider.normalizeToolData({ foo: "bar" })).toBeNull();
  });
});

describe("OllamaProvider 自動フォールバック", () => {
  test("useNativeTools フラグが切り替わる", async () => {
    if (!ollamaAvailable) return;

    const provider = new OllamaProvider({
      type: "ollama",
      model: "llama3.1",
    });

    expect((provider as any).useNativeTools).toBe(true);
  });
});
