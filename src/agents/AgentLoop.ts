import { ToolRegistry } from "../tools/ToolRegistry.js";
import { MemorySystem } from "../memory/MemorySystem.js";
import { LongTermMemory } from "../memory/LongTermMemory.js";
import {
  AgentMessage,
  AgentState,
  AgentStatus,
  LoadedSkill,
  StreamChunk,
  StreamCallbacks,
} from "../types/index.js";
import {
  ILLMProvider,
  ChatCompletionRequest,
  ChatMessage,
  ToolCall,
} from "../providers/LLMProvider.js";
import { ConfigManager } from "../config/ConfigManager.js";
import { SkillLoader } from "../skills/SkillLoader.js";
import { ModelRegistry } from "../providers/ModelRegistry.js";
import { ContextManager } from "./ContextManager.js";
import { HookManager } from "../hooks/HookManager.js";
import { FileHookLoader } from "../hooks/FileHookLoader.js";
import { SubAgentManager } from "./SubAgentManager.js";
import { SubAgentTool } from "../tools/SubAgentTool.js";
import { CheckpointManager } from "./CheckpointManager.js";
import { ApprovalManager } from "./ApprovalManager.js";
import { MCPClientManager } from "../mcp/MCPClientManager.js";
import { AutoGitWorkflow } from "./AutoGitWorkflow.js";
import { SelfEvaluator } from "./SelfEvaluator.js";
import { ModelRouter } from "./ModelRouter.js";
import { LLMProviderFactory } from "../providers/LLMProviderFactory.js";
import { Logger } from "../utils/Logger.js";
import type { LoggingConfig } from "../utils/Logger.js";
import { extractFiles } from "../utils/WholeFormatParser.js";
import { setValidationConfig } from "../tools/SyntaxValidator.js";
import { WorkspaceIsolator } from "../sandbox/WorkspaceIsolator.js";
import type { IsolatedWorkspace } from "../sandbox/types.js";

export class AgentLoop {
  private toolRegistry: ToolRegistry;
  private memorySystem: MemorySystem;
  private llmProvider: ILLMProvider;
  private configManager: ConfigManager;
  private skillLoader: SkillLoader;
  private messages: AgentMessage[];
  private state: AgentState;
  private maxIterations: number = 50;
  private activeSkills: LoadedSkill[] = []; // 現在アクティブなスキル
  private lastUsage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  private streamCallbacks?: StreamCallbacks;
  // Phase 2: コンテキストウィンドウ管理
  private contextManager?: ContextManager;
  private modelRegistry: ModelRegistry;
  // Phase 7: Hooks
  private hookManager: HookManager;
  // Phase 8: サブエージェント
  private subAgentManager?: SubAgentManager;
  private basePath: string;
  // Phase 5: チェックポイント
  private checkpointManager?: CheckpointManager;
  // Phase 6: 承認フロー
  private approvalManager?: ApprovalManager;
  // Phase 9: MCP
  private mcpManager?: MCPClientManager;
  // 自動 Git ワークフロー
  private autoGitWorkflow?: AutoGitWorkflow;
  // Phase 14: 自己評価・自己修正
  private selfEvaluator?: SelfEvaluator;
  // Phase 15: モデルルーティング高度化
  private modelRouter?: ModelRouter;
  // 構造化ロガー（Phase 16: pino）
  private log = Logger.get("AgentLoop");
  // 長期メモリ（ベクトル検索）
  private longTermMemory?: LongTermMemory;
  // 現在のセッション ID（長期メモリのタグ付けに使用）
  private sessionId: string = `session_${Date.now()}`;

  // サブエージェントモード: delegate_task を登録せず再帰を防止
  private isSubAgent: boolean = false;
  // サブエージェントで許可されたツール名リスト
  private allowedTools?: string[];

  // Sandbox Tier 1: 隔離作業ツリー (有効化された場合のみ)
  private isolatedWorkspace?: IsolatedWorkspace;
  // origin (本体) のパス。Tier 1 で basePath が workspace に切り替わった後もこれは元のまま
  private originPath: string;

  constructor(
    llmProvider: ILLMProvider,
    basePath: string,
    configManager?: ConfigManager,
    options?: { isSubAgent?: boolean; allowedTools?: string[] },
  ) {
    this.llmProvider = llmProvider;
    this.basePath = basePath;
    this.originPath = basePath;
    this.isSubAgent = options?.isSubAgent ?? false;
    this.allowedTools = options?.allowedTools;
    this.toolRegistry = new ToolRegistry();
    this.memorySystem = new MemorySystem(basePath);
    this.configManager = configManager || new ConfigManager(basePath);
    this.skillLoader = new SkillLoader(basePath);
    this.modelRegistry = new ModelRegistry();
    this.hookManager = new HookManager();
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

    // Phase 16: 構造化ロガーの初期化
    const loggingConfig = this.configManager.get("logging") as
      | LoggingConfig
      | undefined;
    if (loggingConfig) {
      // config.json に明示的な logging 設定がある場合は常に適用（ユーザー設定優先）
      Logger.configure(loggingConfig);
    } else if (!Logger.isConfigured()) {
      // まだ誰も設定していない場合（テスト等）はデフォルト (info) で初期化
      Logger.configure({});
    }
    // CLI が initialize() 前に Logger.configure() を呼んだ場合はそちらを維持する
    this.log = Logger.get("AgentLoop");

    // 構文チェック設定を SyntaxValidator のモジュール singleton にセット
    setValidationConfig(this.configManager.getValidationConfig());

    // Sandbox Tier 1: 作業ツリー分離 (サブエージェントは親の workspace を継承するため立てない)
    if (!this.isSubAgent) {
      await this.setupSandboxWorkspace();
    }

    // Phase 2: コンテキストウィンドウ管理の初期化
    try {
      const modelName = this.llmProvider.getDefaultModel();
      const ollamaBaseUrl =
        this.llmProvider.getType() === "ollama"
          ? "http://localhost:11434"
          : undefined;
      const modelInfo = await this.modelRegistry.getModelInfo(
        modelName,
        ollamaBaseUrl,
      );
      this.contextManager = new ContextManager(modelInfo);
      this.log.info(
        `📐 Context window: ${modelInfo.contextLength} tokens (${modelName})`,
      );
    } catch (error) {
      this.log.warn({ err: error }, "Failed to initialize context manager");
    }

    // Phase 7: ファイルベースのフックをロード
    try {
      const fileLoader = new FileHookLoader();
      const hookCount = await fileLoader.load(this.basePath, this.hookManager);
      if (hookCount > 0) this.log.info(`🪝 Loaded ${hookCount} hook(s)`);
    } catch (error) {
      this.log.warn({ err: error }, "Failed to load hooks");
    }

    // Phase 8: サブエージェントの初期化（サブエージェント自身には delegate_task を登録しない）
    if (!this.isSubAgent) {
      this.subAgentManager = new SubAgentManager(
        this.llmProvider,
        this.basePath,
      );
      this.toolRegistry.register(new SubAgentTool(this.subAgentManager));
      this.log.info("🚀 Sub-agent delegation enabled (delegate_task tool)");
    }

    // Phase 5: チェックポイント管理の初期化（サブエージェントではスキップ）
    if (!this.isSubAgent) {
      try {
        const checkpointConfig = this.configManager.get("checkpoint") as
          | ({ enabled?: boolean } & Partial<
              import("../agents/CheckpointManager.js").CheckpointManagerConfig
            >)
          | undefined;
        if (checkpointConfig?.enabled !== false) {
          this.checkpointManager = new CheckpointManager(
            this.basePath,
            checkpointConfig,
          );
          await this.checkpointManager.initialize();
          this.log.info("💾 Checkpoint system enabled");
        }
      } catch (error) {
        this.log.warn(
          { err: error },
          "Failed to initialize checkpoint manager",
        );
      }
    }

    // Phase 6: 承認フローの初期化（サブエージェントではスキップ）
    if (!this.isSubAgent) {
      try {
        const approvalConfig = this.configManager.get("approval") as
          | {
              mode?: string;
              showDiff?: boolean;
              autoApproveReadOnly?: boolean;
              timeoutSeconds?: number;
            }
          | undefined;
        if (approvalConfig?.mode && approvalConfig.mode !== "auto") {
          this.approvalManager = new ApprovalManager(
            {
              mode: (approvalConfig.mode || "selective") as
                | "auto"
                | "selective"
                | "confirm",
              showDiff: approvalConfig.showDiff !== false,
              autoApproveReadOnly: approvalConfig.autoApproveReadOnly !== false,
              timeoutSeconds: approvalConfig.timeoutSeconds || 0,
            },
            {
              requestApproval: async (request) => {
                // デフォルト: auto-approve（CLI統合時にコールバックを差し替え）
                this.log.info(`🔍 Approval request: ${request.description}`);
                if (request.diff) this.log.info(request.diff);
                return { result: "approved" as const };
              },
            },
          );
          this.log.info(
            `✅ Approval flow enabled (mode: ${approvalConfig.mode})`,
          );
        }
      } catch (error) {
        this.log.warn({ err: error }, "Failed to initialize approval manager");
      }
    }

    // Phase 9: MCP サーバー接続（サブエージェントではスキップ）
    if (!this.isSubAgent) {
      try {
        const mcpConfig = this.configManager.get("mcp") as
          | { servers?: unknown[] }
          | undefined;
        if (mcpConfig?.servers && mcpConfig.servers.length > 0) {
          this.mcpManager = new MCPClientManager(this.toolRegistry);
          await this.mcpManager.connectAll(
            mcpConfig.servers as import("../mcp/MCPConnection.js").MCPServerConfig[],
          );
        }
      } catch (error) {
        this.log.warn({ err: error }, "Failed to initialize MCP");
      }
    }

    // 自動 Git ワークフロー初期化（サブエージェントではスキップ）
    if (!this.isSubAgent) {
      try {
        const autoGitConfig = this.configManager.get("autoGit") as
          | import("../types/index.js").AutoGitConfig
          | undefined;
        if (autoGitConfig?.enabled) {
          this.autoGitWorkflow = AutoGitWorkflow.fromConfig(
            this.basePath,
            autoGitConfig,
            this.llmProvider,
          );
          // task:complete フックとして登録
          this.hookManager.register({
            name: "auto-git-workflow",
            event: "task:complete",
            handler: async (ctx) => {
              if (!this.autoGitWorkflow) return;
              const taskSummary =
                (ctx.toolArgs?.taskSummary as string | undefined) ??
                "agent task";
              const result = await this.autoGitWorkflow.run(taskSummary);
              this.log.info(AutoGitWorkflow.formatResult(result));
            },
            priority: 200,
          });
          this.log.info(
            `🔀 AutoGitWorkflow enabled (mode: ${autoGitConfig.mode ?? "commit-and-test"})`,
          );
        }
      } catch (error) {
        this.log.warn({ err: error }, "Failed to initialize AutoGitWorkflow");
      }
    }

    // Phase 14: 自己評価・自己修正ループの初期化
    try {
      const selfEvalConfig = this.configManager.get("selfEval") as
        | import("../types/index.js").SelfEvalConfig
        | undefined;
      if (selfEvalConfig?.enabled) {
        this.selfEvaluator = SelfEvaluator.fromConfig(
          this
            .llmProvider as import("../providers/LLMProvider.js").ILLMProvider,
          selfEvalConfig,
        );
        this.log.info(
          `🔍 SelfEvaluator enabled (threshold: ${selfEvalConfig.scoreThreshold ?? 7}, maxRounds: ${selfEvalConfig.maxRounds ?? 2})`,
        );
      }
    } catch (error) {
      this.log.warn({ err: error }, "Failed to initialize SelfEvaluator");
    }

    // Phase 15: モデルルーティング高度化の初期化
    try {
      const routingConfig = this.configManager.get("routing") as
        | import("../types/index.js").RoutingConfig
        | undefined;
      if (routingConfig?.enabled) {
        // 現在のプロバイダーを light/heavy 両方に使用（Phase 4 互換）
        this.modelRouter = new ModelRouter(this.llmProvider, this.llmProvider);

        // ルーティングルールおよびフォールバックチェーンで参照される全プロバイダーを収集
        const providerNames = new Set<string>();
        for (const rule of routingConfig.rules ?? []) {
          providerNames.add(rule.provider);
        }
        for (const name of routingConfig.fallbackChain ?? []) {
          providerNames.add(name);
        }
        if (routingConfig.defaultProvider) {
          providerNames.add(routingConfig.defaultProvider);
        }

        // 各プロバイダーのインスタンスを作成してプールに登録
        const providerPool = new Map<string, ILLMProvider>();
        const llmSection = this.configManager.get("llm") as Record<
          string,
          unknown
        >;
        for (const name of providerNames) {
          try {
            // config.json の llm セクションからプロバイダー固有設定を読み取る
            const providerSection =
              (llmSection?.[name] as Record<string, unknown>) ?? {};
            const providerConfig: import("../providers/LLMProvider.js").LLMProviderConfig =
              {
                type: name as import("../providers/LLMProvider.js").LLMProviderType,
                apiKey: (providerSection.apiKey as string) ?? undefined,
                baseUrl: (providerSection.baseUrl as string) ?? undefined,
                model: (providerSection.model as string) ?? undefined,
                temperature: (llmSection?.temperature as number) ?? undefined,
                maxTokens: (llmSection?.maxTokens as number) ?? undefined,
                useCodingEndpoint:
                  (providerSection.useCodingEndpoint as boolean) ?? undefined,
              };
            const provider = LLMProviderFactory.createProvider(providerConfig);
            providerPool.set(name, provider);
          } catch (providerError) {
            this.log.warn(
              { err: providerError, provider: name },
              "Failed to create provider for routing",
            );
          }
        }

        if (providerPool.size > 0) {
          this.modelRouter.enableAdvancedRouting(routingConfig, providerPool);
          this.log.info(
            `🧭 Advanced routing enabled (${providerPool.size} provider(s), ${(routingConfig.rules ?? []).length} rule(s), fallback: [${(routingConfig.fallbackChain ?? []).join(" → ")}])`,
          );
        }
      }
    } catch (error) {
      this.log.warn({ err: error }, "Failed to initialize ModelRouter");
    }

    // 長期メモリ（ベクトル検索）の初期化
    try {
      const ollamaBaseUrl =
        this.llmProvider.getType() === "ollama"
          ? "http://localhost:11434"
          : undefined;
      const openAIApiKey = process.env.OPENAI_API_KEY;
      this.longTermMemory = new LongTermMemory({
        basePath: this.basePath,
        ollamaBaseUrl,
        openAIApiKey,
        defaultTopK: 5,
        minSimilarity: 0.25,
        autoSaveIntervalMs: 60_000,
      });
      await this.longTermMemory.initialize();
      const stats = this.longTermMemory.getStats();
      this.log.info(
        `🧠 Long-term memory enabled | provider: ${this.longTermMemory.getEmbeddingProviderName()} | entries: ${stats.totalEntries}`,
      );
    } catch (error) {
      this.log.warn({ err: error }, "Failed to initialize long-term memory");
    }

    // サブエージェントの場合、許可されたツールのみにフィルタリング
    if (this.isSubAgent && this.allowedTools) {
      this.toolRegistry.filterByAllowed(this.allowedTools);
      this.log.info(
        `🔒 Sub-agent tool restriction: [${this.allowedTools.join(", ")}]`,
      );
    }

    // Phase 7: セッション開始フック
    await this.hookManager.emit("session:start", {});
  }

  /**
   * ストリーミングコールバックを設定
   */
  setStreamCallbacks(callbacks: StreamCallbacks): void {
    this.streamCallbacks = callbacks;
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

    // メモリから関連情報を最適化検索で取得（Phase 1: ファイルベース）
    const searchResults = await this.memorySystem.searchMemory(userInput, 5);
    const relevantContext = searchResults.map((r) => r.content).join("\n");

    // メインメモリと最近のログも取得
    const memoryContent = await this.memorySystem.readMemory();
    const recentLogs = await this.memorySystem.getRecentLogs(7);

    // 長期メモリからセマンティック検索でコンテキストを構築
    let longTermContext = "";
    if (this.longTermMemory) {
      try {
        const memCtx = await this.longTermMemory.buildContext(userInput, 1500);
        longTermContext = memCtx.contextText;
      } catch (error) {
        // 長期メモリ検索の失敗はエージェントの動作をブロックしない
      }
    }

    // スキル自動検出: ユーザー入力からマッチするスキルを見つける
    const skillMatches = this.skillLoader.findRelevantSkills(userInput);
    for (const match of skillMatches) {
      if (
        !this.activeSkills.find(
          (s) => s.manifest.name === match.skill.manifest.name,
        )
      ) {
        this.activeSkills.push(match.skill);
        this.log.info(
          `🎯 Auto-detected skill: ${match.skill.manifest.name} (triggers: ${match.matchedTriggers.join(", ")})`,
        );

        // 追加ツールがあれば登録
        for (const tool of match.skill.tools) {
          this.toolRegistry.register(tool);
        }
      }
    }

    // スキルのプロンプト注入
    const skillPrompt = this.skillLoader.formatSkillsForPrompt(
      this.activeSkills,
    );

    // no-tools モード判定: OllamaProvider が tools 送信を無効化している場合、
    // システムプロンプトの主軸を whole-format 出力に切り替える。
    // (Qwen3.6 MoE など、tool calling を呼べないローカルモデル向け)
    const isNoToolsMode =
      typeof (
        this.llmProvider as unknown as { isToolsDisabled?: () => boolean }
      ).isToolsDisabled === "function" &&
      (
        this.llmProvider as unknown as { isToolsDisabled: () => boolean }
      ).isToolsDisabled();

    if (isNoToolsMode) {
      // CWD をピン留めして、モデルが相対パスの解釈でブレないようにする
      // （Claude Code + Ollama の運用ノウハウ由来）
      const cwd = (() => {
        try {
          return process.cwd();
        } catch {
          return "(unknown)";
        }
      })();

      const noToolsSystemMessage = `You are LunaCode running in whole-format output mode.

Tool calling is DISABLED for this model. You CANNOT and MUST NOT emit <tool_call> blocks — they will be ignored.
Instead, output every file you want to create in this exact format (the file path MUST be on its own line immediately before a fenced code block):

<relative/path/to/file.ext>
\`\`\`<language>
<full file contents>
\`\`\`

Path rules (STRICT):
- Use paths RELATIVE to the project root (for example: "index.html", "src/game.js", "style.css").
- Do NOT use absolute paths (no leading slash, no drive letters, no "~").
- Do NOT include "./" prefixes or ".." segments.
- The path line must contain ONLY the path — no quotes, no backticks, no prose.

Content rules:
- Emit COMPLETE file contents, not placeholders or "...".
- Repeat the format above for each additional file you need to create or overwrite.
- Do NOT add commentary before or after the file blocks beyond a short one-line description.
- Do NOT say "I will create" or "Let me build" — actually emit the files now.

Example for a request "create a hello world HTML":
index.html
\`\`\`html
<!DOCTYPE html>
<html><body><h1>Hello</h1></body></html>
\`\`\`

Current working directory (project root): ${cwd}
All relative paths you emit will be resolved from this directory.

Current project context (from memory):
${memoryContent}

Relevant search results:
${relevantContext}

Recent activity logs:
${recentLogs}
${longTermContext ? `\n${longTermContext}` : ""}`;

      const existingSystemIndex0 = this.messages.findIndex(
        (m) => m.role === "system",
      );
      if (existingSystemIndex0 >= 0) {
        this.messages[existingSystemIndex0] = {
          role: "system",
          content: noToolsSystemMessage,
        };
      } else {
        this.messages.unshift({
          role: "system",
          content: noToolsSystemMessage,
        });
      }
      return await this.runLoop();
    }

    const systemMessage = `You are LunaCode, an autonomous coding agent inspired by Claude Code.
You have access to tools to help with coding tasks.
Always think before acting, and use tools when appropriate.
You MUST use tools to create, read, and edit files. Do NOT just describe what you would do - actually use the tools.
IMPORTANT: You must ALWAYS use tools to gather information before answering. Never answer from memory or assume you have already seen the files. Always read files first.

CRITICAL RULES — ALWAYS FOLLOW:
1. NEVER claim you have already created, modified, or written a file unless you have JUST done it in this conversation. Always use glob or read_file to verify files exist before referencing them.
2. When you are asked to create a file, use write_file immediately. Do NOT say "I already created it" or "I wrote it previously".
3. After completing the requested task (e.g., writing a file), provide your FINAL TEXT ANSWER immediately. Do NOT keep reading the same files in a loop.
4. If you notice yourself calling the same tool with the same arguments more than once, STOP and give your final answer now.
5. DO NOT verify a file you just wrote by reading it back — that wastes time. Trust the write result and respond.
6. FOR FILE CREATION: Always try to write the COMPLETE file in one write_file call first.
   Only if the file is extremely large (500+ lines), you may split it into skeleton + edit_file steps.

Available tools:
${this.toolRegistry.getToolDescriptions()}

When the user asks you to use sub-agents or delegate tasks, you MUST use the delegate_task tool.
When the user mentions "explorer", "worker", or "reviewer" roles, use delegate_task with those roles.
Example: To analyze files in parallel with explorer sub-agents:
<tool_call>
{"name": "delegate_task", "arguments": {"tasks": [{"role": "explorer", "task": "Read and analyze src/file1.ts"}, {"role": "explorer", "task": "Read and analyze src/file2.ts"}]}}
</tool_call>
${skillPrompt}
Current project context (from memory):
${memoryContent}

Relevant search results:
${relevantContext}

Recent activity logs:
${recentLogs}
${longTermContext ? `\n${longTermContext}` : ""}

Follow the ReAct pattern:
1. Thought: Think about what you need to do
2. Action: Choose a tool to execute (write_file, read_file, glob, bash, etc.)
3. Observation: Analyze the tool output
4. If the task is DONE: respond with a final text answer (NO tool calls). Do not loop.

ALTERNATIVE FILE FORMAT (use if tool calling is not working):
If you cannot use tool calls, you can create files by writing them in this format:
filename.ext
\`\`\`language
file content here
\`\`\`

Example:
index.html
\`\`\`html
<!DOCTYPE html>
<html>...</html>
\`\`\`

tetris.js
\`\`\`javascript
// game logic
\`\`\`

When you have enough information or the task is complete, provide a clear, concise response to the user WITHOUT any tool calls.`;

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

  /**
   * ストリーミング応答を消費し、content と toolCalls を集約
   */
  private async consumeStream(
    request: ChatCompletionRequest,
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
    let content = "";
    const toolCalls: ToolCall[] = [];

    const streamGenerator = this.llmProvider.chatCompletionStream?.(request);
    if (!streamGenerator) {
      throw new Error("Provider does not support streaming");
    }

    for await (const chunk of streamGenerator) {
      const streamChunk = chunk as StreamChunk;

      // コンテンツトークンの処理
      if (streamChunk.type === "content" && streamChunk.delta) {
        content += streamChunk.delta;
        this.streamCallbacks?.onToken?.(streamChunk.delta);
      }

      // ツールコール開始
      if (streamChunk.type === "tool_call_start" && streamChunk.toolCall) {
        const toolCall = streamChunk.toolCall as ToolCall;
        toolCalls.push(toolCall);
        this.streamCallbacks?.onToolCall?.(toolCall);
      }

      // 使用トークン情報
      if (streamChunk.type === "done" && streamChunk.usage) {
        this.lastUsage = streamChunk.usage;
        this.streamCallbacks?.onUsage?.(streamChunk.usage);
      }

      // エラー処理
      if (streamChunk.type === "error" && streamChunk.error) {
        this.streamCallbacks?.onError?.(streamChunk.error);
        throw new Error(`Stream error: ${streamChunk.error}`);
      }
    }

    return { content, toolCalls };
  }

  private retryCount: number = 0;
  private maxRetries: number = 2; // ツール未検出時のリトライ上限

  // 重複ツール呼び出し検出用: {tool:args} の出現回数
  private recentToolCallHistory: string[] = [];
  private readonly DUPLICATE_TOOL_THRESHOLD = 3; // 同じツール+引数が何回で打ち切るか

  // 空応答（content も tool_calls も空）が連続した回数。
  // ローカルモデルがフリーズ的に空を返し続ける場合、50 回最後まで回すと
  // 時間・トークンの無駄なので早期に打ち切る。
  private consecutiveEmptyResponses: number = 0;
  private readonly EMPTY_RESPONSE_THRESHOLD = 2;

  // whole-format で最後にファイル書き込みが成功したイテレーション番号。
  // 直後のイテレーションで「Task Complete ✅」のような完了サマリが来た場合に
  // ハリネズミ検出を抑止し、正当な終了として扱うために使う。
  private lastWholeFormatWriteIteration: number = -1;

  private async runLoop(): Promise<string> {
    let response = "";
    this.recentToolCallHistory = [];

    while (this.state.iteration < this.state.maxIterations) {
      try {
        this.state.phase = "THINKING";
        this.state.iteration++;

        // 進捗通知: thinking 開始
        this.streamCallbacks?.onStatus?.({
          iteration: this.state.iteration,
          maxIterations: this.state.maxIterations,
          phase: "thinking",
        });

        // ツールを定義
        const tools = this.toolRegistry.getAll().map((tool) => ({
          type: "function" as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));

        // Phase 15: モデルルーティングでプロバイダーを選択
        const lastUserMsg = this.messages
          .filter((m) => m.role === "user")
          .slice(-1)[0];
        const routingInput =
          typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
        let activeProvider = this.llmProvider;

        if (this.modelRouter) {
          const routing = this.modelRouter.selectProvider(routingInput, {
            iteration: this.state.iteration,
          });
          activeProvider = routing.provider;
        }

        // Phase 2: コンテキストウィンドウ管理 — メッセージをコンテキスト上限内に収める
        const fittedMessages = this.contextManager
          ? this.contextManager.fitMessages(this.messages)
          : this.messages;

        const request: ChatCompletionRequest = {
          model: activeProvider.getDefaultModel(),
          messages: fittedMessages as ChatMessage[],
          tools,
          stream: false,
        };

        // ストリーミングをサポートしているか確認
        const supportsStream = activeProvider.supportsStreaming?.() ?? false;
        let assistantContent = "";
        let toolCalls: ToolCall[] = [];

        // Phase 15: フォールバック付き LLM 呼び出し
        let callSucceeded = false;
        let currentProvider = activeProvider;

        while (!callSucceeded) {
          try {
            request.model = currentProvider.getDefaultModel();

            if (supportsStream && currentProvider === activeProvider) {
              const result = await this.consumeStream(request);
              assistantContent = result.content;
              toolCalls = result.toolCalls;
            } else {
              const completion = await currentProvider.chatCompletion(request);
              const assistantMessage = completion.choices[0].message;
              assistantContent = assistantMessage.content || "";
              toolCalls = assistantMessage.tool_calls || [];
            }
            callSucceeded = true;
          } catch (llmError) {
            // フォールバックチェーンを試行
            const nextProvider = this.modelRouter?.getNextFallback(
              currentProvider.getType(),
            );
            if (nextProvider) {
              this.log.info(
                `🔄 LLM call failed (${currentProvider.getType()}), falling back to ${nextProvider.getType()}`,
              );
              currentProvider = nextProvider;
            } else {
              // フォールバック先がない場合は元のエラーを再送出
              throw llmError;
            }
          }
        }

        // デバッグ: LLMレスポンスをログ
        this.log.debug(
          {
            contentPreview: assistantContent?.substring(0, 100) || "(empty)",
            toolCallCount: toolCalls.length || 0,
          },
          "LLM response received",
        );

        this.messages.push({
          role: "assistant",
          content: assistantContent || "",
        });

        // ツールコールがある場合は実行
        if (toolCalls && toolCalls.length > 0) {
          this.state.phase = "ACTING";
          this.retryCount = 0; // ツール検出成功でリトライカウンタリセット
          this.consecutiveEmptyResponses = 0; // 空応答連続カウンタもリセット

          // 重複ツール呼び出し検出: 同じ {tool+args} が DUPLICATE_TOOL_THRESHOLD 回続いたら打ち切り
          const toolCallKey = toolCalls
            .map((tc) => `${tc.function.name}:${tc.function.arguments}`)
            .join("|");
          this.recentToolCallHistory.push(toolCallKey);
          // 直近 N 件だけ保持
          if (
            this.recentToolCallHistory.length >
            this.DUPLICATE_TOOL_THRESHOLD + 2
          ) {
            this.recentToolCallHistory.shift();
          }
          const duplicateCount = this.recentToolCallHistory.filter(
            (k) => k === toolCallKey,
          ).length;
          if (duplicateCount >= this.DUPLICATE_TOOL_THRESHOLD) {
            this.log.info(
              `[DEBUG] ⚠️ Duplicate tool call detected (${duplicateCount}x): ${toolCallKey.substring(0, 100)}. Breaking loop.`,
            );
            // モデルが同じツールを繰り返し呼び出して進められない状態
            // → LLM に「まとめ」を書かせず、即座にエラーとして終了する
            // （"The task appears to be complete" のような嘘の前提を与えない）
            this.streamCallbacks?.onStatus?.({
              iteration: this.state.iteration,
              maxIterations: this.state.maxIterations,
              phase: "calling",
              toolName: "error",
              toolSummary: `⚠️ 同じツールを ${duplicateCount} 回繰り返しました。処理を中断します`,
            });
            response = `⚠️ エラー: モデルが "${toolCalls[0]?.function?.name ?? "unknown"}" を ${duplicateCount} 回繰り返し呼び出しましたが処理が進みませんでした。\n別のモデルを試すか、タスクをより具体的に指定してください。`;
            break;
          }

          for (const toolCall of toolCalls) {
            if (toolCall.type === "function") {
              this.state.action = toolCall.function.name;
              this.state.thought = assistantContent || "";

              this.log.info(`\n🤖 ${this.state.thought}`);
              this.log.info(`🔧 Executing: ${toolCall.function.name}`);

              // 進捗通知: ツール呼び出し開始
              {
                let parsedForSummary: Record<string, unknown> = {};
                try {
                  parsedForSummary = JSON.parse(toolCall.function.arguments);
                } catch {
                  // ignore
                }
                const toolSummary = buildToolSummary(
                  toolCall.function.name,
                  parsedForSummary,
                );
                this.streamCallbacks?.onStatus?.({
                  iteration: this.state.iteration,
                  maxIterations: this.state.maxIterations,
                  phase: "calling",
                  toolName: toolCall.function.name,
                  toolSummary,
                });
              }

              let parsedArgs: Record<string, unknown>;
              try {
                parsedArgs = JSON.parse(toolCall.function.arguments);
              } catch (parseError) {
                this.log.error(
                  { err: parseError, tool: toolCall.function.name },
                  "Failed to parse tool arguments",
                );
                this.messages.push({
                  role: "tool",
                  content: `Error: Invalid JSON in tool arguments: ${toolCall.function.arguments}`,
                  toolCallId: toolCall.id,
                });
                continue;
              }

              this.log.info(
                `[DEBUG] Executing tool with args: ${JSON.stringify(parsedArgs)}`,
              );

              // Phase 5: 書き込みツール実行前に自動チェックポイント
              if (this.checkpointManager) {
                const writeTools = ["write_file", "edit_file", "bash"];
                if (writeTools.includes(toolCall.function.name)) {
                  try {
                    const typedArgs = parsedArgs as Record<string, unknown>;
                    const argSummary =
                      toolCall.function.name === "bash"
                        ? ((typedArgs.command as string | undefined)?.substring(
                            0,
                            50,
                          ) ?? "")
                        : ((typedArgs.path as string | undefined) ?? "");
                    await this.checkpointManager.create(
                      `Before: ${toolCall.function.name}(${argSummary})`,
                    );
                  } catch (cpError) {
                    // チェックポイント失敗はツール実行をブロックしない
                  }
                }
              }

              // Phase 6: 承認チェック
              if (this.approvalManager) {
                const tool = this.toolRegistry.get(toolCall.function.name);
                const riskLevel =
                  (tool as { riskLevel?: string } | undefined)?.riskLevel ??
                  "MEDIUM";
                const { approved, args: finalArgs } =
                  await this.approvalManager.checkApproval(
                    toolCall.function.name,
                    parsedArgs,
                    riskLevel,
                  );
                if (!approved) {
                  this.messages.push({
                    role: "tool",
                    content:
                      "User rejected this tool execution. Try a different approach.",
                    toolCallId: toolCall.id,
                  });
                  continue;
                }
                parsedArgs = finalArgs;
              }

              // Phase 7: ツール実行前フック
              const beforeHook = await this.hookManager.emit("tool:before", {
                toolName: toolCall.function.name,
                toolArgs: parsedArgs,
                iteration: this.state.iteration,
              });

              if (beforeHook.aborted) {
                this.messages.push({
                  role: "tool",
                  content: "Execution aborted by hook.",
                  toolCallId: toolCall.id,
                });
                continue;
              }

              if (beforeHook.modifiedArgs) {
                parsedArgs = beforeHook.modifiedArgs;
              }

              const toolResult = await this.toolRegistry.executeTool(
                toolCall.function.name,
                parsedArgs,
              );

              this.state.observation = toolResult.success
                ? toolResult.output
                : toolResult.error || "Error";

              this.log.info(
                `[DEBUG] Tool result - Success: ${toolResult.success}, Output length: ${this.state.observation.length}`,
              );
              this.log.info(
                `📊 Observation: ${this.state.observation.substring(0, 200)}...`,
              );

              this.messages.push({
                role: "tool",
                content: this.state.observation,
                toolCallId: toolCall.id,
              });

              // Phase 7: ツール実行後フック
              await this.hookManager.emit("tool:after", {
                toolName: toolCall.function.name,
                toolArgs: parsedArgs,
                toolResult: {
                  success: toolResult.success,
                  output: toolResult.output,
                  error: toolResult.error,
                },
                iteration: this.state.iteration,
              });

              // 長期メモリへの保存（重要なイベントのみ）
              if (this.longTermMemory) {
                try {
                  if (!toolResult.success && toolResult.error) {
                    // エラーは高重要度で保存
                    await this.longTermMemory.storeError(
                      toolResult.error,
                      `ツール: ${toolCall.function.name}, 引数: ${JSON.stringify(parsedArgs).substring(0, 200)}`,
                      undefined,
                      this.sessionId,
                    );
                  } else if (
                    ["write_file", "edit_file"].includes(
                      toolCall.function.name,
                    ) &&
                    toolResult.success
                  ) {
                    // ファイル書き込み成功を記録
                    const ltmArgs = parsedArgs as Record<string, unknown>;
                    const filePath = ltmArgs.path as string | undefined;
                    if (filePath) {
                      await this.longTermMemory.storeCode(
                        `ファイル操作: ${toolCall.function.name}`,
                        (
                          (ltmArgs.content as string | undefined) ?? ""
                        ).substring(0, 300),
                        filePath,
                        this.sessionId,
                      );
                    }
                  }
                } catch {
                  // 長期メモリ保存の失敗はエージェントをブロックしない
                }
              }

              // スケルトン検知: write_file / read_file の結果にプレースホルダーが残っている場合
              // AgentLoop 側で edit_file を使ったセクション埋めを誘導する
              {
                let contentToCheck: string | null = null;
                let filePath: string | null = null;

                const skeletonArgs = parsedArgs as Record<string, unknown>;
                if (
                  toolCall.function.name === "write_file" &&
                  toolResult.success
                ) {
                  filePath = skeletonArgs.path as string | null;
                  contentToCheck = skeletonArgs.content as string | null;
                } else if (
                  toolCall.function.name === "read_file" &&
                  toolResult.success
                ) {
                  filePath = skeletonArgs.path as string | null;
                  contentToCheck = toolResult.output;
                }

                if (contentToCheck && filePath) {
                  const sectionPattern =
                    /<!--\s*SECTION:\s*(\S+)\s*-->|\/\/\s*SECTION:\s*(\S+)/g;
                  const sections: string[] = [];
                  let sm: RegExpExecArray | null;
                  while ((sm = sectionPattern.exec(contentToCheck)) !== null) {
                    sections.push(sm[1] || sm[2]);
                  }
                  if (sections.length > 0) {
                    this.log.info(
                      `[DEBUG] 🏗️ Skeleton detected in ${filePath} — unfilled sections: ${sections.join(", ")}`,
                    );
                    const sectionList = sections
                      .map((s, i) => {
                        const placeholder = contentToCheck!.includes(
                          `<!-- SECTION: ${s}`,
                        )
                          ? `<!-- SECTION: ${s} -->`
                          : `// SECTION: ${s}`;
                        return `${i + 1}. edit_file(path="${filePath}", oldString="${placeholder}", newString="...full ${s} content...")`;
                      })
                      .join("\n");
                    this.messages.push({
                      role: "user",
                      content: `The file "${filePath}" has ${sections.length} unfilled SECTION placeholder(s): ${sections.join(", ")}.
You MUST fill each section using edit_file NOW, one section at a time. Start with "${sections[0]}".

${sectionList}

Replace each placeholder with the REAL, COMPLETE implementation code. Do NOT leave any SECTION placeholder.
<tool_call>
{"name": "edit_file", "arguments": {"path": "${filePath}", "oldString": "${contentToCheck!.includes(`<!-- SECTION: ${sections[0]}`) ? `<!-- SECTION: ${sections[0]} -->` : `// SECTION: ${sections[0]}`}", "newString": "PUT REAL ${sections[0].toUpperCase()} CONTENT HERE"}}
</tool_call>`,
                    });
                  }
                }
              }

              // ログに記録
              await this.memorySystem.appendToLog(
                `[${new Date().toISOString()}] Tool: ${toolCall.function.name}, Result: ${toolResult.success ? "Success" : "Failed"}`,
              );
            }
          }
        } else {
          // ツールコールがない場合
          const content = assistantContent || "";

          // Phase A(C): 運用ログで「何が返ってきたか」を可視化する
          // warn レベルに上げることでデフォルトの interactive モード (level=warn) でも見える
          {
            const MAX_PREVIEW = 400;
            const preview =
              content.length > MAX_PREVIEW
                ? `${content.substring(0, MAX_PREVIEW)}… (${content.length - MAX_PREVIEW} more chars)`
                : content;
            this.log.warn(
              {
                iteration: this.state.iteration,
                retryCount: this.retryCount,
                contentLength: content.length,
                contentPreview: preview,
              },
              "[AgentLoop] ツール呼び出しなし。モデル応答の先頭をダンプします",
            );
          }

          // ─── 空応答の連続検出（早期打ち切り） ─────────────────────────────
          // content が完全に空＝モデルがフリーズしている可能性が高い。
          // 2 回連続なら 50 イテレーション回し切らずに即座に打ち切る。
          if (content.length === 0) {
            this.consecutiveEmptyResponses++;
            if (
              this.consecutiveEmptyResponses >= this.EMPTY_RESPONSE_THRESHOLD
            ) {
              this.log.warn(
                {
                  iteration: this.state.iteration,
                  streak: this.consecutiveEmptyResponses,
                },
                "[AgentLoop] 空応答が連続しました。モデルがフリーズしている可能性があるため処理を打ち切ります",
              );
              this.streamCallbacks?.onStatus?.({
                iteration: this.state.iteration,
                maxIterations: this.state.maxIterations,
                phase: "calling",
                toolName: "error",
                toolSummary: `⚠️ 空応答が ${this.consecutiveEmptyResponses} 回連続しました。モデルを変更するか num_ctx を拡張してください`,
              });
              const modelLabel = (() => {
                try {
                  return this.llmProvider.getDefaultModel?.() ?? "unknown";
                } catch {
                  return "unknown";
                }
              })();
              response = `⚠️ エラー: モデル (${modelLabel}) が ${this.consecutiveEmptyResponses} 回連続で空応答を返しました。\nこのモデルは tool calling に対応していないか、コンテキスト制限で応答を生成できない可能性があります。\n\n対処候補:\n1. よりツール対応の強いモデルに切り替える (例: qwen2.5-coder, llama3.1:70b-instruct)\n2. 環境変数 LUNACODE_OLLAMA_NUM_CTX=16384 でコンテキスト枠を拡張する`;
              break;
            }
          } else {
            // 非空応答が来たらカウンタリセット
            this.consecutiveEmptyResponses = 0;
          }

          // ─── Whole Format フォールバック ──────────────────────────────────
          // モデルがツール呼び出しの代わりにコードブロック形式でファイルを出力した場合
          // (Aider の "whole" 形式)、パースして実際にディスクへ書き込む
          const wholeFiles = extractFiles(content);
          if (wholeFiles.length > 0) {
            this.log.info(
              `Whole-format files detected: ${wholeFiles.length} file(s)`,
            );
            const fs = await import("fs/promises");
            const path = await import("path");
            const writeResults: string[] = [];
            for (const { path: filePath, content: fileContent } of wholeFiles) {
              try {
                // ディレクトリを作成してからファイルを書き込む
                const dir = path.dirname(filePath);
                if (dir !== ".") await fs.mkdir(dir, { recursive: true });
                await fs.writeFile(filePath, fileContent, "utf-8");
                const stat = await fs.stat(filePath);
                writeResults.push(
                  `✅ ${filePath} [verified: ${stat.size} bytes on disk]`,
                );
                this.streamCallbacks?.onStatus?.({
                  iteration: this.state.iteration,
                  maxIterations: this.state.maxIterations,
                  phase: "calling",
                  toolName: "write_file",
                  toolSummary: `write: ${filePath}`,
                });
                this.log.info(
                  `Whole-format write: ${filePath} (${stat.size} bytes)`,
                );
              } catch (err) {
                writeResults.push(
                  `❌ ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
            // whole-format 書き込みが成功したので、カウンター類をリセット
            // （tool call 成功時と同等の扱い）。これがないと次イテレーションの
            // 「Task Complete」サマリがハリネズミ判定で再リトライされてしまう。
            const anyWriteSucceeded = writeResults.some((r) =>
              r.startsWith("✅"),
            );
            if (anyWriteSucceeded) {
              this.retryCount = 0;
              this.consecutiveEmptyResponses = 0;
              this.lastWholeFormatWriteIteration = this.state.iteration;
            }

            // ツール実行結果として会話に追加し、ループを継続
            this.messages.push({
              role: "user",
              content: `Files written from your response:\n${writeResults.join("\n")}\n\nTask complete. Please provide your final summary.`,
            });
            continue;
          }

          // ─── 直前の whole-format 書き込み直後の完了サマリ受け入れ ────────
          // 直前イテレーションでファイル書き込みに成功し、今回は追加の whole-format
          // ブロックもツール呼び出しもない場合、これは正当な完了サマリと判断して
          // ループを終了する（ハリネズミ検出や空応答打ち切りに飲まれないようにする）。
          if (
            this.lastWholeFormatWriteIteration >= 0 &&
            this.state.iteration === this.lastWholeFormatWriteIteration + 1
          ) {
            this.log.info(
              {
                iteration: this.state.iteration,
                wroteAt: this.lastWholeFormatWriteIteration,
                summaryLength: content.length,
              },
              "[AgentLoop] whole-format 書き込み直後のサマリを最終応答として受理します",
            );
            response = content.length > 0 ? content : "Task complete.";
            break;
          }

          // ─── リトライ条件の判定 ───────────────────────────────────────────
          const isEarlyPhase = this.state.iteration <= 3;
          const isFirstIteration = this.state.iteration === 1;

          // ハリネズミ検出: ファイルの存在や作成完了を主張しているが、
          // ツールを一切使わずに回答している（幻覚の典型パターン）
          const claimsFileExists =
            /作成|完了|書き|保存|saved|created|wrote|written|already|以前|前回|finish/i.test(
              content,
            ) &&
            /\.(html|ts|tsx|js|jsx|py|md|txt|json|css|rs|go|rb|java)\b/.test(
              content,
            );

          // リトライすべき条件:
          // A) 1回目のイテレーションは常にリトライ（どんなに長い回答でも最初はツール確認が必要）
          // B) ファイル存在・完了を主張しているが未確認（ハリネズミ）
          // C) 短い回答（通常の「何もすることがない」パターン）
          const isShortResponse = content.length < 200;
          const shouldRetry =
            this.retryCount < this.maxRetries &&
            isEarlyPhase &&
            (isFirstIteration || claimsFileExists || isShortResponse);

          if (shouldRetry) {
            this.retryCount++;

            const availableToolNames = this.toolRegistry
              .getAll()
              .map((t) => t.name)
              .join(", ");

            // no-tools モード時は tool_call 例を出さず、whole-format のみを強制
            const noToolsRetryActive =
              typeof (
                this.llmProvider as unknown as {
                  isToolsDisabled?: () => boolean;
                }
              ).isToolsDisabled === "function" &&
              (
                this.llmProvider as unknown as {
                  isToolsDisabled: () => boolean;
                }
              ).isToolsDisabled();

            let retryMessage: string;

            if (noToolsRetryActive) {
              // tool_call は絶対に出させない。whole-format のみを強制提示
              this.log.info(
                `[DEBUG] ⚠️ No-tools retry ${this.retryCount}/${this.maxRetries}: whole-format only`,
              );
              retryMessage = `You produced no file output. Tool calls are disabled for this model and will be ignored.
Output the file(s) NOW using this exact format (nothing else):

<relative/path/to/file.ext>
\`\`\`<language>
<full file contents>
\`\`\`

Path rules:
- Use paths RELATIVE to the project root (e.g. "index.html", "src/game.js").
- NO absolute paths, NO "./" prefix, NO "..".

Concrete example for a Tetris HTML:
index.html
\`\`\`html
<!DOCTYPE html>
<html>
<!-- full playable Tetris goes here, no placeholders -->
</html>
\`\`\`

Emit the COMPLETE file body. Do NOT write "I will" or "Let me" — emit the file right now.`;
              this.messages.push({ role: "user", content: retryMessage });
              continue;
            }

            if (claimsFileExists && this.retryCount === 1) {
              // ハリネズミ専用メッセージ: glob で実際に確認させる
              this.log.info(
                `[DEBUG] ⚠️ Hallucination detected — model claims files exist without verification. Forcing glob check.`,
              );
              retryMessage = `STOP. You claimed files exist or tasks are complete, but you used NO tools to verify this.
You MUST use glob to check what files actually exist right now before responding.
<tool_call>
{"name": "glob", "arguments": {"pattern": "*", "path": "."}}
</tool_call>`;
            } else if (isFirstIteration && this.retryCount === 1) {
              // 初回イテレーション: タスクに必要なツールを使わせる
              // ※ tool_call 形式を出せないローカルモデル（Qwen3, Gemma 等）向けに
              //   whole-format（ファイル名付きコードブロック）の経路も併記する
              this.log.info(
                `[DEBUG] ⚠️ No tool calls on first iteration. Forcing tool use or whole-format output.`,
              );
              retryMessage = `You did not produce any tool calls or file output. Do NOT just declare intent in prose — actually emit the file(s) now.

Choose ONE of the two formats below and output ONLY that. No explanations before or after.

FORMAT A — tool call (preferred when supported):
<tool_call>
{"name": "write_file", "arguments": {"path": "index.html", "content": "<full file contents here>"}}
</tool_call>

FORMAT B — fenced code block with the file path on its own line (used when you cannot emit tool calls):
index.html
\`\`\`html
<full file contents here>
\`\`\`

If the task needs multiple files, repeat FORMAT B for each file. Emit the COMPLETE file body, not placeholders.`;
            } else {
              // 通常リトライ: 両フォーマットを提示
              this.log.info(
                `[DEBUG] ⚠️ No tool calls detected. Retry ${this.retryCount}/${this.maxRetries} with stronger prompt`,
              );
              retryMessage = `You still produced no tool call and no file block. You must output the file(s) NOW using ONE of these formats:

FORMAT A (tool call):
<tool_call>
{"name": "write_file", "arguments": {"path": "index.html", "content": "..."}}
</tool_call>

FORMAT B (fenced block with path on its own line — use this if you cannot produce tool calls):
index.html
\`\`\`html
<full file contents>
\`\`\`

Available tools: ${availableToolNames}
Do NOT explain. Emit the file contents now.`;
            }

            this.messages.push({ role: "user", content: retryMessage });
            continue; // ループの先頭に戻る
          }

          // リトライ上限到達 → ツールを呼べないモデルへの明示通知
          this.streamCallbacks?.onStatus?.({
            iteration: this.state.iteration,
            maxIterations: this.state.maxIterations,
            phase: "calling",
            toolName: "error",
            toolSummary: `⚠️ このモデルはツールを呼び出せませんでした (${this.retryCount}/${this.maxRetries} 回試行)`,
          });
          response = content;
          break;
        }
      } catch (error) {
        this.log.error({ err: error }, "Error in agent loop");
        this.state.phase = "ERROR";
        response = `An error occurred: ${error instanceof Error ? error.message : String(error)}`;
        break;
      }
    }

    // Phase 14: 自己評価・自己修正ループ
    if (this.selfEvaluator && response.length > 0) {
      try {
        const task =
          [...this.messages].reverse().find((m) => m.role === "user")
            ?.content ?? "";
        const evalResult = await this.selfEvaluator.evaluate(
          {
            task: typeof task === "string" ? task : String(task),
            response,
            messages: this
              .messages as import("../providers/LLMProvider.js").ChatMessage[],
          },
          this.isSubAgent,
        );
        if (!evalResult.skipped) {
          this.log.info(SelfEvaluator.formatResult(evalResult));
        }
        response = evalResult.finalResponse;
      } catch (error) {
        this.log.warn({ err: error }, "SelfEvaluator failed");
      }
    }

    // Phase 7: レスポンス完了フック
    await this.hookManager.emit("response:complete", {
      iteration: this.state.iteration,
    });

    // タスク完了フック（AutoGitWorkflow などが listen する）
    if (!this.isSubAgent) {
      // 最後のユーザーメッセージをタスクの概要として渡す
      const lastUserMsg = [...this.messages]
        .reverse()
        .find((m) => m.role === "user");
      const taskSummary = (lastUserMsg?.content ?? "agent task").slice(0, 200);
      await this.hookManager.emit("task:complete", {
        iteration: this.state.iteration,
        toolArgs: { taskSummary },
      });
    }

    // メモリ圧縮を実行（Phase 1の最適化）
    await this.memorySystem.microCompact();

    // メモリに重要な情報を保存
    if (response.length > 0) {
      await this.memorySystem.appendMemory(
        `\n## Latest Response\n${response}\n`,
      );
    }

    // 進捗通知: 完了
    this.streamCallbacks?.onStatus?.({
      iteration: this.state.iteration,
      maxIterations: this.state.maxIterations,
      phase: "done",
    });

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

  getHookManager(): HookManager {
    return this.hookManager;
  }

  getSubAgentManager(): SubAgentManager | undefined {
    return this.subAgentManager;
  }

  getContextManager(): ContextManager | undefined {
    return this.contextManager;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getCheckpointManager(): CheckpointManager | undefined {
    return this.checkpointManager;
  }

  getApprovalManager(): ApprovalManager | undefined {
    return this.approvalManager;
  }

  getMCPManager(): MCPClientManager | undefined {
    return this.mcpManager;
  }

  getAutoGitWorkflow(): AutoGitWorkflow | undefined {
    return this.autoGitWorkflow;
  }

  getModelRouter(): ModelRouter | undefined {
    return this.modelRouter;
  }

  async cleanup(): Promise<void> {
    // Phase 5: チェックポイントのクリーンアップ
    try {
      await this.checkpointManager?.cleanup();
    } catch (error) {
      // ignore
    }

    // Phase 9: MCP 接続の切断
    try {
      await this.mcpManager?.disconnectAll();
    } catch (error) {
      // ignore
    }

    // 長期メモリ: セッションサマリーを保存してフラッシュ
    if (this.longTermMemory) {
      try {
        // ユーザーメッセージと最後のアシスタント応答を要約して保存
        const userMessages = this.messages
          .filter((m) => m.role === "user")
          .map((m) => m.content)
          .slice(-3) // 最後の 3 件
          .join(" / ");
        const lastAssistant = this.messages
          .filter((m) => m.role === "assistant")
          .slice(-1)[0]?.content;

        if (userMessages && lastAssistant) {
          await this.longTermMemory.storeConversation(
            `セッション ${this.sessionId}\nユーザー: ${userMessages.substring(0, 200)}\nエージェント: ${lastAssistant.substring(0, 300)}`,
            this.sessionId,
            0.5,
          );
        }
        await this.longTermMemory.flush();
        this.longTermMemory.destroy();
      } catch (error) {
        // ignore
      }
    }

    // Phase 7: セッション終了フック
    await this.hookManager.emit("session:end", {});
  }

  getLongTermMemory(): LongTermMemory | undefined {
    return this.longTermMemory;
  }

  // ── Sandbox Tier 1: 作業ツリー分離 ────────────────────────────────────────
  /**
   * `.kairos/config.json` の `sandbox.tier === "workspace"` または
   * `sandbox.workspace.enabled` が true なら、プロジェクトを
   * `.kairos/sandbox/workspace/<sessionId>/` に複製して以降の操作をそこに閉じる。
   *
   * 無効 (既定) なら何もせず、既存挙動を維持する。
   */
  private async setupSandboxWorkspace(): Promise<void> {
    const cfg = this.configManager.getSandboxConfig();
    if (!cfg) return;
    const tierEnabled =
      cfg.tier === "workspace" || cfg.workspace?.enabled === true;
    if (!tierEnabled) return;

    try {
      const workspace = await WorkspaceIsolator.create({
        origin: this.originPath,
        taskId: this.sessionId,
        config: cfg.workspace ?? {},
      });
      this.isolatedWorkspace = workspace;
      this.basePath = workspace.path;
      // サブモジュール (MemorySystem, SkillLoader 等) は既に originPath で初期化済みなので、
      // ここで chdir するとツール側 (BashTool / FileWriteTool) の相対パス解決が
      // workspace 基点になる。副作用が大きいので明示ログを出す。
      process.chdir(workspace.path);
      this.log.info(
        `📦 Sandbox workspace ready: ${workspace.path} (strategy=${workspace.strategy})`,
      );
    } catch (err) {
      this.log.warn(
        { err },
        "Failed to set up sandbox workspace; continuing without isolation",
      );
    }
  }

  /** 現在の IsolatedWorkspace を返す (未初期化なら undefined) */
  getIsolatedWorkspace(): IsolatedWorkspace | undefined {
    return this.isolatedWorkspace;
  }

  /**
   * サンドボックス workspace を破棄する。
   * タスク成功時は事前に `workspace.merge()` を呼んで本体に反映してから、
   * 失敗時は `keepOnFailure` 設定に従う。
   */
  async disposeSandboxWorkspace(
    opts: {
      merge?: boolean;
      keepOnFailure?: boolean;
      success?: boolean;
    } = {},
  ): Promise<void> {
    if (!this.isolatedWorkspace) return;
    const ws = this.isolatedWorkspace;
    try {
      if (opts.merge && opts.success !== false) {
        const result = await ws.merge();
        this.log.info(
          `📦 Sandbox merged: ${result.applied.length} applied, ${result.conflicted.length} conflicted`,
        );
      }
      const keep = opts.keepOnFailure ?? true;
      if (opts.success === false && keep) {
        this.log.info(`📦 Sandbox workspace kept for debugging: ${ws.path}`);
        return;
      }
      await ws.cleanup();
    } finally {
      this.isolatedWorkspace = undefined;
      this.basePath = this.originPath;
      try {
        process.chdir(this.originPath);
      } catch {
        // chdir 失敗は致命的でないので無視
      }
    }
  }
}

/**
 * ツール名と引数から人間が読みやすい一行サマリーを生成
 * 例: bash("ls -la src/") / read_file("src/cli.ts") / glob("**\/*.ts")
 */
function buildToolSummary(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const truncate = (s: string, n = 60) =>
    s.length > n ? s.slice(0, n) + "…" : s;

  switch (toolName) {
    case "bash":
      return `bash: ${truncate(String(args.command ?? ""))}`;
    case "read_file":
      return `read: ${truncate(String(args.path ?? ""))}`;
    case "write_file":
      return `write: ${truncate(String(args.path ?? ""))}`;
    case "edit_file":
      return `edit: ${truncate(String(args.path ?? ""))}`;
    case "multi_file_edit": {
      const edits = Array.isArray(args.edits) ? args.edits : [];
      return `multi_edit: ${edits.length} file(s)`;
    }
    case "glob":
      return `glob: ${truncate(String(args.pattern ?? ""))}`;
    case "grep":
      return `grep: "${truncate(String(args.pattern ?? ""), 30)}" in ${truncate(String(args.path ?? "."), 30)}`;
    case "git_status":
      return "git: status";
    case "git_diff":
      return `git: diff ${truncate(String(args.target ?? "working"))}`;
    case "git_commit":
      return `git: commit "${truncate(String(args.message ?? ""), 40)}"`;
    case "git_apply":
      return "git: apply patch";
    case "git_log":
      return "git: log";
    case "run_tests":
      return `test: ${args.framework ?? "auto"}${args.test_file ? ` ${truncate(String(args.test_file), 30)}` : ""}`;
    case "delegate_task":
      return `delegate: ${truncate(String(args.task ?? ""), 50)}`;
    default:
      return toolName;
  }
}
