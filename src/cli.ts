#!/usr/bin/env bun

import { Command, type OptionValues } from "commander";
import { AgentLoop } from "./agents/AgentLoop.js";
import { ConfigManager } from "./config/ConfigManager.js";
import { LLMProviderFactory } from "./providers/LLMProviderFactory.js";
import { MemorySystem } from "./memory/MemorySystem.js";
import { Spinner } from "./utils/Spinner.js";
import { ProviderTester } from "./testing/ProviderTester.js";
import * as path from "path";
import * as fs from "fs/promises";
import * as readline from "readline";

// デーモン関連のインポート（遅延読み込み）
type DaemonModule = typeof import("./daemon/KAIROSDaemon.js");

// ========================================
// トークン速度トラッカー
// ストリーミング中のトークン生成速度を計測し表示する
// ========================================

interface SpeedTracker {
  callbacks: {
    onToken: (token: string) => void;
    onUsage: (usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    }) => void;
  };
  printSummary: () => void;
}

/**
 * トークン生成速度を計測・表示するトラッカーを生成
 *
 * Ollama など eval_duration を返すプロバイダーはその値を優先使用する。
 * それ以外のプロバイダーはトークン間のタイムスタンプ差分で推定する。
 * いずれもツール実行時間は含まない。
 *
 * @param verbose - true の場合、ストリーミング中にリアルタイムで速度を表示
 */
function createSpeedTracker(verbose = false): SpeedTracker {
  // プロバイダー提供の正確な計測値（Ollama の eval_duration など）
  let providerTotalTokens = 0;
  let providerTotalDurationMs = 0;

  // フォールバック用タイムスタンプ計測
  let totalTokens = 0;
  let totalStreamingMs = 0;
  let sessionStart = 0;
  let lastTokenTime = 0;
  let lastPrintTime = 0;
  let sessionTokens = 0;

  const callbacks = {
    onToken: (_token: string) => {
      const now = Date.now();
      if (sessionStart === 0) {
        sessionStart = now;
        lastPrintTime = now;
        sessionTokens = 0;
      }
      sessionTokens++;
      totalTokens++;
      lastTokenTime = now;

      if (verbose && now - lastPrintTime >= 1000) {
        const elapsed = (now - sessionStart) / 1000;
        const speed = elapsed > 0 ? (sessionTokens / elapsed).toFixed(1) : "0";
        process.stdout.write(
          `\r\x1b[K⚡ ${speed} tokens/sec (計 ${totalTokens} tokens)...`,
        );
        lastPrintTime = now;
      }
    },
    onUsage: (usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      durationMs?: number;
    }) => {
      if (usage.durationMs && usage.durationMs > 0) {
        // プロバイダーが正確な生成時間を提供（Ollama の eval_duration）
        providerTotalTokens += usage.completion_tokens;
        providerTotalDurationMs += usage.durationMs;
      } else {
        // フォールバック: タイムスタンプ差分で累積
        if (sessionStart > 0 && lastTokenTime > 0) {
          totalStreamingMs += lastTokenTime - sessionStart;
        }
        if (usage.completion_tokens > 0) {
          totalTokens = usage.completion_tokens;
        }
      }
      // 次のセッションに備えてリセット
      sessionStart = 0;
      sessionTokens = 0;
    },
  };

  const printSummary = () => {
    if (verbose) process.stdout.write("\r\x1b[K");

    if (providerTotalDurationMs > 0 && providerTotalTokens > 0) {
      // Ollama など正確な値が得られた場合
      const elapsed = providerTotalDurationMs / 1000;
      const speed = (providerTotalTokens / elapsed).toFixed(1);
      console.log(
        `⚡ ${speed} tokens/sec | ${providerTotalTokens} tokens | ${elapsed.toFixed(1)}s`,
      );
    } else {
      // フォールバック計測
      let streamingMs = totalStreamingMs;
      if (sessionStart > 0 && lastTokenTime > 0) {
        streamingMs += lastTokenTime - sessionStart;
      }
      if (totalTokens === 0) return;
      if (streamingMs > 0) {
        const elapsed = streamingMs / 1000;
        const speed = (totalTokens / elapsed).toFixed(1);
        console.log(
          `⚡ ${speed} tokens/sec | ${totalTokens} tokens | ${elapsed.toFixed(1)}s`,
        );
      } else {
        console.log(`⚡ ${totalTokens} tokens generated`);
      }
    }
  };

  return { callbacks, printSummary };
}

/**
 * プロバイダー名からプロバイダーを作成
 */
async function createProvider(providerName: string) {
  const kairosPath = path.join(process.cwd(), ".kairos");
  const configManager = new ConfigManager(kairosPath);
  await configManager.load();
  configManager.updateLLMProvider({
    provider: providerName as "ollama" | "openai" | "lmstudio" | "zai",
  });
  const providerConfig = configManager.getLLMProviderConfig();
  return LLMProviderFactory.createProvider(providerConfig);
}

// ========================================
// init コマンド: config.json 生成
// ========================================

/**
 * CLIプロンプトでユーザー入力を取得
 */
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Ollama API からモデル一覧を取得
 */
async function fetchOllamaModels(
  baseUrl: string,
): Promise<Array<{ name: string; size: string; modified: string }>> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) return [];
    const data = (await response.json()) as {
      models?: Array<{ name: string; size?: number; modified_at?: string }>;
    };
    return (data.models || []).map((m) => ({
      name: m.name,
      size: m.size ? `${(m.size / 1024 / 1024 / 1024).toFixed(1)}GB` : "?",
      modified: m.modified_at
        ? new Date(m.modified_at).toLocaleDateString()
        : "?",
    }));
  } catch {
    return [];
  }
}

/**
 * LM Studio API からモデル一覧を取得
 */
async function fetchLMStudioModels(baseUrl: string): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}/models`);
    if (!response.ok) return [];
    const data = (await response.json()) as { data?: Array<{ id: string }> };
    return (data.data || []).map((m) => m.id);
  } catch {
    return [];
  }
}

/**
 * 番号選択のプロンプト表示
 */
async function selectFromList(
  items: string[],
  promptMsg: string,
): Promise<string> {
  console.log("");
  items.forEach((item, i) => {
    console.log(`  ${i + 1}) ${item}`);
  });
  console.log("");

  const answer = await prompt(promptMsg);
  const num = parseInt(answer, 10);
  if (num >= 1 && num <= items.length) {
    return items[num - 1];
  }
  // 数字以外が入力された場合はそのまま返す（カスタム入力）
  return answer || items[0];
}

async function handleInitCommand(
  kairosPath: string,
  args: string[],
): Promise<void> {
  const configPath = path.join(kairosPath, "config.json");

  // 既存の config.json をチェック
  try {
    await fs.access(configPath);
    if (!args.includes("--force")) {
      console.log(`⚠️  config.json already exists at ${configPath}`);
      console.log("   Use 'lunacode init --force' to overwrite");
      return;
    }
  } catch {
    // ファイルが存在しない場合は続行
  }

  console.log("🚀 LunaCode Configuration Setup\n");

  // 非対話モード: --provider が指定されている場合
  const providerArgIdx = args.indexOf("--provider");
  let provider: string;

  if (providerArgIdx >= 0 && args[providerArgIdx + 1]) {
    provider = args[providerArgIdx + 1];
  } else {
    // 対話モード: プロバイダーを選択
    const providers = [
      "openai    - OpenAI API (GPT-4o, GPT-4o-mini)",
      "ollama    - ローカル LLM (Llama, Gemma, Qwen 等)",
      "lmstudio  - LM Studio (ローカル)",
      "zai       - Z.AI Coding Plan (GLM-5.1)",
      "litellm   - LiteLLM Proxy (100+ プロバイダー)",
    ];
    console.log("📡 LLMプロバイダーを選択してください:");
    providers.forEach((p, i) => {
      console.log(`  ${i + 1}) ${p}`);
    });
    console.log("");
    const providerAnswer = await prompt("番号を入力 (1-5) [default: 1]: ");
    const providerNum = parseInt(providerAnswer, 10);
    const providerNames = ["openai", "ollama", "lmstudio", "zai", "litellm"];
    provider = providerNames[(providerNum || 1) - 1] || "openai";
  }

  const validProviders = ["openai", "ollama", "lmstudio", "litellm", "zai"];
  if (!validProviders.includes(provider)) {
    console.error(`❌ Unknown provider: ${provider}`);
    console.log(`   Available providers: ${validProviders.join(", ")}`);
    return;
  }

  console.log(`\n✅ Provider: ${provider}\n`);

  // プロバイダーごとのデフォルト設定を生成
  const config: {
    llm: Record<string, unknown>;
    agent: Record<string, unknown>;
    memory: Record<string, unknown>;
    daemon: Record<string, unknown>;
  } = {
    llm: {
      provider,
      temperature: 0.7,
      maxTokens: 4096,
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

  // プロバイダー固有の設定（対話的モデル選択含む）
  switch (provider) {
    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY || "";
      const baseUrl = await prompt(
        "Base URL [default: https://api.openai.com/v1]: ",
      );
      const models = ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"];
      const model = await selectFromList(
        models,
        "モデルを選択 (番号 or 直接入力) [default: 1]: ",
      );
      config.llm.openai = {
        apiKey: apiKey || "YOUR_API_KEY_HERE",
        baseUrl: baseUrl || "https://api.openai.com/v1",
        model: model || "gpt-4o-mini",
      };
      break;
    }
    case "ollama": {
      const baseUrl =
        (await prompt("Ollama URL [default: http://localhost:11434]: ")) ||
        "http://localhost:11434";

      // Ollama からモデル一覧を取得
      console.log(`\n🔍 ${baseUrl} からモデル一覧を取得中...`);
      const ollamaModels = await fetchOllamaModels(baseUrl);

      let model = "llama3.1";
      if (ollamaModels.length > 0) {
        console.log(`\n📦 インストール済みモデル (${ollamaModels.length}件):`);
        console.log("");
        ollamaModels.forEach((m, i) => {
          console.log(`  ${i + 1}) ${m.name}  (${m.size}, ${m.modified})`);
        });
        console.log("");
        const modelAnswer = await prompt(
          "モデルを選択 (番号 or 直接入力) [default: 1]: ",
        );
        const modelNum = parseInt(modelAnswer, 10);
        if (modelNum >= 1 && modelNum <= ollamaModels.length) {
          model = ollamaModels[modelNum - 1].name;
        } else if (modelAnswer) {
          model = modelAnswer;
        } else {
          model = ollamaModels[0].name;
        }
      } else {
        console.log(
          "⚠️  Ollama に接続できないか、モデルがインストールされていません",
        );
        console.log(
          "   ollama pull llama3.1 などでモデルをインストールしてください",
        );
        const modelInput = await prompt(
          "モデル名を直接入力 [default: llama3.1]: ",
        );
        model = modelInput || "llama3.1";
      }

      config.llm.ollama = {
        baseUrl,
        model,
      };
      console.log(`\n✅ Model: ${model}`);
      break;
    }
    case "lmstudio": {
      const baseUrl =
        (await prompt("LM Studio URL [default: http://localhost:1234/v1]: ")) ||
        "http://localhost:1234/v1";

      // LM Studio からモデル一覧を取得
      console.log(`\n🔍 ${baseUrl} からモデル一覧を取得中...`);
      const lmsModels = await fetchLMStudioModels(baseUrl);

      let model = "local-model";
      if (lmsModels.length > 0) {
        console.log(`\n📦 ロード済みモデル (${lmsModels.length}件):`);
        model = await selectFromList(
          lmsModels,
          "モデルを選択 (番号 or 直接入力) [default: 1]: ",
        );
        model = model || lmsModels[0];
      } else {
        console.log(
          "⚠️  LM Studio に接続できないか、モデルがロードされていません",
        );
        const modelInput = await prompt(
          "モデル名を直接入力 [default: local-model]: ",
        );
        model = modelInput || "local-model";
      }

      config.llm.lmstudio = {
        baseUrl,
        model,
      };
      console.log(`\n✅ Model: ${model}`);
      break;
    }
    case "zai": {
      const apiKey =
        process.env.ZAI_API_KEY || process.env.ZHIPUAI_API_KEY || "";
      if (!apiKey) {
        console.log("ℹ️  ZAI_API_KEY 環境変数が未設定です");
      }
      const models = [
        "glm-5.1",
        "glm-5",
        "glm-5-turbo",
        "glm-4.7",
        "glm-4.7-flashx",
        "glm-4.5",
      ];
      const model = await selectFromList(
        models,
        "モデルを選択 (番号 or 直接入力) [default: 1]: ",
      );
      const useCodingAnswer = await prompt(
        "Coding Endpoint を使用? (y/n) [default: y]: ",
      );
      const useCoding = useCodingAnswer.toLowerCase() !== "n";
      config.llm.zai = {
        apiKey: apiKey || "YOUR_API_KEY_HERE",
        model: model || "glm-5.1",
        useCodingEndpoint: useCoding,
      };
      break;
    }
    case "litellm": {
      const baseUrl =
        (await prompt("LiteLLM URL [default: http://localhost:4000/v1]: ")) ||
        "http://localhost:4000/v1";
      const modelInput = await prompt("モデル名 [default: gpt-4o-mini]: ");
      config.llm.litellm = {
        baseUrl,
        apiKey: "",
        model: modelInput || "gpt-4o-mini",
      };
      break;
    }
  }

  // ディレクトリ作成
  await fs.mkdir(kairosPath, { recursive: true });

  // 書き込み
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");

  console.log(`\n✅ 設定を保存しました: ${configPath}`);
  console.log(`   Provider: ${provider}`);
  console.log(
    `   Model: ${(config.llm[provider] as Record<string, unknown>)?.model || config.llm.model}`,
  );
  console.log("");
  console.log('📝 "lunacode test-provider" で接続テストできます');
}

/**
 * config コマンド: 現在の設定を表示・変更
 */
async function handleConfigCommand(
  kairosPath: string,
  args: string[],
): Promise<void> {
  const subCommand = args[1] || "show";
  const configManager = new ConfigManager(kairosPath);
  await configManager.load();

  switch (subCommand) {
    case "show": {
      const configPath = path.join(kairosPath, "config.json");
      try {
        const content = await fs.readFile(configPath, "utf-8");
        console.log("📋 Current configuration:\n");
        console.log(content);
      } catch {
        console.log(
          "ℹ️  No config.json found. Run 'lunacode init' to create one.",
        );
      }
      break;
    }
    case "set": {
      const key = args[2];
      const value = args[3];
      if (!key || !value) {
        console.error("Usage: lunacode config set <key> <value>");
        console.log("Example: lunacode config set llm.provider ollama");
        console.log("         lunacode config set llm.ollama.model llama3.1");
        return;
      }
      // ドット区切りのキーを解析して設定を更新
      const configPath = path.join(kairosPath, "config.json");
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<
          string,
          unknown
        >;
      } catch {
        config = {};
      }
      const keys = key.split(".");
      let current: Record<string, unknown> = config;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]] || typeof current[keys[i]] !== "object") {
          current[keys[i]] = {};
        }
        current = current[keys[i]] as Record<string, unknown>;
      }
      // 値の型推定
      const lastKey = keys[keys.length - 1];
      if (value === "true") current[lastKey] = true;
      else if (value === "false") current[lastKey] = false;
      else if (!isNaN(Number(value))) current[lastKey] = Number(value);
      else current[lastKey] = value;

      await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
      console.log(`✅ Set ${key} = ${value}`);
      break;
    }
    case "models": {
      // 現在のプロバイダーのモデル一覧を表示
      const providerConfig = configManager.getLLMProviderConfig();
      if (providerConfig.type === "ollama") {
        const baseUrl = providerConfig.baseUrl || "http://localhost:11434";
        console.log(`🔍 ${baseUrl} からモデル一覧を取得中...\n`);
        const models = await fetchOllamaModels(baseUrl);
        if (models.length === 0) {
          console.log(
            "⚠️  モデルが見つかりません。Ollama が起動しているか確認してください。",
          );
          return;
        }
        console.log(`📦 インストール済みモデル (${models.length}件):\n`);
        models.forEach((m, i) => {
          const current =
            m.name === providerConfig.model ? " ← 現在の設定" : "";
          console.log(
            `  ${i + 1}) ${m.name}  (${m.size}, ${m.modified})${current}`,
          );
        });
        console.log("");
        console.log(
          "モデルを変更: lunacode config set llm.ollama.model <model-name>",
        );
      } else if (providerConfig.type === "lmstudio") {
        const baseUrl = providerConfig.baseUrl || "http://localhost:1234/v1";
        console.log(`🔍 ${baseUrl} からモデル一覧を取得中...\n`);
        const models = await fetchLMStudioModels(baseUrl);
        if (models.length === 0) {
          console.log(
            "⚠️  モデルが見つかりません。LM Studio が起動しているか確認してください。",
          );
          return;
        }
        console.log(`📦 ロード済みモデル (${models.length}件):\n`);
        models.forEach((m, i) => {
          const current = m === providerConfig.model ? " ← 現在の設定" : "";
          console.log(`  ${i + 1}) ${m}${current}`);
        });
      } else if (providerConfig.type === "zai") {
        console.log("📦 Z.AI 利用可能モデル:\n");
        const models = [
          "glm-5.1",
          "glm-5",
          "glm-5-turbo",
          "glm-4.7",
          "glm-4.7-flashx",
          "glm-4.5",
        ];
        models.forEach((m) => {
          const current = m === providerConfig.model ? " ← 現在の設定" : "";
          console.log(`  - ${m}${current}`);
        });
      } else {
        console.log(`ℹ️  ${providerConfig.type} のモデル一覧取得は未対応です`);
      }
      break;
    }
    default:
      console.error(`Unknown config command: ${subCommand}`);
      console.log("Available commands: show, set, models");
  }
}

// ========================================
// デーモンコマンドのハンドラー（Phase 2）
// ========================================

async function handleDaemonCommand(args: string[]): Promise<void> {
  const subCommand = args[1] || "start";

  const kairosPath = path.join(process.cwd(), ".kairos");
  const memorySystem = new MemorySystem(kairosPath);
  await memorySystem.initialize();

  try {
    switch (subCommand) {
      case "start": {
        const daemonModule: DaemonModule =
          await import("./daemon/KAIROSDaemon.js");
        const { KAIROSDaemon } = daemonModule;
        const provider = args.includes("--provider")
          ? await createProvider(args[args.indexOf("--provider") + 1])
          : null;

        const kairosDaemon = new KAIROSDaemon(
          kairosPath,
          memorySystem,
          provider || undefined,
        );
        await kairosDaemon.initialize();
        await kairosDaemon.start();

        // デーモンをフォアグラウンドで実行
        console.log("🚀 KAIROS Daemon started");
        console.log('Use "lunacode daemon stop" to stop the daemon');
        break;
      }

      case "stop": {
        await stopDaemon(kairosPath);
        break;
      }

      case "status": {
        const status = await getDaemonStatus(kairosPath);
        displayDaemonStatus(status);
        break;
      }

      case "restart": {
        await stopDaemon(kairosPath);
        // 少し待機
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const daemonModule: DaemonModule =
          await import("./daemon/KAIROSDaemon.js");
        const { KAIROSDaemon } = daemonModule;
        const provider = args.includes("--provider")
          ? await createProvider(args[args.indexOf("--provider") + 1])
          : null;

        const kairosDaemon = new KAIROSDaemon(
          kairosPath,
          memorySystem,
          provider || undefined,
        );
        await kairosDaemon.initialize();
        await kairosDaemon.start();
        break;
      }

      case "logs": {
        await showDaemonLogs(kairosPath);
        break;
      }

      default:
        console.error(`Unknown daemon command: ${subCommand}`);
        console.log("Available commands: start, stop, status, restart, logs");
        process.exit(1);
    }
  } catch (error) {
    console.error("Error executing daemon command:", error);
    process.exit(1);
  }
}

async function stopDaemon(basePath: string): Promise<void> {
  try {
    const pidPath = path.join(basePath, ".kairos", "daemon.pid");
    const pidContent = await fs.readFile(pidPath, "utf-8");
    const pid = parseInt(pidContent.trim(), 10);

    process.kill(pid, "SIGTERM");
    console.log(`🛑 Stopped daemon (PID: ${pid})`);

    // プロセスが終了するのを待機
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } catch (error) {
    console.error("Error stopping daemon:", error);
  }
}

async function getDaemonStatus(
  basePath: string,
): Promise<{ isRunning: boolean; pid?: number; uptime?: string }> {
  try {
    const pidPath = path.join(basePath, ".kairos", "daemon.pid");
    const pidContent = await fs.readFile(pidPath, "utf-8");
    const pid = parseInt(pidContent.trim(), 10);

    // プロセスが存在するか確認
    try {
      process.kill(pid, 0);
      return { isRunning: true, pid };
    } catch {
      return { isRunning: false };
    }
  } catch (error) {
    return { isRunning: false };
  }
}

function displayDaemonStatus(status: {
  isRunning: boolean;
  pid?: number;
  uptime?: string;
}): void {
  if (status.isRunning) {
    console.log("🟢 Daemon Status: Running");
    console.log(`📊 PID: ${status.pid}`);
    console.log(`📊 Uptime: ${status.uptime || "Unknown"}`);
  } else {
    console.log("🔴 Daemon Status: Stopped");
  }
}

async function showDaemonLogs(basePath: string): Promise<void> {
  const logsPath = path.join(basePath, ".kairos", "logs");

  try {
    const files = await fs.readdir(logsPath);
    const logFiles = files
      .filter((f) => f.endsWith(".log"))
      .sort()
      .reverse();

    if (logFiles.length === 0) {
      console.log("No logs found.");
      return;
    }

    console.log("📋 Recent daemon logs:\n");

    // 最新の5つのログファイルを表示
    for (const logFile of logFiles.slice(0, 5)) {
      const logPath = path.join(logsPath, logFile);
      const stat = await fs.stat(logPath);
      const content = await fs.readFile(logPath, "utf-8");

      console.log(`\n📄 ${logFile}`);
      console.log(`   Size: ${(stat.size / 1024).toFixed(2)} KB`);
      console.log(`   Last Modified: ${stat.mtime.toISOString()}`);
      console.log(
        `   Content:\n${content.substring(0, 500)}${content.length > 500 ? "..." : ""}`,
      );
    }
  } catch (error) {
    console.error("Error reading daemon logs:", error);
  }
}

// ========================================
// ドリームコマンドのハンドラー（Phase 2）
// ========================================

async function handleDreamCommand(args: string[]): Promise<void> {
  const subCommand = args[0] || "run";

  const kairosPath = path.join(process.cwd(), ".kairos");
  const memorySystem = new MemorySystem(kairosPath);
  await memorySystem.initialize();

  try {
    switch (subCommand) {
      case "run":
        await runDream(kairosPath, memorySystem);
        break;
      case "history":
        await showDreamHistory(kairosPath);
        break;
      case "status":
        await showDreamStatus(kairosPath);
        break;
      default:
        console.error(`Unknown dream command: ${subCommand}`);
        console.log("Available commands: run, history, status");
        process.exit(1);
    }
  } catch (error) {
    console.error("Error executing dream command:", error);
    process.exit(1);
  }
}

async function runDream(
  basePath: string,
  memorySystem: MemorySystem,
): Promise<void> {
  console.log("🌙 Starting dream mode...\n");

  // プロバイダーの初期化
  const configManager = new ConfigManager(basePath);
  await configManager.load();

  let provider;
  try {
    const providerConfig = configManager.getLLMProviderConfig();
    provider = LLMProviderFactory.createProvider(providerConfig);
    console.log(`📡 Using ${provider.getType()} provider`);
  } catch (error) {
    console.error("Failed to initialize LLM provider:", error);
    console.error("LLM provider is required for dream mode");
    process.exit(1);
  }

  // AutoDreamの実行
  const { AutoDream } = await import("./daemon/AutoDream.js");
  const autoDream = new AutoDream(basePath, memorySystem, provider);
  await autoDream.initialize();

  const dreamSettings = {
    autoTrigger: false,
    idleThresholdMinutes: 60,
    maxDurationMinutes: 30,
    minSessionsSinceDream: 5,
    consolidationIntervalHours: 24,
  };

  const startTime = Date.now();
  console.log("Processing...\n");

  try {
    const result = await autoDream.run(dreamSettings);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log("\n✅ Dream mode completed successfully!\n");
    console.log("📊 Results:");
    console.log(`   Duration: ${duration}s`);
    console.log(`   Logs processed: ${result.logsProcessed}`);
    console.log(`   Contradictions resolved: ${result.contradictionsResolved}`);
    console.log(`   Insights extracted: ${result.insightsExtracted}`);
    console.log(`   Memories compressed: ${result.memoriesCompressed}`);
    console.log(`   Topics created: ${result.topicsCreated}\n`);
  } catch (error) {
    console.error("\n❌ Dream mode failed:", error);
    process.exit(1);
  }
}

async function showDreamHistory(basePath: string): Promise<void> {
  const { AutoDream } = await import("./daemon/AutoDream.js");

  const kairosPath = path.join(process.cwd(), ".kairos");
  const memorySystem = new MemorySystem(kairosPath);
  await memorySystem.initialize();

  const autoDream = new AutoDream(basePath, memorySystem);
  await autoDream.initialize();

  const history = await autoDream.getDreamHistory(10);

  if (history.length === 0) {
    console.log("No dream history found.\n");
    return;
  }

  console.log("📋 Recent Dreams:\n");

  for (const filename of history) {
    const dreamLogPath = path.join(basePath, ".kairos", "dreams", filename);
    try {
      const content = await fs.readFile(dreamLogPath, "utf-8");
      const stats = await fs.stat(dreamLogPath);

      // ログファイルから基本的な情報を抽出
      const lines = content.split("\n");
      const timestampLine = lines.find((l) => l.includes("**Timestamp:**"));
      const durationLine = lines.find((l) => l.includes("**Duration:**"));
      const logsLine = lines.find((l) => l.includes("- Logs processed:"));

      if (timestampLine || durationLine) {
        console.log(`📄 ${filename}`);
        if (timestampLine) console.log(`   ${timestampLine.trim()}`);
        if (durationLine) console.log(`   ${durationLine.trim()}`);
        if (logsLine) console.log(`   ${logsLine.trim()}`);
        console.log(`   Size: ${(stats.size / 1024).toFixed(2)} KB\n`);
      }
    } catch (error) {
      console.error(`Error reading dream log ${filename}:`, error);
    }
  }
}

async function showDreamStatus(basePath: string): Promise<void> {
  console.log("🌙 Dream Status\n");

  // 最後のドリーム時間を確認
  const dreamTimePath = path.join(basePath, ".kairos", "dream_time.json");
  try {
    const content = await fs.readFile(dreamTimePath, "utf-8");
    const data = JSON.parse(content);

    if (data.lastDream) {
      const lastDream = new Date(data.lastDream);
      const hoursAgo = ((Date.now() - data.lastDream) / 3600000).toFixed(1);

      console.log(`Last dream: ${lastDream.toISOString()}`);
      console.log(`Time since last dream: ${hoursAgo} hours\n`);
    } else {
      console.log("No dreams have been run yet.\n");
    }
  } catch {
    console.log("No dream history found.\n");
  }

  // ドリームログの数をカウント
  const dreamsPath = path.join(basePath, ".kairos", "dreams");
  try {
    const files = await fs.readdir(dreamsPath);
    const logFiles = files.filter((f) => f.endsWith(".log"));
    console.log(`Total dreams: ${logFiles.length}\n`);
  } catch {
    console.log("Total dreams: 0\n");
  }
}

// ========================================
// Buddyコマンドのハンドラー（Phase 3）
// ========================================

async function handleBuddyCommand(args: string[]): Promise<void> {
  const subCommand = args[0] || "info";

  const kairosPath = path.join(process.cwd(), ".kairos");
  const buddyStatePath = path.join(kairosPath, "buddy_state.json");

  try {
    // BuddyModeのインポート
    const { BuddyMode, PetType, getPetTypes, generateDefaultPetName } =
      await import("./buddy/BuddyMode.js");

    let buddy;
    let stateData;

    // 既存の状態をロード
    try {
      stateData = JSON.parse(await fs.readFile(buddyStatePath, "utf-8"));
      buddy = new BuddyMode(stateData.name, stateData.type);

      // 状態を復元
      const currentState = buddy.getState();
      currentState.emotion = stateData.emotion;
      currentState.energy = stateData.energy;
      currentState.hunger = stateData.hunger;
      currentState.happiness = stateData.happiness;
      currentState.lastInteraction = stateData.lastInteraction;
    } catch {
      // 新しいペットを作成
      const petType = (
        args.includes("--type") ? args[args.indexOf("--type") + 1] : PetType.CAT
      ) as (typeof PetType)[keyof typeof PetType];
      const petName = args.includes("--name")
        ? args[args.indexOf("--name") + 1]
        : generateDefaultPetName(petType);

      buddy = new BuddyMode(petName, petType);

      // 状態を保存
      stateData = {
        name: petName,
        type: petType,
        emotion: buddy.getState().emotion,
        energy: buddy.getState().energy,
        hunger: buddy.getState().hunger,
        happiness: buddy.getState().happiness,
        lastInteraction: buddy.getState().lastInteraction,
      };
      await fs.writeFile(
        buddyStatePath,
        JSON.stringify(stateData, null, 2),
        "utf-8",
      );
    }

    switch (subCommand) {
      case "info":
        console.log(buddy.displayInfo());
        break;

      case "call": {
        const name = args[1];
        if (!name) {
          console.error("Error: Name is required");
          console.error("Usage: lunacode buddy call <name>");
          process.exit(1);
        }
        const callResponse = buddy.callByName(name);
        console.log(callResponse.message);
        if (callResponse.action) {
          console.log(`🎭 アクション: ${callResponse.action}`);
        }
        await saveBuddyState(buddy, buddyStatePath);
        break;
      }

      case "talk": {
        const message = args.slice(1).join(" ");
        if (!message) {
          console.error("Error: Message is required");
          console.error("Usage: lunacode buddy talk <message>");
          process.exit(1);
        }
        const talkResponse = buddy.talk(message);
        console.log(talkResponse.message);
        if (talkResponse.action) {
          console.log(`🎭 アクション: ${talkResponse.action}`);
        }
        await saveBuddyState(buddy, buddyStatePath);
        break;
      }

      case "pet": {
        const petResponse = buddy.pet();
        console.log(petResponse.message);
        if (petResponse.action) {
          console.log(`🎭 アクション: ${petResponse.action}`);
        }
        await saveBuddyState(buddy, buddyStatePath);
        break;
      }

      case "feed": {
        const feedResponse = buddy.feed();
        console.log(feedResponse.message);
        if (feedResponse.action) {
          console.log(`🎭 アクション: ${feedResponse.action}`);
        }
        await saveBuddyState(buddy, buddyStatePath);
        break;
      }

      case "play": {
        const playResponse = buddy.play();
        console.log(playResponse.message);
        if (playResponse.action) {
          console.log(`🎭 アクション: ${playResponse.action}`);
        }
        await saveBuddyState(buddy, buddyStatePath);
        break;
      }

      case "sleep": {
        const sleepResponse = buddy.sleep();
        console.log(sleepResponse.message);
        if (sleepResponse.action) {
          console.log(`🎭 アクション: ${sleepResponse.action}`);
        }
        await saveBuddyState(buddy, buddyStatePath);
        break;
      }

      case "types": {
        console.log("\n🐾 Available Pet Types:\n");
        const types = getPetTypes();
        types.forEach((t) => {
          console.log(`${t.emoji} ${t.type.toUpperCase()}`);
          console.log(`   Personality: ${t.personality}\n`);
        });
        break;
      }

      case "create": {
        let newPetType: (typeof PetType)[keyof typeof PetType];
        if (args.includes("--type")) {
          const typeIndex = args.indexOf("--type") + 1;
          const typeString = args[typeIndex];
          newPetType = ((PetType as Record<string, string>)[
            typeString.toUpperCase()
          ] || PetType.CAT) as (typeof PetType)[keyof typeof PetType];
        } else {
          newPetType =
            (await getRandomPetType()) as (typeof PetType)[keyof typeof PetType];
        }

        const newPetName = args.includes("--name")
          ? args[args.indexOf("--name") + 1]
          : generateDefaultPetName(newPetType);

        const newBuddy = new BuddyMode(newPetName, newPetType);
        console.log("\n✨ New pet created!\n");
        console.log(newBuddy.displayInfo());

        const newStateData = {
          name: newPetName,
          type: newPetType,
          emotion: newBuddy.getState().emotion,
          energy: newBuddy.getState().energy,
          hunger: newBuddy.getState().hunger,
          happiness: newBuddy.getState().happiness,
          lastInteraction: newBuddy.getState().lastInteraction,
        };
        await fs.writeFile(
          buddyStatePath,
          JSON.stringify(newStateData, null, 2),
          "utf-8",
        );
        break;
      }

      default:
        console.error(`Unknown buddy command: ${subCommand}`);
        console.log(
          "Available commands: info, call, talk, pet, feed, play, sleep, types, create",
        );
        console.log("\nOptions:");
        console.log("  --type <type>  Pet type (e.g., cat, dog, rabbit)");
        console.log("  --name <name>  Pet name");
        process.exit(1);
    }
  } catch (error) {
    console.error("Error executing buddy command:", error);
    process.exit(1);
  }
}

async function saveBuddyState(
  buddy: {
    getState(): {
      name: string;
      type: string;
      emotion: string;
      energy: number;
      hunger: number;
      happiness: number;
      lastInteraction: number;
    };
  },
  statePath: string,
): Promise<void> {
  const state = buddy.getState();
  const stateData = {
    name: state.name,
    type: state.type,
    emotion: state.emotion,
    energy: state.energy,
    hunger: state.hunger,
    happiness: state.happiness,
    lastInteraction: state.lastInteraction,
  };
  await fs.writeFile(statePath, JSON.stringify(stateData, null, 2), "utf-8");
}

async function getRandomPetType(): Promise<string> {
  const { PetType } = await import("./buddy/BuddyMode.js");
  const types = Object.values(PetType) as string[];
  return types[Math.floor(Math.random() * types.length)];
}

// ========================================
// メモリ管理コマンドのハンドラー（Phase 1）
// ========================================

async function handleMemoryCommand(args: string[]): Promise<void> {
  const subCommand = args[1] || "stats";

  const kairosPath = path.join(process.cwd(), ".kairos");
  const memorySystem = new MemorySystem(kairosPath);
  await memorySystem.initialize();

  try {
    switch (subCommand) {
      case "stats":
        await handleMemoryStats(memorySystem);
        break;
      case "search": {
        const query = args.slice(2).join(" ");
        if (!query) {
          console.error("Error: Search query is required");
          console.error("Usage: lunacode memory search <query>");
          process.exit(1);
        }
        await handleMemorySearch(memorySystem, query);
        break;
      }
      case "compact":
        await handleMemoryCompact(memorySystem);
        break;
      case "topics":
        await handleMemoryTopics(memorySystem);
        break;
      default:
        console.error(`Unknown memory command: ${subCommand}`);
        console.log("Available commands: stats, search, compact, topics");
        process.exit(1);
    }
  } catch (error) {
    console.error("Memory command failed:", error);
    process.exit(1);
  }
}

async function handleMemoryStats(memorySystem: MemorySystem): Promise<void> {
  console.log("📊 Memory Statistics\n");

  const stats = await memorySystem.getMemoryStats();

  console.log(`Main Memory Lines: ${stats.memoryLines}`);
  console.log(`Topic Files: ${stats.topicCount}`);
  console.log(`Total Size: ${(stats.totalSizeBytes / 1024).toFixed(2)} KB`);

  const compactionConfig = memorySystem.getCompactionConfig();
  console.log("\nCompaction Configuration:");
  console.log(`  Enabled: ${compactionConfig.enabled}`);
  console.log(`  Max Context Lines: ${compactionConfig.maxContextLines}`);
  console.log(
    `  Auto-compact Threshold: ${compactionConfig.autoCompactThreshold}`,
  );
}

async function handleMemorySearch(
  memorySystem: MemorySystem,
  query: string,
): Promise<void> {
  console.log(`🔍 Searching memory for: "${query}"\n`);

  const results = await memorySystem.searchMemory(query, 5);

  if (results.length === 0) {
    console.log("No results found.\n");
    return;
  }

  console.log("Search Results:\n");
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const sourceIcon =
      result.source === "memory"
        ? "📝"
        : result.source === "topic"
          ? "📁"
          : "📋";
    const relevancePercent = (result.relevance * 100).toFixed(1);

    console.log(
      `[${i + 1}] ${sourceIcon} ${result.source.toUpperCase()} (${relevancePercent}% relevance)`,
    );
    console.log(
      `    ${result.content.substring(0, 100)}${result.content.length > 100 ? "..." : ""}`,
    );
    console.log("");
  }
}

async function handleMemoryCompact(memorySystem: MemorySystem): Promise<void> {
  console.log("🗜️  Compacting memory...\n");

  const result = await memorySystem.autoCompact();

  console.log(`Original Lines: ${result.originalLines}`);
  console.log(`Compressed Lines: ${result.compressedLines}`);
  console.log(`Compression Ratio: ${result.compressionRatio.toFixed(1)}%`);
  console.log(`Topics Created: ${result.topicsCreated}`);
  console.log(`Topics Merged: ${result.topicsMerged}`);
  console.log("\n✅ Memory compaction completed\n");
}

async function handleMemoryTopics(memorySystem: MemorySystem): Promise<void> {
  console.log("📁 Available Topics\n");

  const topics = await memorySystem.listTopics();

  if (topics.length === 0) {
    console.log("No topics found.\n");
    return;
  }

  for (const topicName of topics) {
    const topicInfo = await memorySystem.getTopicInfo(topicName);
    if (topicInfo) {
      console.log(`📄 ${topicName}.md`);
      console.log(`   Lines: ${topicInfo.lineCount}`);
      console.log(
        `   Last Updated: ${new Date(topicInfo.lastUpdated).toISOString()}`,
      );
      console.log("");
    }
  }
}

// ========================================
// 対話モード (chat) — REPL
// ========================================

async function handleChatMode(kairosPath: string): Promise<void> {
  const configManager = new ConfigManager(kairosPath);
  await configManager.load();

  let provider;
  try {
    const providerConfig = configManager.getLLMProviderConfig();
    provider = LLMProviderFactory.createProvider(providerConfig);
  } catch (error) {
    console.error("Failed to initialize LLM provider:", error);
    console.error("Run 'lunacode init' to configure.");
    process.exit(1);
  }

  const agent = new AgentLoop(provider, kairosPath, configManager);
  await agent.initialize();

  console.log("🚀 LunaCode Interactive Mode");
  console.log(
    `📡 Provider: ${provider.getType()} | Model: ${provider.getDefaultModel()}`,
  );
  console.log("   Type your query and press Enter. Commands:");
  console.log("   /exit, /quit  — 終了");
  console.log("   /clear        — 会話履歴をクリア");
  console.log("   /status       — エージェント状態を表示");
  console.log("   /memory       — メモリ統計を表示");
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "🌙 > ",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    // スラッシュコマンド
    if (input.startsWith("/")) {
      const cmd = input.toLowerCase();

      if (cmd === "/exit" || cmd === "/quit" || cmd === "/q") {
        console.log("\n👋 Bye!");
        rl.close();
        process.exit(0);
      }

      if (cmd === "/clear") {
        agent.reset();
        console.log("🗑️  会話履歴をクリアしました\n");
        rl.prompt();
        return;
      }

      if (cmd === "/status") {
        const state = agent.getState();
        console.log(`\n📊 Agent Status:`);
        console.log(`   Phase: ${state.phase}`);
        console.log(
          `   Iteration: ${state.iteration} / ${state.maxIterations}`,
        );
        console.log(`   Last Action: ${state.action || "none"}\n`);
        rl.prompt();
        return;
      }

      if (cmd === "/memory") {
        const memorySystem = new MemorySystem(kairosPath);
        await memorySystem.initialize();
        const stats = await memorySystem.getMemoryStats();
        console.log(`\n📊 Memory:`);
        console.log(`   Lines: ${stats.memoryLines}`);
        console.log(`   Topics: ${stats.topicCount}`);
        console.log(
          `   Size: ${(stats.totalSizeBytes / 1024).toFixed(2)} KB\n`,
        );
        rl.prompt();
        return;
      }

      console.log(`Unknown command: ${input}`);
      rl.prompt();
      return;
    }

    // 通常のクエリ
    try {
      const spinner = new Spinner();
      spinner.start("処理中...");
      const tracker = createSpeedTracker(false);
      agent.setStreamCallbacks(tracker.callbacks);
      const response = await agent.processUserInput(input);
      spinner.stop();
      console.log("\n" + response + "\n");
      tracker.printSummary();
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error),
      );
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\n👋 Bye!");
    process.exit(0);
  });
}

// ========================================
// 自動実行モード (--auto)
// タスク完了まで自動でツールを実行し続ける
// ========================================

async function handleAutoMode(
  kairosPath: string,
  initialQuery: string,
  maxRounds: number = 10,
  skillName?: string,
): Promise<void> {
  const configManager = new ConfigManager(kairosPath);
  await configManager.load();

  let provider;
  try {
    const providerConfig = configManager.getLLMProviderConfig();
    provider = LLMProviderFactory.createProvider(providerConfig);
  } catch (error) {
    console.error("Failed to initialize LLM provider:", error);
    process.exit(1);
  }

  const agent = new AgentLoop(provider, kairosPath, configManager);
  await agent.initialize();

  // スキルが指定された場合はアクティブにする
  if (skillName) {
    if (agent.activateSkill(skillName)) {
      console.log(`🎯 Skill activated: ${skillName}`);
    } else {
      console.warn(
        `⚠️ Skill "${skillName}" not found. Continuing without skill.`,
      );
      console.log(`   Run "lunacode skill list" to see available skills.`);
    }
  }

  console.log("🤖 LunaCode Auto Mode");
  console.log(
    `📡 Provider: ${provider.getType()} | Model: ${provider.getDefaultModel()}`,
  );
  console.log(`🎯 Task: ${initialQuery}`);
  console.log(`🔄 Max Rounds: ${maxRounds}`);
  if (skillName) console.log(`📦 Skill: ${skillName}`);
  console.log("─".repeat(60) + "\n");

  let currentQuery = initialQuery;
  let round = 0;

  while (round < maxRounds) {
    round++;
    console.log(`\n═══ Round ${round}/${maxRounds} ═══\n`);

    try {
      const spinner = new Spinner();
      spinner.start(`🤔 "${currentQuery.substring(0, 40)}..." を処理中...`);
      const tracker = createSpeedTracker(false);
      agent.setStreamCallbacks(tracker.callbacks);
      const response = await agent.processUserInput(currentQuery);
      spinner.stop();
      console.log("\n" + response);
      tracker.printSummary();

      // レスポンスに「完了」「finished」「done」等が含まれるか、
      // ツールコールが無くテキストのみの応答なら完了と判断
      const completionKeywords = [
        "完了",
        "作成しました",
        "作成完了",
        "以上です",
        "完成",
        "finished",
        "done",
        "completed",
        "created successfully",
        "here is the",
        "here's the",
      ];

      const lowerResponse = response.toLowerCase();
      const isComplete = completionKeywords.some((kw) =>
        lowerResponse.includes(kw.toLowerCase()),
      );

      if (isComplete) {
        console.log("\n" + "─".repeat(60));
        console.log("✅ タスク完了！");
        break;
      }

      // 継続: LLMの応答を元に次のクエリを生成
      // レスポンスが質問で終わっている場合は自動的に進める
      const endsWithQuestion =
        response.trim().endsWith("？") || response.trim().endsWith("?");

      if (endsWithQuestion) {
        // 質問に対して自動応答: 「はい、お願いします」で進める
        currentQuery =
          "はい、お願いします。自動で進めてください。ファイルを作成して完成させてください。";
        console.log(`\n🤖 Auto-reply: ${currentQuery}`);
      } else {
        // 質問でない場合は「続けて」で次のステップへ
        currentQuery =
          "続けてください。次のステップに進んでください。全てのファイルを作成して完成させてください。";
        console.log(`\n🤖 Auto-continue: 次のステップへ...`);
      }
    } catch (error) {
      console.error(
        `\n❌ Error in round ${round}:`,
        error instanceof Error ? error.message : String(error),
      );

      if (round >= maxRounds) {
        console.error("Max rounds reached. Stopping.");
        break;
      }

      // エラーが起きても再トライ
      currentQuery = `エラーが発生しました。別のアプローチで続けてください: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  if (round >= maxRounds) {
    console.log("\n⚠️  最大ラウンド数に達しました。");
  }

  console.log("\n" + "─".repeat(60));
  console.log("📊 実行結果:");
  console.log(`   Rounds: ${round}`);
  const state = agent.getState();
  console.log(`   Total Iterations: ${state.iteration}`);
  console.log("");
}

// ========================================
// メイン関数
// ========================================

// ========================================
// skill コマンド: スキル管理
// ========================================

async function handleSkillCommand(kairosPath: string, args: string[]) {
  const { SkillLoader } = await import("./skills/SkillLoader.js");
  const loader = new SkillLoader(kairosPath);
  await loader.loadAll();

  const subCommand = args[0] || "list";

  switch (subCommand) {
    case "list":
    case "ls": {
      console.log("\n📦 Installed Skills\n");
      console.log(loader.formatSkillList());
      console.log(`\nSkills directory: ${path.join(kairosPath, "skills")}`);
      console.log(
        'Run "lunacode skill create <name>" to create a new skill.\n',
      );
      break;
    }

    case "create":
    case "new": {
      const name = args[1];
      if (!name) {
        console.error(
          'Usage: lunacode skill create <skill-name> ["description"]',
        );
        process.exit(1);
      }
      const description = args[2] || `Custom skill: ${name}`;
      const skillDir = await loader.createSkillTemplate(name, description);
      console.log(`\n✅ Skill template created at: ${skillDir}`);
      console.log(`\nEdit the following files to customize your skill:`);
      console.log(
        `  📝 ${path.join(skillDir, "SKILL.md")}  — 指示書（LLM に注入される）`,
      );
      console.log(
        `  📋 ${path.join(skillDir, "skill.json")} — メタデータ・トリガーワード\n`,
      );
      break;
    }

    case "enable": {
      const name = args[1];
      if (!name) {
        console.error("Usage: lunacode skill enable <skill-name>");
        process.exit(1);
      }
      if (loader.setEnabled(name, true)) {
        console.log(`✅ Skill "${name}" enabled.`);
      } else {
        console.error(`❌ Skill "${name}" not found.`);
      }
      break;
    }

    case "disable": {
      const name = args[1];
      if (!name) {
        console.error("Usage: lunacode skill disable <skill-name>");
        process.exit(1);
      }
      if (loader.setEnabled(name, false)) {
        console.log(`⏸️  Skill "${name}" disabled.`);
      } else {
        console.error(`❌ Skill "${name}" not found.`);
      }
      break;
    }

    case "show":
    case "info": {
      const name = args[1];
      if (!name) {
        console.error("Usage: lunacode skill show <skill-name>");
        process.exit(1);
      }
      const skill = loader.getSkill(name);
      if (!skill) {
        console.error(`❌ Skill "${name}" not found.`);
        process.exit(1);
      }
      console.log(`\n📦 ${skill.manifest.name} v${skill.manifest.version}`);
      console.log(`Description: ${skill.manifest.description}`);
      console.log(`Category: ${skill.manifest.category || "custom"}`);
      console.log(`Triggers: ${skill.manifest.triggers.join(", ")}`);
      console.log(`Enabled: ${skill.isEnabled ? "✅" : "⏸️"}`);
      console.log(`Directory: ${skill.dirPath}`);
      console.log(`\n--- SKILL.md ---`);
      console.log(skill.skillMdContent.substring(0, 500));
      if (skill.skillMdContent.length > 500) {
        console.log(`... (${skill.skillMdContent.length} bytes total)`);
      }
      console.log("");
      break;
    }

    default:
      console.error(`Unknown skill command: ${subCommand}`);
      console.log("Available: list, create, enable, disable, show");
      process.exit(1);
  }
}

// ========================================
// ワンショットクエリ実行
// ========================================

async function handleOneshotQuery(
  kairosPath: string,
  query: string,
): Promise<void> {
  const configManager = new ConfigManager(kairosPath);
  await configManager.load();

  let provider;
  try {
    const providerConfig = configManager.getLLMProviderConfig();
    provider = LLMProviderFactory.createProvider(providerConfig);
  } catch (error) {
    console.error("Failed to initialize LLM provider:", error);
    console.error("\nPlease set one of the following environment variables:");
    console.error("  - OPENAI_API_KEY (for OpenAI)");
    console.error("  - OLLAMA_BASE_URL (for Ollama)");
    console.error("  - LMSTUDIO_BASE_URL (for LM Studio)");
    console.error("\nOr create a .kairos/config.json file.");
    process.exit(1);
  }

  const agent = new AgentLoop(provider, kairosPath, configManager);
  await agent.initialize();

  console.log(`🚀 LunaCode Processing: "${query}"\n`);

  try {
    const spinner = new Spinner();
    spinner.start("処理中...");
    const tracker = createSpeedTracker(false);
    agent.setStreamCallbacks(tracker.callbacks);
    const response = await agent.processUserInput(query);
    spinner.stop();
    console.log("\n" + "=".repeat(80));
    console.log("\n✅ Response:\n");
    console.log(response);
    console.log("\n" + "=".repeat(80));
    tracker.printSummary();
    console.log("");
  } catch (error) {
    console.error("Error processing query:", error);
    process.exit(1);
  }
}

// ========================================
// プロバイダーテスト
// ========================================

async function handleTestProvider(
  kairosPath: string,
  options: { quick?: boolean; save?: boolean; output?: string },
): Promise<void> {
  const configManager = new ConfigManager(kairosPath);
  await configManager.load();

  let provider;
  try {
    const providerConfig = configManager.getLLMProviderConfig();
    provider = LLMProviderFactory.createProvider(providerConfig);
    console.log(`\n📡 Provider: ${provider.getType()}`);
    console.log(`🤖 Model: ${provider.getDefaultModel()}\n`);
  } catch (error) {
    console.error("Failed to initialize LLM provider:", error);
    console.error("\nPlease set one of the following environment variables:");
    console.error("  - OPENAI_API_KEY (for OpenAI)");
    console.error("  - ZAI_API_KEY (for Z.AI / GLM Coding Plan)");
    console.error("  - OLLAMA_BASE_URL (for Ollama)");
    console.error("  - LMSTUDIO_BASE_URL (for LM Studio)");
    console.error("\nOr create a .kairos/config.json file.");
    process.exit(1);
  }

  if (options.quick) {
    console.log("🧪 Quick connection test...\n");
    const agent = new AgentLoop(provider, kairosPath, configManager);
    await agent.initialize();
    try {
      const spinner = new Spinner();
      spinner.start("接続テスト実行中...");
      const response = await agent.processUserInput("Test connection");
      spinner.stop();
      console.log("\n" + "=".repeat(80));
      console.log("\n✅ Connection successful!\n");
      console.log(response.substring(0, 200));
      console.log("\n" + "=".repeat(80) + "\n");
    } catch (error) {
      console.error("❌ Connection failed:", error);
      process.exit(1);
    }
  } else {
    const reportPath =
      options.output || path.join(kairosPath, `test-report-${Date.now()}.json`);
    const tester = new ProviderTester(provider, kairosPath, configManager);
    const report = await tester.runAll();
    tester.printReport(report);

    if (options.save) {
      await tester.saveReport(report, reportPath);
      console.log(`\n💾 Report saved to: ${reportPath}\n`);
    }

    const failed = report.results.filter((r) => r.status === "fail").length;
    process.exit(failed > 0 ? 1 : 0);
  }

  process.exit(0);
}

// ========================================
// commander.js によるコマンド定義
// ========================================

function buildProgram(): Command {
  const program = new Command();

  program
    .name("lunacode")
    .description("LunaCode — KAIROS Autonomous Coding Agent")
    .version("2.2.0");

  // ---- init ----
  program
    .command("init")
    .description("Generate .kairos/config.json (recommended first step)")
    .option(
      "-p, --provider <provider>",
      "Provider: openai, ollama, lmstudio, litellm, zai",
    )
    .option("-f, --force", "Overwrite existing config.json")
    .action(async (_opts: OptionValues, cmd: Command) => {
      const kairosPath = path.join(process.cwd(), ".kairos");
      await ensureKairosDir(kairosPath);
      // handleInitCommand は生の args 配列を期待するので変換
      const rawArgs: string[] = cmd.parent?.args ?? [];
      await handleInitCommand(kairosPath, ["init", ...rawArgs]);
    });

  // ---- config ----
  const configCmd = program
    .command("config")
    .description("Configuration management");

  configCmd
    .command("show")
    .description("Show current configuration")
    .action(async () => {
      const kairosPath = path.join(process.cwd(), ".kairos");
      await ensureKairosDir(kairosPath);
      await handleConfigCommand(kairosPath, ["config", "show"]);
    });

  configCmd
    .command("set <key> <value>")
    .description("Set a configuration value (e.g. llm.provider ollama)")
    .action(async (key: string, value: string) => {
      const kairosPath = path.join(process.cwd(), ".kairos");
      await ensureKairosDir(kairosPath);
      await handleConfigCommand(kairosPath, ["config", "set", key, value]);
    });

  configCmd
    .command("models")
    .description("List available models for current provider")
    .action(async () => {
      const kairosPath = path.join(process.cwd(), ".kairos");
      await ensureKairosDir(kairosPath);
      await handleConfigCommand(kairosPath, ["config", "models"]);
    });

  // config をサブコマンド無しで実行 → show
  configCmd.action(async () => {
    const kairosPath = path.join(process.cwd(), ".kairos");
    await ensureKairosDir(kairosPath);
    await handleConfigCommand(kairosPath, ["config", "show"]);
  });

  // ---- chat ----
  program
    .command("chat")
    .alias("interactive")
    .description("Interactive mode (REPL) — 対話モード")
    .action(async () => {
      const kairosPath = path.join(process.cwd(), ".kairos");
      await ensureKairosDir(kairosPath);
      await handleChatMode(kairosPath);
    });

  // ---- auto ----
  program
    .command("auto <query...>")
    .description("Autonomous mode — 自動でタスク完了まで実行")
    .option("-r, --rounds <n>", "Maximum rounds", "10")
    .option("-s, --skill <name>", "Activate a skill for the task")
    .action(async (queryParts: string[], opts: OptionValues) => {
      const kairosPath = path.join(process.cwd(), ".kairos");
      await ensureKairosDir(kairosPath);
      const maxRounds = parseInt(opts.rounds as string, 10) || 10;
      await handleAutoMode(
        kairosPath,
        queryParts.join(" "),
        maxRounds,
        opts.skill as string | undefined,
      );
    });

  // ---- provider ----
  program
    .command("provider")
    .description("List available LLM providers")
    .action(async () => {
      console.log("\nAvailable LLM Providers:\n");
      const availableProviders = LLMProviderFactory.getAvailableProviders();
      availableProviders.forEach((p) => {
        const description = LLMProviderFactory.getProviderDescription(p);
        console.log(`\n${p.toUpperCase()}`);
        console.log(`  ${description}\n`);
      });
    });

  // ---- test-provider ----
  program
    .command("test-provider")
    .description("Test LLM provider connection")
    .option("-q, --quick", "Quick connection test only")
    .option("--save", "Save test report to file")
    .option("-o, --output <path>", "Report output path")
    .action(async (opts: OptionValues) => {
      const kairosPath = path.join(process.cwd(), ".kairos");
      await ensureKairosDir(kairosPath);
      await handleTestProvider(kairosPath, opts);
    });

  // ---- daemon ----
  const daemonCmd = program
    .command("daemon")
    .description("Daemon mode management");

  for (const sub of ["start", "stop", "status", "restart", "logs"] as const) {
    daemonCmd
      .command(sub)
      .description(`${sub.charAt(0).toUpperCase() + sub.slice(1)} the daemon`)
      .option("--provider <name>", "LLM provider to use")
      .action(async (opts: OptionValues) => {
        const rawArgs: string[] = [sub];
        if (opts.provider) rawArgs.push("--provider", opts.provider as string);
        await handleDaemonCommand(rawArgs);
      });
  }

  daemonCmd.action(async () => {
    await handleDaemonCommand(["start"]);
  });

  // ---- dream ----
  const dreamCmd = program
    .command("dream")
    .description("Memory consolidation (dream mode)");

  for (const sub of ["run", "history", "status"] as const) {
    dreamCmd
      .command(sub)
      .description(
        `${sub === "run" ? "Run dream consolidation" : sub === "history" ? "Show dream history" : "Show dream status"}`,
      )
      .action(async () => {
        await handleDreamCommand([sub]);
      });
  }

  dreamCmd.action(async () => {
    await handleDreamCommand(["run"]);
  });

  // ---- buddy ----
  const buddyCmd = program.command("buddy").description("AI pet companion");

  buddyCmd
    .command("info")
    .description("Show buddy info")
    .action(async () => {
      await handleBuddyCommand(["info"]);
    });

  buddyCmd
    .command("call <name>")
    .description("Call buddy by name")
    .action(async (name: string) => {
      await handleBuddyCommand(["call", name]);
    });

  buddyCmd
    .command("talk <message...>")
    .description("Talk to buddy")
    .action(async (messageParts: string[]) => {
      await handleBuddyCommand(["talk", ...messageParts]);
    });

  for (const sub of ["pet", "feed", "play", "sleep"] as const) {
    buddyCmd
      .command(sub)
      .description(`${sub.charAt(0).toUpperCase() + sub.slice(1)} your buddy`)
      .action(async () => {
        await handleBuddyCommand([sub]);
      });
  }

  buddyCmd
    .command("types")
    .description("List available pet types")
    .action(async () => {
      await handleBuddyCommand(["types"]);
    });

  buddyCmd
    .command("create")
    .description("Create a new buddy")
    .option("-t, --type <type>", "Pet type (cat, dog, rabbit, etc.)")
    .option("-n, --name <name>", "Pet name")
    .action(async (opts: OptionValues) => {
      const buddyArgs: string[] = ["create"];
      if (opts.type) buddyArgs.push("--type", opts.type as string);
      if (opts.name) buddyArgs.push("--name", opts.name as string);
      await handleBuddyCommand(buddyArgs);
    });

  buddyCmd.action(async () => {
    await handleBuddyCommand(["info"]);
  });

  // ---- memory ----
  const memoryCmd = program.command("memory").description("Memory management");

  memoryCmd
    .command("stats")
    .description("Show memory statistics")
    .action(async () => {
      await handleMemoryCommand(["memory", "stats"]);
    });

  memoryCmd
    .command("search <query...>")
    .description("Search memory")
    .action(async (queryParts: string[]) => {
      await handleMemoryCommand(["memory", "search", ...queryParts]);
    });

  memoryCmd
    .command("compact")
    .description("Compact memory")
    .action(async () => {
      await handleMemoryCommand(["memory", "compact"]);
    });

  memoryCmd
    .command("topics")
    .description("List topics")
    .action(async () => {
      await handleMemoryCommand(["memory", "topics"]);
    });

  memoryCmd.action(async () => {
    await handleMemoryCommand(["memory", "stats"]);
  });

  // ---- skill ----
  const skillCmd = program
    .command("skill")
    .alias("skills")
    .description("Skill management");

  skillCmd
    .command("list")
    .alias("ls")
    .description("List installed skills")
    .action(async () => {
      const kairosPath = path.join(process.cwd(), ".kairos");
      await ensureKairosDir(kairosPath);
      await handleSkillCommand(kairosPath, ["list"]);
    });

  skillCmd
    .command("create <name> [description]")
    .alias("new")
    .description("Create a new skill template")
    .action(async (name: string, description?: string) => {
      const kairosPath = path.join(process.cwd(), ".kairos");
      await ensureKairosDir(kairosPath);
      const skillArgs = ["create", name];
      if (description) skillArgs.push(description);
      await handleSkillCommand(kairosPath, skillArgs);
    });

  skillCmd
    .command("enable <name>")
    .description("Enable a skill")
    .action(async (name: string) => {
      const kairosPath = path.join(process.cwd(), ".kairos");
      await ensureKairosDir(kairosPath);
      await handleSkillCommand(kairosPath, ["enable", name]);
    });

  skillCmd
    .command("disable <name>")
    .description("Disable a skill")
    .action(async (name: string) => {
      const kairosPath = path.join(process.cwd(), ".kairos");
      await ensureKairosDir(kairosPath);
      await handleSkillCommand(kairosPath, ["disable", name]);
    });

  skillCmd
    .command("show <name>")
    .alias("info")
    .description("Show skill details")
    .action(async (name: string) => {
      const kairosPath = path.join(process.cwd(), ".kairos");
      await ensureKairosDir(kairosPath);
      await handleSkillCommand(kairosPath, ["show", name]);
    });

  skillCmd.action(async () => {
    const kairosPath = path.join(process.cwd(), ".kairos");
    await ensureKairosDir(kairosPath);
    await handleSkillCommand(kairosPath, ["list"]);
  });

  // ---- デフォルト: 引数なしで chat, 不明な引数はワンショットクエリ ----
  program.action(async () => {
    const kairosPath = path.join(process.cwd(), ".kairos");
    await ensureKairosDir(kairosPath);
    await handleChatMode(kairosPath);
  });

  // 未知のコマンドはワンショットクエリとして扱う
  program.on("command:*", async (operands: string[]) => {
    const kairosPath = path.join(process.cwd(), ".kairos");
    await ensureKairosDir(kairosPath);
    const query = operands.join(" ");
    await handleOneshotQuery(kairosPath, query);
  });

  return program;
}

/** .kairos ディレクトリを確保 */
async function ensureKairosDir(kairosPath: string): Promise<void> {
  try {
    await fs.mkdir(kairosPath, { recursive: true });
  } catch (error) {
    console.error("Failed to create .kairos directory:", error);
    process.exit(1);
  }
}

// ========================================
// エントリポイント
// ========================================

const program = buildProgram();
program.parseAsync(process.argv).catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
