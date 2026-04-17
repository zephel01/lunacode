/**
 * ModelSettingsRegistry - Aider 方式のモデル設定レジストリ。
 *
 * プロバイダ/モデルごとの挙動（tool calling 対応、num_ctx、edit_format 等）を
 * 宣言的に管理する。新モデル対応がエントリ追加だけで済むようにする。
 *
 * 設定ファイルの置き場所は `lunacode init` が作成する `.kairos/config.json`
 * と同じディレクトリを採用する。
 *
 * 解決順:
 *   1. <cwd>/.kairos/model-settings.yml           （カレント、明示用）
 *   2. <repo-root>/.kairos/model-settings.yml    （リポジトリ固有）
 *   3. ~/.kairos/model-settings.yml               （ユーザ全体）
 *   4. 同梱 BUILTIN_MODEL_SETTINGS                 （デフォルト）
 *
 * いずれも全エントリを結合した上で「先頭からマッチする最初のエントリ」を採用する。
 * 上位（数字が小さい方）が先にマッチすると勝つので、ユーザ設定が常に優先される。
 *
 * match 構文:
 *   "<provider>/<model-glob>"   例: "ollama/qwen3.6*a3b*"
 *   - provider は ollama / openai / anthropic / lmstudio / zai のいずれか
 *   - model-glob はシェル風 glob（* は任意文字列、大文字小文字無視）
 */

/** `.kairos/config.json` と揃える設定ディレクトリ名 */
const CONFIG_DIR_NAME = ".kairos";
/** モデル設定ファイル名 */
const MODEL_SETTINGS_FILENAME = "model-settings.yml";

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as pathResolve, join as pathJoin } from "node:path";
import yaml from "js-yaml";
import { pino } from "pino";

const log = pino({ name: "ModelSettingsRegistry", level: "warn" });

export type EditFormat = "whole" | "diff" | "udiff";

export interface ModelSettings {
  /** glob パターン "<provider>/<model-glob>" */
  match: string;
  /** ネイティブ tool calling を試みるか */
  native_tools: boolean;
  /** エディット形式（現状 whole のみ機能、diff/udiff は将来拡張） */
  edit_format: EditFormat;
  /** Ollama 系のコンテキスト長。null は「送信しない」 */
  num_ctx?: number | null;
  /** プロバイダ素通しの追加パラメータ */
  extra_params?: Record<string, unknown>;
  /** メモ（ログ・ドキュメント用） */
  notes?: string;
}

interface SettingsFile {
  version: number;
  models: ModelSettings[];
}

// ============================================================================
// 同梱デフォルト（src/providers/model-settings.yaml と同期させること）
// ============================================================================

export const BUILTIN_MODEL_SETTINGS: ModelSettings[] = [
  // Ollama - Qwen 系
  {
    match: "ollama/qwen3.6*a3b*",
    native_tools: false,
    edit_format: "whole",
    num_ctx: 16384,
    notes: "MoE Q4 量子化モデル。ネイティブ tool calling 未対応",
  },
  {
    match: "ollama/qwen3.5*",
    native_tools: false,
    edit_format: "whole",
    num_ctx: 16384,
    notes: "小型量子化モデル。tool calling 不安定",
  },
  {
    match: "ollama/qwen2.5-coder*",
    native_tools: true,
    edit_format: "whole",
    num_ctx: 32768,
    notes: "Qwen2.5-Coder は tool calling 対応",
  },
  {
    match: "ollama/qwen*",
    native_tools: true,
    edit_format: "whole",
    num_ctx: 16384,
  },
  // Ollama - Gemma 系
  {
    match: "ollama/gemma*",
    native_tools: false,
    edit_format: "whole",
    num_ctx: 8192,
    notes: "Gemma 系は tool_call テンプレを正しく生成しないことが多い",
  },
  // Ollama - Llama 系
  {
    match: "ollama/llama3.1*",
    native_tools: true,
    edit_format: "whole",
    num_ctx: 8192,
  },
  {
    match: "ollama/llama3*",
    native_tools: true,
    edit_format: "whole",
    num_ctx: 8192,
  },
  {
    match: "ollama/codellama*",
    native_tools: false,
    edit_format: "whole",
    num_ctx: 16384,
    notes: "CodeLlama は tool calling 未対応のバージョンが多い",
  },
  // Ollama - その他
  {
    match: "ollama/deepseek-coder*",
    native_tools: false,
    edit_format: "whole",
    num_ctx: 16384,
  },
  {
    match: "ollama/mistral*",
    native_tools: true,
    edit_format: "whole",
    num_ctx: 16384,
  },
  {
    match: "ollama/*",
    native_tools: true,
    edit_format: "whole",
    num_ctx: 8192,
    notes: "Ollama 汎用フォールバック",
  },
  // LM Studio
  { match: "lmstudio/*qwen3.6*", native_tools: false, edit_format: "whole" },
  { match: "lmstudio/*gemma*", native_tools: false, edit_format: "whole" },
  { match: "lmstudio/*", native_tools: true, edit_format: "whole" },
  // クラウド系
  {
    match: "openai/*",
    native_tools: true,
    edit_format: "whole",
    num_ctx: null,
  },
  {
    match: "anthropic/*",
    native_tools: true,
    edit_format: "whole",
    num_ctx: null,
  },
  { match: "zai/*", native_tools: true, edit_format: "whole", num_ctx: null },
  // 最終フォールバック
  {
    match: "*/*",
    native_tools: true,
    edit_format: "whole",
    num_ctx: null,
    notes: "全プロバイダ・全モデルの最終フォールバック",
  },
];

// ============================================================================
// glob マッチ
// ============================================================================

/**
 * シェル風 glob を正規表現に変換。
 * - `*` は「任意文字列」（`/` も含む）
 * - それ以外は正規表現特殊文字をエスケープ
 * - 大文字小文字無視
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i");
}

/** "<provider>/<model>" 形式の key が glob にマッチするか */
export function matchesGlob(key: string, glob: string): boolean {
  return globToRegExp(glob).test(key);
}

// ============================================================================
// env 変数による上書き（後方互換シム）
// ============================================================================

interface EnvOverride {
  /** 全 Ollama エントリに native_tools: false を強制 */
  disableAllOllamaTools: boolean;
  /** モデル名パターン（カンマ区切り）に一致する Ollama エントリを native_tools: false */
  disableToolsPatterns: string[];
  /** Ollama の num_ctx を一律上書き（null/NaN は無効） */
  numCtxOverride: number | null;
}

function readEnvOverride(): EnvOverride {
  const disableAllOllamaTools =
    process.env.LUNACODE_OLLAMA_DISABLE_TOOLS === "1";

  const disableToolsPatterns = (
    process.env.LUNACODE_OLLAMA_NO_TOOLS_MODELS ?? ""
  )
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  let numCtxOverride: number | null = null;
  const numCtxRaw = process.env.LUNACODE_OLLAMA_NUM_CTX;
  if (numCtxRaw) {
    const n = Number.parseInt(numCtxRaw, 10);
    if (Number.isFinite(n) && n > 0) numCtxOverride = n;
  }

  return { disableAllOllamaTools, disableToolsPatterns, numCtxOverride };
}

let deprecationWarned = false;
function warnDeprecatedEnvOnce(env: EnvOverride): void {
  if (deprecationWarned) return;
  const triggers: string[] = [];
  if (env.disableAllOllamaTools) triggers.push("LUNACODE_OLLAMA_DISABLE_TOOLS");
  if (env.disableToolsPatterns.length > 0)
    triggers.push("LUNACODE_OLLAMA_NO_TOOLS_MODELS");
  if (env.numCtxOverride !== null) triggers.push("LUNACODE_OLLAMA_NUM_CTX");
  if (triggers.length === 0) return;
  deprecationWarned = true;
  log.warn(
    { envVars: triggers },
    "[ModelSettingsRegistry] 環境変数による Ollama 設定上書きは deprecated です。" +
      " ~/.kairos/model-settings.yml または <cwd>/.kairos/model-settings.yml への移行を推奨します。" +
      " 今回はレジストリに上書き適用されます。",
  );
}

/** Ollama エントリに env 上書きを適用して新しい配列を返す（非 Ollama は素通し） */
function applyEnvOverride(
  entries: ModelSettings[],
  env: EnvOverride,
): ModelSettings[] {
  if (
    !env.disableAllOllamaTools &&
    env.disableToolsPatterns.length === 0 &&
    env.numCtxOverride === null
  ) {
    return entries;
  }

  return entries.map((entry) => {
    const isOllama = entry.match.startsWith("ollama/");
    if (!isOllama) return entry;

    let next = { ...entry };

    if (env.disableAllOllamaTools) {
      next = { ...next, native_tools: false };
    } else if (env.disableToolsPatterns.length > 0) {
      // glob の「/」以降（モデル名部分）に対してパターン一致判定
      const modelPart = entry.match.slice("ollama/".length);
      const hit = env.disableToolsPatterns.some((p) => modelPart.includes(p));
      if (hit) next = { ...next, native_tools: false };
    }

    if (env.numCtxOverride !== null) {
      next = { ...next, num_ctx: env.numCtxOverride };
    }

    return next;
  });
}

// ============================================================================
// YAML ファイル読み込み
// ============================================================================

function isModelSettings(v: unknown): v is ModelSettings {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.match !== "string") return false;
  if (typeof o.native_tools !== "boolean") return false;
  if (
    o.edit_format !== "whole" &&
    o.edit_format !== "diff" &&
    o.edit_format !== "udiff"
  )
    return false;
  if (
    o.num_ctx !== undefined &&
    o.num_ctx !== null &&
    typeof o.num_ctx !== "number"
  )
    return false;
  return true;
}

export function parseSettingsYaml(
  content: string,
  source: string,
): ModelSettings[] {
  let parsed: unknown;
  try {
    parsed = yaml.load(content, { filename: source });
  } catch (err) {
    log.warn(
      { source, err: err instanceof Error ? err.message : String(err) },
      "[ModelSettingsRegistry] YAML 解析に失敗",
    );
    return [];
  }

  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;
  const models = obj.models;
  if (!Array.isArray(models)) return [];

  const result: ModelSettings[] = [];
  for (const m of models) {
    if (isModelSettings(m)) {
      result.push(m);
    } else {
      log.warn(
        { source, entry: m },
        "[ModelSettingsRegistry] 不正なエントリをスキップ",
      );
    }
  }
  return result;
}

function loadFileSafe(path: string): ModelSettings[] {
  if (!existsSync(path)) return [];
  try {
    const content = readFileSync(path, "utf8");
    return parseSettingsYaml(content, path);
  } catch (err) {
    log.warn(
      { path, err: err instanceof Error ? err.message : String(err) },
      "[ModelSettingsRegistry] 設定ファイル読み込み失敗",
    );
    return [];
  }
}

// ============================================================================
// レジストリ本体
// ============================================================================

export interface ModelSettingsRegistryOptions {
  /** ~/.kairos の代わりに使うユーザ設定ディレクトリ（テスト用） */
  userConfigDir?: string;
  /** リポジトリルートの上書き（テスト用・明示指定用） */
  repoRoot?: string | null;
  /** cwd の上書き（テスト用） */
  cwd?: string;
  /** 同梱デフォルトを差し替える（テスト用） */
  builtin?: ModelSettings[];
  /** env 上書きをスキップ（テスト用） */
  skipEnvOverride?: boolean;
}

export class ModelSettingsRegistry {
  /**
   * ファイルから読み込んだ生エントリ。env 上書き適用前。
   * env は resolve() 時に毎回参照されるため、ここでは適用しない。
   */
  private readonly rawEntries: ModelSettings[];
  private readonly skipEnvOverride: boolean;

  constructor(options: ModelSettingsRegistryOptions = {}) {
    const {
      userConfigDir,
      repoRoot,
      cwd,
      builtin = BUILTIN_MODEL_SETTINGS,
      skipEnvOverride = false,
    } = options;

    this.skipEnvOverride = skipEnvOverride;

    const userDir = userConfigDir ?? pathJoin(homedir(), CONFIG_DIR_NAME);
    const effectiveCwd = cwd ?? process.cwd();

    // 解決順: cwd → repo-root → user-home → builtin
    const merged: ModelSettings[] = [];

    // 1. <cwd>/.kairos/model-settings.yml
    merged.push(
      ...loadFileSafe(
        pathJoin(effectiveCwd, CONFIG_DIR_NAME, MODEL_SETTINGS_FILENAME),
      ),
    );

    // 2. <repo-root>/.kairos/model-settings.yml（cwd と異なる場合のみ）
    if (repoRoot && pathResolve(repoRoot) !== pathResolve(effectiveCwd)) {
      merged.push(
        ...loadFileSafe(
          pathJoin(repoRoot, CONFIG_DIR_NAME, MODEL_SETTINGS_FILENAME),
        ),
      );
    }

    // 3. ~/.kairos/model-settings.yml
    if (pathResolve(userDir) !== pathResolve(effectiveCwd, CONFIG_DIR_NAME)) {
      merged.push(...loadFileSafe(pathJoin(userDir, MODEL_SETTINGS_FILENAME)));
    }

    // 4. 同梱デフォルト
    merged.push(...builtin);

    this.rawEntries = merged;
  }

  /**
   * env 上書きを適用した現在有効なエントリリスト。
   * env 変数は resolve() 毎に読み直されるため、ランタイム変更に追従できる。
   */
  private currentEntries(): ModelSettings[] {
    if (this.skipEnvOverride) return this.rawEntries;
    const env = readEnvOverride();
    warnDeprecatedEnvOnce(env);
    return applyEnvOverride(this.rawEntries, env);
  }

  /** "<provider>/<model>" に対する設定を解決する。必ず何かを返す（最終フォールバックあり） */
  resolve(providerType: string, model: string): ModelSettings {
    const key = `${providerType}/${model}`;
    for (const entry of this.currentEntries()) {
      if (matchesGlob(key, entry.match)) return entry;
    }
    // 理論上ここには来ない（builtin に "*/*" があるため）が、安全のため
    return {
      match: "*/*",
      native_tools: true,
      edit_format: "whole",
      num_ctx: null,
      notes: "implicit fallback",
    };
  }

  /** 全エントリを返す（env 上書き適用済み、デバッグ用） */
  getAllEntries(): readonly ModelSettings[] {
    return this.currentEntries();
  }
}

// ============================================================================
// シングルトン
// ============================================================================

let singletonRegistry: ModelSettingsRegistry | null = null;

/** プロセス全体で共有するシングルトン。初回呼び出し時にファイルをロード */
export function getModelSettingsRegistry(): ModelSettingsRegistry {
  if (!singletonRegistry) {
    singletonRegistry = new ModelSettingsRegistry();
  }
  return singletonRegistry;
}

/** テスト用: シングルトンをリセット */
export function resetModelSettingsRegistryForTests(): void {
  singletonRegistry = null;
  deprecationWarned = false;
}
