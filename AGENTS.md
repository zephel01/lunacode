# AGENTS.md - LunaCode Repository Guide

This guide helps agents work effectively in the LunaCode codebase - an autonomous coding agent inspired by Claude Code.

## Project Overview

**TypeScript/Bun-based autonomous coding agent** with ReAct pattern, multi-LLM support, streaming responses, and 24/7 daemon capabilities.

**Key Technologies**: Bun runtime, TypeScript (ES2022), React Ink (TUI), OpenAI SDK, fast-glob, ripgrep

## Essential Commands

```bash
# Development & Testing
bun test                    # Run all 780 tests (3 todo, 0 fail)
bun test --watch            # Watch mode for tests
bun run src/cli.ts          # Run in dev mode (also: bun dev / bun start)

# Build & Quality
bun build --target node src/cli.ts --outfile dist/cli.js  # Build
eslint src --ext .ts        # Lint
prettier --write "src/**/*.ts"  # Format

# CLI Commands (after bun link or with bun run)
lunacode init              # Generate .kairos/config.json
lunacode chat              # Interactive REPL mode (recommended)
lunacode --auto "task"     # Auto-execute until task complete
lunacode --skill name "task"  # Run with skill
lunacode test-provider     # Test LLM provider connection
```

## Code Organization

```
src/
├── cli.ts                 # Entry point - command parsing & mode routing
├── agents/
│   ├── AgentLoop.ts       # Core ReAct loop (Thought→Action→Observation)
│   ├── ContextManager.ts  # Context window management
│   ├── TaskClassifier.ts  # Task complexity classification
│   ├── ModelRouter.ts     # Auto-select light/heavy models
│   ├── SubAgentManager.ts # Parallel sub-agent delegation
│   ├── CheckpointManager.ts  # Git-based checkpoints & rollback
│   ├── DiffGenerator.ts  # Unified diff generation
│   └── ApprovalManager.ts  # Diff preview & approval flow
├── providers/
│   ├── LLMProvider.ts     # Provider interface
│   ├── LLMProviderFactory.ts  # Factory pattern
│   ├── OllamaProvider.ts  # Native API + text-extraction fallback
│   ├── OpenAIProvider.ts  # OpenAI API
│   ├── ZAIProvider.ts     # Z.AI / GLM Coding Plan
│   ├── LMStudioProvider.ts # LM Studio
│   ├── ModelRegistry.ts   # Model info & context lengths
│   ├── CircuitBreaker.ts  # Failure detection & circuit pattern
│   └── FallbackProvider.ts  # Multi-provider failover
├── tools/
│   ├── ToolRegistry.ts    # Tool registration & execution
│   ├── BaseTool.ts        # Base class for tools
│   ├── BasicTools.ts      # 7 core tools (bash, read/write/edit_file, glob, grep, git)
│   ├── ParallelToolExecutor.ts  # Topological sort & batch execution
│   └── SubAgentTool.ts    # Delegate to sub-agents
├── hooks/
│   ├── HookManager.ts     # Lifecycle event management
│   └── FileHookLoader.ts  # Load hooks from .kairos/hooks.json
├── memory/
│   └── MemorySystem.ts    # 3-layer memory (main/topics/logs)
├── daemon/
│   ├── KAIROSDaemon.ts    # 60s tick daemon
│   └── AutoDream.ts       # Background memory consolidation
├── config/
│   └── ConfigManager.ts   # Config loading (file + defaults)
├── security/
│   ├── AccessControl.ts   # RBAC
│   └── UndercoverMode.ts  # Stealth mode (src/sandbox/ for workspace isolation)
├── buddy/
│   └── BuddyMode.ts      # AI pet companion
├── notifications/
│   └── NotificationManager.ts  # Pushover/Telegram/OS notifications
├── ui/
│   └── TUI.ts             # React Ink terminal UI
├── utils/
│   ├── Spinner.ts         # Terminal spinner
│   └── TokenCounter.ts    # CJK/ASCII token estimation
├── skills/
│   └── SkillLoader.ts     # Load custom skills from .kairos/skills/
├── mcp/
│   ├── MCPClientManager.ts  # Manage MCP server connections
│   └── MCPConnection.ts   # JSON-RPC 2.0 over stdio
└── types/
    └── index.ts           # Central type definitions
```

## Code Patterns & Conventions

### Import Style

- **Always use `.js` extension** for imports (TypeScript moduleResolution: "bundler")
- Use ES modules with `import`/`export` (no CommonJS)
- Example: `import { ToolRegistry } from "../tools/ToolRegistry.js";`

### TypeScript Configuration

- **Target**: ES2022 with strict mode enabled
- **Module**: ESNext
- Use interfaces for public contracts, types for internal use
- Prefer `async/await` over Promise chains

### Class Architecture

- Classes use clear separation of concerns
- Dependency injection via constructor (e.g., `AgentLoop(llmProvider, basePath, configManager)`)
- Private fields with `private` modifier
- Use `initialize()` async method for async setup

### ReAct Pattern (AgentLoop)

```typescript
while (iteration < maxIterations) {
  // 1. Request LLM
  const completion = await llmProvider.chatCompletion(messages, tools);

  // 2. Check for tool_calls
  if (completion.tool_calls && completion.tool_calls.length > 0) {
    // 3. Execute tools
    for (const toolCall of completion.tool_calls) {
      const result = await toolRegistry.executeTool(
        toolCall.function.name,
        toolCall.function.arguments,
      );
      messages.push({ role: "tool", content: result, toolCallId: toolCall.id });
    }
  } else {
    // 4. No tools = task complete
    response = completion.choices[0].message.content;
    break;
  }
}
```

### Streaming Pattern (OllamaProvider)

```typescript
async *chatCompletionStream(request: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
  const response = await fetch(url, { body: JSON.stringify(body) });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n");

    for (const line of lines) {
      const json = JSON.parse(line);  // NDJSON format
      if (json.message?.content) {
        yield { type: "content", delta: json.message.content };
      }
      if (json.done) {
        yield { type: "done", usage: {...} };
      }
    }
  }
}
```

### Tool Pattern

```typescript
export class ExampleTool implements Tool {
  name = "example_tool";
  description = "Description for LLM";
  parameters = {
    type: "object",
    properties: {
      param1: { type: "string", description: "Parameter description" },
    },
    required: ["param1"],
  };

  async execute(params: unknown): Promise<ToolResult> {
    try {
      const { param1 } = params as { param1: string };
      // Do work...
      return { success: true, output: "Result" };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}
```

### Registry Pattern (ToolRegistry, HookManager)

- Use `Map<string, T>` for storage
- `register(item): void` - Add item
- `get(name): T | undefined` - Retrieve item
- `getAll(): T[]` - Get all items
- `executeTool(name, params)` - Execute with error handling

### Configuration Priority

1. **File-based**: `.kairos/config.json` (highest priority)
2. **Environment variables**: OPENAI_API_KEY, OLLAMA_BASE_URL, etc.
3. **Defaults**: Hardcoded fallbacks in code

### Error Handling

- Always return `{ success: boolean, output?: string, error?: string }` for tool results
- Try-catch around async operations
- Log errors with context: `console.error("Failed to initialize context manager:", error);`
- Graceful degradation (e.g., context manager fails → continue without it)

## Testing Approach

### Framework: Bun Test

```bash
bun test                    # All tests
bun test tests/tools.test.ts  # Specific test file
bun test --watch            # Watch mode
```

### Test Structure

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

describe("ComponentName", () => {
  let component: ComponentType;

  beforeAll(async () => {
    // Setup: create test directories, initialize component
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(TEST_DIR, { recursive: true });
    component = new ComponentType();
    await component.initialize();
  });

  afterAll(async () => {
    // Cleanup: remove test directories
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test("should do something", async () => {
    const result = await component.method();
    expect(result.success).toBe(true);
    expect(result.output).toContain("expected");
  });
});
```

### Test Coverage

- **315 tests / 671 assertions** across all components
- Test directories: `/tmp/lunacode-test-*` (isolated, auto-cleanup)
- Test phases: Tools, Providers, Streaming, Context, CircuitBreaker, Fallback, TaskClassifier, ModelRouter, Hooks, SubAgent, Checkpoint, Diff, Approval, MCP, Daemon, Security, Benchmark, CodingTask

### Key Test Files

- `tests/tools.test.ts` - ToolRegistry and 7 core tools
- `tests/ollama-provider.test.ts` - Native API, 6 text-extraction patterns
- `tests/security.test.ts` - 15 dangerous commands blocked, 10 safe commands allowed
- `tests/agent-loop.test.ts` - ReAct loop, tool chaining
- `tests/streaming.test.ts` - NDJSON streaming, tool extraction

## Important Gotchas & Non-Obvious Patterns

### 1. Ollama Tool Calling - Dual Mode

**OllamaProvider supports BOTH native tool calling and text extraction:**

- **Native mode**: Send `tools` parameter to `/api/chat` (OpenAI-compatible)
- **Text-extraction fallback**: Inject tool instructions into system prompt, extract from response text

**Automatic fallback logic:**

```typescript
// If model returns 400 Bad Request OR empty response
if (response.status === 400 || (contentLen === 0 && nativeToolCalls === 0)) {
  useNativeTools = false; // Switch to text extraction permanently
  return chatCompletionWithTextExtraction(request);
}
```

**Text extraction supports 6 patterns:**

1. `<tool_call>...</tool_call>` tags
2. `json ...` code blocks
3. `[TOOL_CALLS] [...]` (Mistral format)
4. `Tool call: name{...}` (Gemma format)
5. Array format: `[{"name": "...", "arguments": {...}}]`
6. Raw JSON: `{"name": "...", "arguments": {...}}`

### 2. Context Window Management - CJK Token Estimation

**TokenCounter uses different ratios for CJK vs ASCII:**

- CJK characters (漢字・ひらがな・カタカナ): ~0.67 tokens/char
- ASCII characters: ~0.25 tokens/char
- Message overhead: 4 tokens for role/name + 2 tokens for content start

**ContextManager automatically trims messages:**

- Always keeps system message
- Removes oldest non-system messages first
- Use `fitMessages(messages, maxTokens)` before LLM calls

### 3. Sub-Agent Tool Filtering

**Sub-agents have restricted tool access:**

- Main agent: All tools available
- Sub-agent: Only `allowedTools` list (e.g., `["read_file", "glob", "grep"]`)
- `delegate_task` is NOT registered in sub-agents (prevents infinite recursion)
- Roles: `explorer` (read-only), `worker` (write+execute), `reviewer` (read-only)

### 4. Retry Logic for Missing Tool Calls

**AgentLoop retries (max 2 times) when:**

- `iteration <= 3` (early phase only)
- `content.length < 200` (short response = not task completion)
- No `tool_calls` detected

**Retry prompts include specific examples:**

```typescript
const retryPrompts = [
  `You did not use any tools. Examples:
   {"name": "read_file", "arguments": {"path": "src/index.ts"}}
   {"name": "delegate_task", "arguments": {"tasks": [...]}}`,
  `IMPORTANT: Output ONE tool call in this exact format:
   {"name": "TOOL_NAME", "arguments": {ARGUMENTS_HERE}}`,
];
```

### 5. Checkpoint & Approval Flow

**Before write tools (`write_file`, `edit_file`, `bash`):**

1. **Checkpoint**: `CheckpointManager.create("Before: tool_name(args)")` → Git commit
2. **Approval**: `ApprovalManager.checkApproval(toolName, args, riskLevel)` → Show diff
3. **Execute**: Tool runs only if approved

**Risk levels:**

- `HIGH`: `write_file`, `edit_file`, `bash` with write commands
- `MEDIUM`: Most other operations
- `LOW`: `read_file`, `glob`, `grep`, `git` read-only

### 6. Memory System - 3 Layers

- **Main memory**: `.kairos/memory.md` - Recent context (auto-compact)
- **Topic files**: `.kairos/topics/*.md` - Long-term storage by topic
- **Raw logs**: `.kairos/logs/*.log` - Unprocessed logs for AutoDream

**Auto-compaction triggers:**

- When memory exceeds `maxContextLines` (default: 200)
- `microCompact()` after each agent loop
- `autoCompact()` when threshold exceeded → creates topic files

### 7. Hook System - 11 Events

**Lifecycle hooks in HookManager:**

- `session:start`, `session:end`
- `tool:before`, `tool:after`
- `iteration:start`, `iteration:end`
- `response:start`, `response:complete`, `response:error`
- `mcp:connect`, `mcp:disconnect`

**Features:**

- Priority-based execution (lower number = higher priority)
- Can `abort()` execution
- Can `modifyArgs()` for tool calls
- File-based hooks in `.kairos/hooks.json` with variable expansion

### 8. Circuit Breaker Pattern

**CircuitBreaker prevents cascading failures:**

- **State transitions**: `closed` → `open` → `half-open` → `closed`
- **Failure threshold**: 3 failures → `open`
- **Reset timeout**: 60 seconds → `half-open`
- **Open state**: Immediately returns error (no API call)

### 9. MCP Integration - JSON-RPC over stdio

**MCP (Model Context Protocol) connects to external servers:**

- JSON-RPC 2.0 protocol over stdio
- Tools automatically registered with namespace (e.g., `server:tool_name`)
- `.kairos/mcp.json` configures servers
- `MCPClientManager` manages connections and lifecycle

### 10. Skill System - Auto-Detection

**Skills are auto-activated by trigger keywords:**

- Skill directory: `.kairos/skills/skill-name/`
- `skill.json`: Contains `triggers: ["keyword1", "keyword2"]`
- `SKILL.md`: Instructions injected into system prompt when active
- Auto-detection: Search user input for trigger keywords → activate skill

### 11. Daemon - 60s Tick Loop

**KAIROS Daemon runs autonomously:**

- Tick interval: 60 seconds
- Events: `tick`, `checkpoint`, `dream`, `notify`
- AutoDream: Background memory consolidation during idle time
- PID stored in `.kairos/daemon.pid` for process management

### 12. File Path Handling

- **Use `path.join()`** for cross-platform paths
- **Absolute paths** required for file tools
- Current working directory: `process.cwd()`
- `.kairos/` directory: Project-specific data (config, memory, skills)

### 13. Environment Variable Priority

**Provider detection order (ConfigManager):**

1. Check `.kairos/config.json` → `llm.provider`
2. Check env vars: `OPENAI_API_KEY`, `ZAI_API_KEY`, `OLLAMA_BASE_URL`
3. Fallback to default provider (ollama)

**Supported env vars:**

- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`
- `ZAI_API_KEY`, `ZAI_BASE_URL`, `ZAI_MODEL`
- `OLLAMA_BASE_URL`, `OLLAMA_MODEL`
- `LMSTUDIO_BASE_URL`, `LMSTUDIO_MODEL`
- `LUNACODE_API_KEY` (alias for OpenAI)

### 14. Import Extension - ALWAYS .js

**Critical**: TypeScript `moduleResolution: "bundler"` requires `.js` extensions

```typescript
import { AgentLoop } from "./agents/AgentLoop.js"; // Correct
import { AgentLoop } from "./agents/AgentLoop"; // Wrong!
```

### 15. Documentation Language

- **Japanese is primary** in comments and docstrings
- README, ARCHITECTURE.md, USER_GUIDE.md are in Japanese
- Code comments and docs are Japanese (e.g., `// ストリーミング対応チャットコンプリション`)

## Configuration Files

### `.kairos/config.json` (Project-specific)

```json
{
  "llm": {
    "provider": "ollama",
    "ollama": {
      "baseUrl": "http://localhost:11434",
      "model": "llama3.1"
    },
    "temperature": 0.7,
    "maxTokens": 4096
  },
  "agent": {
    "maxIterations": 50,
    "timeout": 15000
  },
  "checkpoint": {
    "enabled": true,
    "maxCheckpoints": 10
  },
  "approval": {
    "mode": "selective",
    "showDiff": true,
    "autoApproveReadOnly": true
  },
  "daemon": {
    "enabled": false,
    "tickIntervalSeconds": 60
  },
  "mcp": {
    "servers": [
      {
        "name": "server-name",
        "command": "/path/to/mcp-server",
        "args": []
      }
    ]
  }
}
```

### `.kairos/hooks.json` (Lifecycle hooks)

```json
{
  "hooks": [
    {
      "event": "tool:before",
      "enabled": true,
      "script": "echo 'Tool: ${toolName}, Args: ${toolArgs}'",
      "conditions": {
        "toolName": ["write_file", "edit_file"]
      }
    }
  ]
}
```

## Memory System Details

### 3-Layer Architecture

1. **Main memory** (`.kairos/memory.md`)
   - Recent context and interactions
   - Auto-compacted when > 200 lines
   - Searched by relevance

2. **Topic files** (`.kairos/topics/*.md`)
   - Long-term storage by topic
   - Created during auto-compaction
   - Merged when topics become similar

3. **Raw logs** (`.kairos/logs/*.log`)
   - Unprocessed agent activity
   - Consumed by AutoDream daemon
   - Deleted after processing

### Search & Retrieval

```typescript
// MemorySystem.searchMemory(query, limit) returns:
interface SearchResult {
  content: string;
  source: "memory" | "topic" | "log";
  relevance: number; // 0-1
  timestamp: Date;
}
```

## Debugging Tips

### Enable Debug Logging

Many components log debug messages with `[DEBUG]` prefix:

```typescript
console.log(`[DEBUG] Ollama request (native): tools=${...}, model=${...}`);
```

### Common Issues

**1. Ollama connection refused:**

- Check `OLLAMA_BASE_URL` environment variable
- Verify Ollama is running: `curl http://localhost:11434/api/tags`

**2. Tool calls not detected:**

- Check if model supports tool calling (native mode)
- Verify retry logic is triggering (check logs for `[DEBUG] No tool calls detected`)
- Manual retry: Use text extraction patterns

**3. Context window exceeded:**

- Check ModelRegistry for correct context length
- Verify TokenCounter is estimating correctly (CJK vs ASCII)
- Review ContextManager.fitMessages() logs

**4. Sub-agent recursion:**

- Ensure `delegate_task` is NOT registered in sub-agents
- Check `isSubAgent` flag in AgentLoop constructor
- Verify `filterByAllowed()` is called for sub-agents

## Development Workflow

1. **Make changes** to source files in `src/`
2. **Run tests**: `bun test` (or specific file)
3. **Check linting**: `eslint src --ext .ts`
4. **Format code**: `prettier --write "src/**/*.ts"`
5. **Manual test**: `bun run src/cli.ts chat`
6. **Build**: `bun build --target node src/cli.ts --outfile dist/cli.js`

## Adding Custom Skills

Skills are auto-discovered from `.kairos/skills/<skill-name>/` directories. Each skill responds to user trigger keywords and executes a script as part of the agent's workflow.

### Skill Directory Structure

```
.kairos/skills/
└── my-skill/
    ├── skill.json    # Skill metadata and trigger configuration
    └── run.sh        # Executable script (or run.ts, run.js)
```

### skill.json Schema

```typescript
interface SkillDefinition {
  name: string; // Unique skill identifier
  description: string; // Human-readable description
  triggers: string[]; // Keywords that activate this skill
  script: string; // Relative path to executable script
  timeout?: number; // Execution timeout in ms (default: 30000)
  env?: Record<string, string>; // Additional environment variables
}
```

**Example (`skill.json`)**:

```json
{
  "name": "lint-check",
  "description": "Run ESLint on the current project",
  "triggers": ["lint", "eslint", "コードチェック", "リント"],
  "script": "run.sh",
  "timeout": 60000
}
```

### Script Environment Variables

The following variables are injected into the skill's process environment:

| Variable       | Value                                          |
| -------------- | ---------------------------------------------- |
| `PROJECT_ROOT` | Absolute path to the current project directory |
| `SKILL_NAME`   | The skill's name as defined in `skill.json`    |
| `KAIROS_DIR`   | Absolute path to the `.kairos/` directory      |
| `SESSION_ID`   | Unique ID of the current agent session         |

**Example (`run.sh`)**:

```bash
#!/bin/bash
set -e
cd "$PROJECT_ROOT"
echo "Running ESLint..."
npx eslint src --ext .ts --max-warnings 0
echo "✅ Lint passed"
```

### Skill Execution Flow

```
User input detected → FileHookLoader scans triggers
  → Match found → Script spawned as child process
  → stdout/stderr captured → Result injected as Observation
  → Agent continues with skill output as context
```

### Testing a Skill

```bash
# Manually invoke a skill for testing
PROJECT_ROOT=$(pwd) SKILL_NAME=lint-check bash .kairos/skills/lint-check/run.sh
```

### Skill Best Practices

1. **Exit codes**: Exit 0 for success, non-zero for failure. The agent treats non-zero as an error.
2. **Output**: Keep stdout concise — it's injected into the agent's context window.
3. **Idempotency**: Design skills to be safely re-runnable without side effects.
4. **Timeouts**: Set an appropriate `timeout` for long-running scripts.
5. **Trigger specificity**: Use specific trigger phrases to avoid unintended activation.

## Adding a New LLM Provider

See [docs/ADD_PROVIDER.md](docs/ADD_PROVIDER.md) for a complete step-by-step guide on adding a new LLM provider.

**Quick summary:**

1. Create provider class implementing `ILLMProvider` interface
2. Add provider type to `LLMProviderType` in `LLMProvider.ts`
3. Register in `LLMProviderFactory.createProvider()`
4. Add model info to `ModelRegistry.KNOWN_MODELS`
5. Update CLI `handleInitCommand()` for interactive setup
6. Write tests in `tests/*-provider.test.ts`
7. Update documentation (README.md, CHANGELOG.md, AGENTS.md)

## Key Design Decisions

1. **Streaming-first**: All LLM providers support streaming via `chatCompletionStream()`
2. **Graceful degradation**: Components fail gracefully (e.g., context manager fails → continue without it)
3. **File-based config**: `.kairos/` directory for all project-specific data (portable)
4. **Hook extensibility**: 11 lifecycle events allow custom behavior without code changes
5. **Multi-provider support**: Circuit breaker + fallback ensures reliability
6. **Token-aware**: Context management respects model limits with accurate CJK estimation
7. **Safety-first**: Checkpoints before writes, approval for risky operations, RBAC for sub-agents
8. **Auto-discovery**: Skills auto-detect triggers, models auto-route based on complexity
