/**
 * SyntaxValidator - write_file / edit_file 成功後に呼ばれる構文チェッカー。
 *
 * 失敗してもファイルは保存される（ツールとしては成功）。代わりに警告文字列を
 * ツール応答に付与し、次イテレーションで LLM が自発的に直せるようにする。
 *
 * 対応:
 *   - JSON          : 内蔵 JSON.parse（常時）
 *   - YAML (.yml/.yaml) : 内蔵 js-yaml（常時）
 *   - JavaScript (.js/.mjs/.cjs) : `node --check` （node があれば）
 *   - TypeScript (.ts/.tsx) : `bun build --no-bundle` → fallback `tsc --noEmit`
 *   - Python (.py)  : `python3 -c "import ast; ast.parse(...)"`
 *
 * 対応外の拡張子は何もしない（validated=false で返す）。
 * 外部コマンドが PATH に無い場合も静かにスキップする（毎回警告しない）。
 */

import { spawn } from "node:child_process";
import yaml from "js-yaml";

// ============================================================================
// 型定義
// ============================================================================

export type ValidatorLanguage =
  | "json"
  | "yaml"
  | "javascript"
  | "typescript"
  | "python";

/** 設定: 言語ごとに on/off。未指定は true（有効） */
export interface ValidationConfig {
  enabled?: boolean;
  postWrite?: boolean;
  languages?: Partial<Record<ValidatorLanguage, boolean>>;
  /** TypeScript チェックに使うコマンドを固定したい場合 ("bun" | "tsc" | "auto") */
  typescriptChecker?: "bun" | "tsc" | "auto";
}

export interface ValidationResult {
  /** validator が動いたか（対応外拡張子や設定 OFF だと false） */
  validated: boolean;
  /** 構文 OK か。validated=false なら常に true */
  valid: boolean;
  /** 検出言語（判定できなければ undefined） */
  language?: ValidatorLanguage;
  /** 利用した validator 名（例: "node --check"） */
  validator?: string;
  /** 失敗時のエラーメッセージ（stderr 由来を整形済み） */
  errorMessage?: string;
}

// ============================================================================
// 設定シングルトン（AgentLoop.initialize が上書き、未設定なら全て有効）
// ============================================================================

const DEFAULT_CONFIG: Required<Omit<ValidationConfig, "languages">> & {
  languages: Required<Record<ValidatorLanguage, boolean>>;
} = {
  enabled: true,
  postWrite: true,
  languages: {
    json: true,
    yaml: true,
    javascript: true,
    typescript: true,
    python: true,
  },
  typescriptChecker: "auto",
};

let currentConfig: typeof DEFAULT_CONFIG = { ...DEFAULT_CONFIG };

/** 現在の設定を取得（読み取り専用） */
export function getValidationConfig(): Readonly<typeof DEFAULT_CONFIG> {
  return currentConfig;
}

/** 設定を上書き（AgentLoop.initialize から呼ばれる想定） */
export function setValidationConfig(
  config: ValidationConfig | undefined,
): void {
  if (!config) {
    currentConfig = { ...DEFAULT_CONFIG };
    return;
  }
  currentConfig = {
    enabled: config.enabled ?? DEFAULT_CONFIG.enabled,
    postWrite: config.postWrite ?? DEFAULT_CONFIG.postWrite,
    typescriptChecker:
      config.typescriptChecker ?? DEFAULT_CONFIG.typescriptChecker,
    languages: {
      json: config.languages?.json ?? DEFAULT_CONFIG.languages.json,
      yaml: config.languages?.yaml ?? DEFAULT_CONFIG.languages.yaml,
      javascript:
        config.languages?.javascript ?? DEFAULT_CONFIG.languages.javascript,
      typescript:
        config.languages?.typescript ?? DEFAULT_CONFIG.languages.typescript,
      python: config.languages?.python ?? DEFAULT_CONFIG.languages.python,
    },
  };
}

/** テスト用: デフォルトに戻す */
export function resetValidationConfigForTests(): void {
  currentConfig = { ...DEFAULT_CONFIG };
}

// ============================================================================
// 拡張子 → 言語判定
// ============================================================================

export function detectLanguage(filePath: string): ValidatorLanguage | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (
    lower.endsWith(".js") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs") ||
    lower.endsWith(".jsx")
  )
    return "javascript";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".py")) return "python";
  return null;
}

// ============================================================================
// 外部コマンドのヘルパー
// ============================================================================

interface RunOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** PATH に command が無かったケース */
  notFound: boolean;
  /** 何らかの理由で実行できなかった（権限エラー等） */
  spawnError?: string;
}

async function runCommand(
  command: string,
  args: string[],
  options: { stdin?: string; timeoutMs?: number } = {},
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      shell: false,
      timeout: options.timeoutMs ?? 10000,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        resolve({ ok: false, stdout, stderr, notFound: true });
      } else {
        resolve({
          ok: false,
          stdout,
          stderr,
          notFound: false,
          spawnError: err.message,
        });
      }
    });
    proc.on("close", (code: number | null) => {
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        notFound: false,
      });
    });
    if (options.stdin !== undefined && proc.stdin) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    }
  });
}

// ============================================================================
// 個別 validator
// ============================================================================

function validateJson(content: string): ValidationResult {
  try {
    JSON.parse(content);
    return {
      validated: true,
      valid: true,
      language: "json",
      validator: "JSON.parse",
    };
  } catch (error) {
    return {
      validated: true,
      valid: false,
      language: "json",
      validator: "JSON.parse",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateYaml(content: string): ValidationResult {
  try {
    yaml.load(content);
    return {
      validated: true,
      valid: true,
      language: "yaml",
      validator: "js-yaml",
    };
  } catch (error) {
    return {
      validated: true,
      valid: false,
      language: "yaml",
      validator: "js-yaml",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

async function validateJavaScript(filePath: string): Promise<ValidationResult> {
  const result = await runCommand("node", ["--check", filePath], {
    timeoutMs: 10000,
  });
  if (result.notFound) {
    // node が無ければ黙ってスキップ
    return {
      validated: false,
      valid: true,
      language: "javascript",
    };
  }
  if (result.ok) {
    return {
      validated: true,
      valid: true,
      language: "javascript",
      validator: "node --check",
    };
  }
  const combined = (result.stderr || result.stdout || "").trim();
  return {
    validated: true,
    valid: false,
    language: "javascript",
    validator: "node --check",
    errorMessage: combined || result.spawnError || "Unknown syntax error",
  };
}

async function validateTypeScript(filePath: string): Promise<ValidationResult> {
  const mode = currentConfig.typescriptChecker;
  const tryBun = mode === "bun" || mode === "auto";
  const tryTsc = mode === "tsc" || mode === "auto";

  // 1. bun build --no-bundle で高速 parse チェック（型チェックは軽め）
  if (tryBun) {
    const bunResult = await runCommand(
      "bun",
      ["build", "--no-bundle", filePath, "--outdir", "/tmp/.lunacode-syntax"],
      { timeoutMs: 15000 },
    );
    if (!bunResult.notFound) {
      if (bunResult.ok) {
        return {
          validated: true,
          valid: true,
          language: "typescript",
          validator: "bun build --no-bundle",
        };
      }
      // bun build はテンポラリ出力するので失敗=構文エラー
      const combined = (bunResult.stderr || bunResult.stdout || "").trim();
      return {
        validated: true,
        valid: false,
        language: "typescript",
        validator: "bun build --no-bundle",
        errorMessage: combined || "TypeScript build failed",
      };
    }
  }

  // 2. tsc --noEmit にフォールバック
  if (tryTsc) {
    // --allowJs なしで単一ファイル。外部参照でエラーが出ないよう --skipLibCheck などは付けず
    // --noEmit で構文だけ検証する（型エラーは出得るが、警告として表示する）
    const tscResult = await runCommand(
      "tsc",
      ["--noEmit", "--skipLibCheck", "--target", "es2020", filePath],
      { timeoutMs: 20000 },
    );
    if (!tscResult.notFound) {
      if (tscResult.ok) {
        return {
          validated: true,
          valid: true,
          language: "typescript",
          validator: "tsc --noEmit",
        };
      }
      const combined = (tscResult.stdout || tscResult.stderr || "").trim();
      return {
        validated: true,
        valid: false,
        language: "typescript",
        validator: "tsc --noEmit",
        errorMessage: combined || "tsc reported errors",
      };
    }
  }

  // どちらも無い
  return {
    validated: false,
    valid: true,
    language: "typescript",
  };
}

async function validatePython(filePath: string): Promise<ValidationResult> {
  // python -c でソースを読み込んで ast.parse。bytes 引数にファイルパスを渡す
  const pySnippet = `import ast,sys;src=open(sys.argv[1],'rb').read();ast.parse(src)`;
  for (const cmd of ["python3", "python"]) {
    const result = await runCommand(cmd, ["-c", pySnippet, filePath], {
      timeoutMs: 10000,
    });
    if (result.notFound) continue;
    if (result.ok) {
      return {
        validated: true,
        valid: true,
        language: "python",
        validator: `${cmd} -c ast.parse`,
      };
    }
    const combined = (result.stderr || result.stdout || "").trim();
    return {
      validated: true,
      valid: false,
      language: "python",
      validator: `${cmd} -c ast.parse`,
      errorMessage: combined || "Python syntax error",
    };
  }
  // python が無ければスキップ
  return {
    validated: false,
    valid: true,
    language: "python",
  };
}

// ============================================================================
// エントリポイント
// ============================================================================

/**
 * `filePath` の拡張子に応じて構文チェックを行う。
 *
 * - 設定で無効 / 対応外の拡張子 / 外部コマンド無し → `{ validated: false, valid: true }`
 * - 構文 OK → `{ validated: true, valid: true, validator }`
 * - 構文 NG → `{ validated: true, valid: false, errorMessage }`
 *
 * この関数自体は例外を投げない（呼び出し側のフローを壊さない）。
 */
export async function validateSyntax(
  filePath: string,
  content: string,
): Promise<ValidationResult> {
  const cfg = currentConfig;
  if (!cfg.enabled || !cfg.postWrite) {
    return { validated: false, valid: true };
  }

  const language = detectLanguage(filePath);
  if (!language) {
    return { validated: false, valid: true };
  }
  if (!cfg.languages[language]) {
    return { validated: false, valid: true, language };
  }

  try {
    switch (language) {
      case "json":
        return validateJson(content);
      case "yaml":
        return validateYaml(content);
      case "javascript":
        return await validateJavaScript(filePath);
      case "typescript":
        return await validateTypeScript(filePath);
      case "python":
        return await validatePython(filePath);
    }
  } catch (error) {
    // どの validator も内部では例外を握るが、念のためのフォールバック
    return {
      validated: false,
      valid: true,
      language,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * ツール応答文字列に付与する警告ブロックを整形する。
 * validateSyntax の結果が valid なら空文字列を返す。
 */
export function formatValidationWarning(result: ValidationResult): string {
  if (!result.validated || result.valid) return "";
  const header = `\n\n⚠️ Syntax check failed (${result.validator ?? result.language ?? "?"}):`;
  const body = (result.errorMessage ?? "").trim();
  // LLM 応答が冗長にならないよう、長大な stderr は 1500 文字で丸める
  const truncated =
    body.length > 1500 ? body.slice(0, 1500) + "\n...(truncated)" : body;
  return `${header}\n${truncated}`;
}
