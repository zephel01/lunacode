import { ToolRegistry } from "../tools/ToolRegistry.js";
import { MemorySystem } from "../memory/MemorySystem.js";
import { AgentMessage, AgentState, LoadedSkill } from "../types/index.js";
import {
  ILLMProvider,
  ChatCompletionRequest,
  ChatMessage,
} from "../providers/LLMProvider.js";
import { ConfigManager } from "../config/ConfigManager.js";
import { SkillLoader } from "../skills/SkillLoader.js";

export class AgentLoop {
  private toolRegistry: ToolRegistry;
  private memorySystem: MemorySystem;
  private llmProvider: ILLMProvider;
  private configManager: ConfigManager;
  private skillLoader: SkillLoader;
  private messages: AgentMessage[];
  private state: AgentState;
  private maxIterations: number = 50;
  private activeSkills: LoadedSkill[] = [];  // 現在アクティブなスキル

  constructor(
    llmProvider: ILLMProvider,
    basePath: string,
    configManager?: ConfigManager,
  ) {
    this.llmProvider = llmProvider;
    this.toolRegistry = new ToolRegistry();
    this.memorySystem = new MemorySystem(basePath);
    this.configManager = configManager || new ConfigManager(basePath);
    this.skillLoader = new SkillLoader(basePath);
    this.messages = [];
    this.state = {
      phase: "INIT",
      thought: "",
      action: null,
      observation: null,
      iteration: 0,
      maxIterations: this.maxIterations,
    };
  }

  async initialize(): Promise<void> {
    await this.memorySystem.initialize();
    await this.llmProvider.initialize();
    await this.configManager.load();
    await this.skillLoader.loadAll();
  }

  /**
   * スキルローダーを取得（CLI 等からのアクセス用）
   */
  getSkillLoader(): SkillLoader {
    return this.skillLoader;
  }

  /**
   * 手動でスキルをアクティブにする
   */
  activateSkill(name: string): boolean {
    const skill = this.skillLoader.getSkill(name);
    if (!skill) return false;
    if (!this.activeSkills.find((s) => s.manifest.name === name)) {
      this.activeSkills.push(skill);

      // スキルが追加ツールを持つ場合は登録
      for (const tool of skill.tools) {
        this.toolRegistry.register(tool);
      }
    }
    return true;
  }

  async processUserInput(userInput: string): Promise<string> {
    this.messages.push({
      role: "user",
      content: userInput,
    });

    // 設定をロード
    const agentConfig = this.configManager.getAgentConfig();
    this.maxIterations = agentConfig.maxIterations;
    this.state.maxIterations = agentConfig.maxIterations;

    // メモリから関連情報を最適化検索で取得（Phase 1）
    const searchResults = await this.memorySystem.searchMemory(userInput, 5);
    const relevantContext = searchResults.map((r) => r.content).join("\n");

    // メインメモリと最近のログも取得
    const memoryContent = await this.memorySystem.readMemory();
    const recentLogs = await this.memorySystem.getRecentLogs(7);

    // スキル自動検出: ユーザー入力からマッチするスキルを見つける
    const skillMatches = this.skillLoader.findRelevantSkills(userInput);
    for (const match of skillMatches) {
      if (!this.activeSkills.find((s) => s.manifest.name === match.skill.manifest.name)) {
        this.activeSkills.push(match.skill);
        console.log(`🎯 Auto-detected skill: ${match.skill.manifest.name} (triggers: ${match.matchedTriggers.join(", ")})`);

        // 追加ツールがあれば登録
        for (const tool of match.skill.tools) {
          this.toolRegistry.register(tool);
        }
      }
    }

    // スキルのプロンプト注入
    const skillPrompt = this.skillLoader.formatSkillsForPrompt(this.activeSkills);

    const systemMessage = `You are LunaCode, an autonomous coding agent inspired by Claude Code.
You have access to tools to help with coding tasks.
Always think before acting, and use tools when appropriate.
You MUST use tools to create, read, and edit files. Do NOT just describe what you would do - actually use the tools.

Available tools:
${this.toolRegistry.getToolDescriptions()}
${skillPrompt}
Current project context (from memory):
${memoryContent}

Relevant search results:
${relevantContext}

Recent activity logs:
${recentLogs}

Follow the ReAct pattern:
1. Thought: Think about what you need to do
2. Action: Choose a tool to execute
3. Observation: Analyze the tool output
4. Repeat until the task is complete

When you have enough information, provide a clear, concise response to the user.`;

    // システムメッセージの重複追加を防止
    const existingSystemIndex = this.messages.findIndex(
      (m) => m.role === "system",
    );
    if (existingSystemIndex >= 0) {
      this.messages[existingSystemIndex] = {
        role: "system",
        content: systemMessage,
      };
    } else {
      this.messages.unshift({
        role: "system",
        content: systemMessage,
      });
    }

    return await this.runLoop();
  }

  private retryCount: number = 0;
  private maxRetries: number = 2; // ツール未検出時のリトライ上限

  private async runLoop(): Promise<string> {
    let response = "";

    while (this.state.iteration < this.state.maxIterations) {
      try {
        this.state.phase = "THINKING";
        this.state.iteration++;

        // ツールを定義
        const tools = this.toolRegistry.getAll().map((tool) => ({
          type: "function" as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));

        const request: ChatCompletionRequest = {
          model: this.llmProvider.getDefaultModel(),
          messages: this.messages as ChatMessage[],
          tools,
          stream: false,
        };

        const completion = await this.llmProvider.chatCompletion(request);
        const assistantMessage = completion.choices[0].message;

        // デバッグ: LLMレスポンスをログ
        console.log(
          `\n[DEBUG] LLM Response - Content: ${assistantMessage.content?.substring(0, 100) || "(empty)"}...`,
        );
        console.log(
          `[DEBUG] Tool calls detected: ${assistantMessage.tool_calls?.length || 0}`,
        );

        this.messages.push({
          role: "assistant",
          content: assistantMessage.content || "",
        });

        // ツールコールがある場合は実行
        if (
          assistantMessage.tool_calls &&
          assistantMessage.tool_calls.length > 0
        ) {
          this.state.phase = "ACTING";
          this.retryCount = 0; // ツール検出成功でリトライカウンタリセット

          for (const toolCall of assistantMessage.tool_calls) {
            if (toolCall.type === "function") {
              this.state.action = toolCall.function.name;
              this.state.thought = assistantMessage.content || "";

              console.log(`\n🤖 ${this.state.thought}`);
              console.log(`🔧 Executing: ${toolCall.function.name}`);

              let parsedArgs: Record<string, unknown>;
              try {
                parsedArgs = JSON.parse(toolCall.function.arguments);
              } catch (parseError) {
                console.error(
                  `Failed to parse tool arguments for ${toolCall.function.name}:`,
                  parseError,
                );
                this.messages.push({
                  role: "tool",
                  content: `Error: Invalid JSON in tool arguments: ${toolCall.function.arguments}`,
                  toolCallId: toolCall.id,
                });
                continue;
              }

              console.log(
                `[DEBUG] Executing tool with args: ${JSON.stringify(parsedArgs)}`,
              );

              const toolResult = await this.toolRegistry.executeTool(
                toolCall.function.name,
                parsedArgs,
              );

              this.state.observation = toolResult.success
                ? toolResult.output
                : toolResult.error || "Error";

              console.log(
                `[DEBUG] Tool result - Success: ${toolResult.success}, Output length: ${this.state.observation.length}`,
              );
              console.log(
                `📊 Observation: ${this.state.observation.substring(0, 200)}...`,
              );

              this.messages.push({
                role: "tool",
                content: this.state.observation,
                toolCallId: toolCall.id,
              });

              // ログに記録
              await this.memorySystem.appendToLog(
                `[${new Date().toISOString()}] Tool: ${toolCall.function.name}, Result: ${toolResult.success ? "Success" : "Failed"}`,
              );
            }
          }
        } else {
          // ツールコールがない場合
          const content = assistantMessage.content || "";

          // リトライ条件:
          // 1. ループ開始直後（iteration 1〜3）のみ
          // 2. まだリトライ回数に余裕がある
          // 3. レスポンスが短い（= タスク完了の説明文ではない）
          //    長い説明文（200文字超）はタスク完了のサインなのでリトライしない
          const isEarlyPhase = this.state.iteration <= 3;
          const isShortResponse = content.length < 200;
          if (this.retryCount < this.maxRetries && isEarlyPhase && isShortResponse) {
            this.retryCount++;
            console.log(
              `[DEBUG] ⚠️ No tool calls detected. Retry ${this.retryCount}/${this.maxRetries} with stronger prompt`,
            );

            // 前回の assistant メッセージを残しつつ、強制的にツール使用を促すメッセージを追加
            const retryPrompts = [
              // リトライ1回目: 具体的な書式例を提示
              `You did not use any tools. You MUST respond with a tool call to complete the task.

For example, to create a file, respond EXACTLY in this format:
<tool_call>
{"name": "write_file", "arguments": {"path": "/tmp/example.txt", "content": "file content here"}}
</tool_call>

Do NOT explain what you would do. Actually call the tool now.`,
              // リトライ2回目: さらに直接的な指示
              `IMPORTANT: Your response must contain a tool call. Do not write any explanation.
Just output the tool call in this exact format:
<tool_call>
{"name": "write_file", "arguments": {"path": "THE_FILE_PATH", "content": "THE_CONTENT"}}
</tool_call>`,
            ];

            this.messages.push({
              role: "user",
              content: retryPrompts[this.retryCount - 1],
            });

            continue; // ループの先頭に戻る
          }

          response = content;
          break;
        }
      } catch (error) {
        console.error("Error in agent loop:", error);
        this.state.phase = "ERROR";
        response = `An error occurred: ${error instanceof Error ? error.message : String(error)}`;
        break;
      }
    }

    // メモリ圧縮を実行（Phase 1の最適化）
    await this.memorySystem.microCompact();

    // メモリに重要な情報を保存
    if (response.length > 0) {
      await this.memorySystem.appendMemory(
        `\n## Latest Response\n${response}\n`,
      );
    }

    return response;
  }

  getState(): AgentState {
    return { ...this.state };
  }

  reset(): void {
    this.messages = [];
    this.state = {
      phase: "INIT",
      thought: "",
      action: null,
      observation: null,
      iteration: 0,
      maxIterations: this.maxIterations,
    };
  }

  getLLMProvider(): ILLMProvider {
    return this.llmProvider;
  }
}
