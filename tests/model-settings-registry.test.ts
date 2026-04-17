import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  ModelSettingsRegistry,
  BUILTIN_MODEL_SETTINGS,
  globToRegExp,
  matchesGlob,
  parseSettingsYaml,
  resetModelSettingsRegistryForTests,
  getModelSettingsRegistry,
  type ModelSettings,
} from "../src/providers/ModelSettingsRegistry.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

// ---------------------------------------------------------------------------
// env 退避ユーティリティ
// ---------------------------------------------------------------------------

function withEnv(
  changes: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(changes)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// globToRegExp / matchesGlob
// ---------------------------------------------------------------------------

describe("globToRegExp / matchesGlob", () => {
  test("純粋文字列は完全一致のみマッチ", () => {
    expect(matchesGlob("ollama/qwen3.6", "ollama/qwen3.6")).toBe(true);
    expect(matchesGlob("ollama/qwen3.6x", "ollama/qwen3.6")).toBe(false);
  });

  test("末尾の * は任意文字列にマッチ", () => {
    expect(
      matchesGlob("ollama/qwen2.5-coder:32b", "ollama/qwen2.5-coder*"),
    ).toBe(true);
    expect(matchesGlob("ollama/qwen2.5-coder", "ollama/qwen2.5-coder*")).toBe(
      true,
    );
    expect(matchesGlob("ollama/qwen2.5", "ollama/qwen2.5-coder*")).toBe(false);
  });

  test("中間の * は任意文字列にマッチ", () => {
    expect(
      matchesGlob("ollama/qwen3.6:35b-a3b-q4_K_M", "ollama/qwen3.6*a3b*"),
    ).toBe(true);
    expect(
      matchesGlob("ollama/qwen3.6:35b-q4_K_M", "ollama/qwen3.6*a3b*"),
    ).toBe(false);
  });

  test("大文字小文字を無視する", () => {
    expect(matchesGlob("Ollama/Qwen3.6", "ollama/qwen3.6")).toBe(true);
    expect(matchesGlob("OLLAMA/QWEN3.6", "ollama/qwen3.6*")).toBe(true);
  });

  test("正規表現メタ文字はエスケープされる", () => {
    // "." は正規表現でワイルドカードだが glob ではリテラル
    expect(matchesGlob("ollama/qwen3X6", "ollama/qwen3.6")).toBe(false);
    expect(matchesGlob("ollama/qwen3.6", "ollama/qwen3.6")).toBe(true);
  });

  test("globToRegExp が RegExp を返す", () => {
    const re = globToRegExp("ollama/*");
    expect(re).toBeInstanceOf(RegExp);
    expect(re.test("ollama/llama3")).toBe(true);
    expect(re.test("openai/gpt-4")).toBe(false);
  });

  test("*/* は任意のプロバイダ/モデルにマッチ", () => {
    expect(matchesGlob("ollama/qwen", "*/*")).toBe(true);
    expect(matchesGlob("openai/gpt-4o", "*/*")).toBe(true);
    expect(matchesGlob("anthropic/claude-opus-4-6", "*/*")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 同梱デフォルトの妥当性
// ---------------------------------------------------------------------------

describe("BUILTIN_MODEL_SETTINGS 妥当性", () => {
  test("最終フォールバック */* が存在する", () => {
    const last = BUILTIN_MODEL_SETTINGS[BUILTIN_MODEL_SETTINGS.length - 1];
    expect(last.match).toBe("*/*");
  });

  test("ollama/* 汎用フォールバックが */* より先にある", () => {
    const ollamaFallback = BUILTIN_MODEL_SETTINGS.findIndex(
      (e) => e.match === "ollama/*",
    );
    const finalFallback = BUILTIN_MODEL_SETTINGS.findIndex(
      (e) => e.match === "*/*",
    );
    expect(ollamaFallback).toBeGreaterThan(-1);
    expect(finalFallback).toBeGreaterThan(-1);
    expect(ollamaFallback).toBeLessThan(finalFallback);
  });

  test("qwen3.6*a3b* は qwen* より先にある（具体が汎用より先）", () => {
    const specific = BUILTIN_MODEL_SETTINGS.findIndex(
      (e) => e.match === "ollama/qwen3.6*a3b*",
    );
    const general = BUILTIN_MODEL_SETTINGS.findIndex(
      (e) => e.match === "ollama/qwen*",
    );
    expect(specific).toBeGreaterThan(-1);
    expect(general).toBeGreaterThan(-1);
    expect(specific).toBeLessThan(general);
  });

  test("すべてのエントリが必須フィールドを持つ", () => {
    for (const entry of BUILTIN_MODEL_SETTINGS) {
      expect(typeof entry.match).toBe("string");
      expect(typeof entry.native_tools).toBe("boolean");
      expect(entry.edit_format).toBe("whole");
    }
  });
});

// ---------------------------------------------------------------------------
// resolve() - 基本挙動
// ---------------------------------------------------------------------------

describe("ModelSettingsRegistry.resolve", () => {
  beforeEach(() => {
    resetModelSettingsRegistryForTests();
  });

  test("qwen3.6:35b-a3b-q4_K_M は native_tools=false", () => {
    const reg = new ModelSettingsRegistry({
      skipEnvOverride: true,
      cwd: tmpdir(),
    });
    const s = reg.resolve("ollama", "qwen3.6:35b-a3b-q4_K_M");
    expect(s.native_tools).toBe(false);
    expect(s.edit_format).toBe("whole");
    expect(s.num_ctx).toBe(16384);
  });

  test("qwen2.5-coder:32b は native_tools=true", () => {
    const reg = new ModelSettingsRegistry({
      skipEnvOverride: true,
      cwd: tmpdir(),
    });
    const s = reg.resolve("ollama", "qwen2.5-coder:32b");
    expect(s.native_tools).toBe(true);
    expect(s.num_ctx).toBe(32768);
  });

  test("gemma2:9b は native_tools=false", () => {
    const reg = new ModelSettingsRegistry({
      skipEnvOverride: true,
      cwd: tmpdir(),
    });
    const s = reg.resolve("ollama", "gemma2:9b");
    expect(s.native_tools).toBe(false);
    expect(s.num_ctx).toBe(8192);
  });

  test("llama3.1:8b は native_tools=true", () => {
    const reg = new ModelSettingsRegistry({
      skipEnvOverride: true,
      cwd: tmpdir(),
    });
    const s = reg.resolve("ollama", "llama3.1:8b");
    expect(s.native_tools).toBe(true);
  });

  test("未知の ollama モデルは ollama/* にフォールバック", () => {
    const reg = new ModelSettingsRegistry({
      skipEnvOverride: true,
      cwd: tmpdir(),
    });
    const s = reg.resolve("ollama", "unknown-model-xyz");
    expect(s.match).toBe("ollama/*");
    expect(s.native_tools).toBe(true);
  });

  test("openai/gpt-4o は native_tools=true で num_ctx=null", () => {
    const reg = new ModelSettingsRegistry({
      skipEnvOverride: true,
      cwd: tmpdir(),
    });
    const s = reg.resolve("openai", "gpt-4o");
    expect(s.native_tools).toBe(true);
    expect(s.num_ctx).toBe(null);
  });

  test("未知プロバイダは */* にフォールバック", () => {
    const reg = new ModelSettingsRegistry({
      skipEnvOverride: true,
      cwd: tmpdir(),
    });
    const s = reg.resolve("unknown-provider", "some-model");
    expect(s.match).toBe("*/*");
    expect(s.native_tools).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// env 変数上書き（後方互換）
// ---------------------------------------------------------------------------

describe("ModelSettingsRegistry env 上書き", () => {
  beforeEach(() => {
    resetModelSettingsRegistryForTests();
  });

  test("LUNACODE_OLLAMA_DISABLE_TOOLS=1 で全 Ollama モデルが native_tools=false", () => {
    withEnv(
      {
        LUNACODE_OLLAMA_DISABLE_TOOLS: "1",
        LUNACODE_OLLAMA_NO_TOOLS_MODELS: undefined,
      },
      () => {
        const reg = new ModelSettingsRegistry({ cwd: tmpdir() });
        // 本来 native_tools=true のモデルも disabled に
        expect(reg.resolve("ollama", "llama3.1:8b").native_tools).toBe(false);
        expect(reg.resolve("ollama", "qwen2.5-coder:32b").native_tools).toBe(
          false,
        );
        // OpenAI 系は影響を受けない
        expect(reg.resolve("openai", "gpt-4o").native_tools).toBe(true);
      },
    );
  });

  test("LUNACODE_OLLAMA_NO_TOOLS_MODELS でパターンに一致したエントリだけ disable", () => {
    withEnv(
      {
        LUNACODE_OLLAMA_DISABLE_TOOLS: undefined,
        LUNACODE_OLLAMA_NO_TOOLS_MODELS: "qwen2.5-coder",
      },
      () => {
        const reg = new ModelSettingsRegistry({ cwd: tmpdir() });
        expect(reg.resolve("ollama", "qwen2.5-coder:32b").native_tools).toBe(
          false,
        );
        expect(reg.resolve("ollama", "llama3.1:8b").native_tools).toBe(true);
      },
    );
  });

  test("LUNACODE_OLLAMA_NUM_CTX が全 Ollama エントリの num_ctx を上書き", () => {
    withEnv(
      {
        LUNACODE_OLLAMA_DISABLE_TOOLS: undefined,
        LUNACODE_OLLAMA_NO_TOOLS_MODELS: undefined,
        LUNACODE_OLLAMA_NUM_CTX: "65536",
      },
      () => {
        const reg = new ModelSettingsRegistry({ cwd: tmpdir() });
        // デフォルトでは 8192 の llama3.1 も上書きされる
        expect(reg.resolve("ollama", "llama3.1:8b").num_ctx).toBe(65536);
        // デフォルト 16384 の qwen3.6 も上書きされる
        expect(reg.resolve("ollama", "qwen3.6:35b-a3b-q4_K_M").num_ctx).toBe(
          65536,
        );
        // OpenAI 系は null のまま
        expect(reg.resolve("openai", "gpt-4o").num_ctx).toBe(null);
      },
    );
  });

  test("不正な LUNACODE_OLLAMA_NUM_CTX は無視される", () => {
    withEnv(
      {
        LUNACODE_OLLAMA_NUM_CTX: "not-a-number",
      },
      () => {
        const reg = new ModelSettingsRegistry({ cwd: tmpdir() });
        expect(reg.resolve("ollama", "llama3.1:8b").num_ctx).toBe(8192);
      },
    );
  });

  test("env 変数はランタイムで切り替えても resolve に即反映", () => {
    const reg = new ModelSettingsRegistry({ cwd: tmpdir() });
    // 最初は env なし → native_tools=true
    withEnv({ LUNACODE_OLLAMA_DISABLE_TOOLS: undefined }, () => {
      expect(reg.resolve("ollama", "llama3.1:8b").native_tools).toBe(true);
    });
    // env を立てると即座に反映
    withEnv({ LUNACODE_OLLAMA_DISABLE_TOOLS: "1" }, () => {
      expect(reg.resolve("ollama", "llama3.1:8b").native_tools).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// ユーザファイル上書き
// ---------------------------------------------------------------------------

describe("ModelSettingsRegistry ユーザファイル上書き", () => {
  let tempRoot: string;

  beforeEach(() => {
    resetModelSettingsRegistryForTests();
    tempRoot = mkdtempSync(pathJoin(tmpdir(), "lunacode-reg-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("~/.kairos/model-settings.yml の上書きが builtin に優先される", () => {
    const userDir = pathJoin(tempRoot, "userhome", ".kairos");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      pathJoin(userDir, "model-settings.yml"),
      `version: 1
models:
  - match: "ollama/llama3.1*"
    native_tools: false
    edit_format: whole
    num_ctx: 99999
    notes: "user override"
`,
      "utf8",
    );
    const reg = new ModelSettingsRegistry({
      userConfigDir: userDir,
      cwd: tmpdir(),
      skipEnvOverride: true,
    });
    const s = reg.resolve("ollama", "llama3.1:8b");
    expect(s.native_tools).toBe(false);
    expect(s.num_ctx).toBe(99999);
    expect(s.notes).toBe("user override");
  });

  test("cwd/.kairos/ の上書きが ~/.kairos/ より優先される", () => {
    const userDir = pathJoin(tempRoot, "userhome", ".kairos");
    const cwdDir = pathJoin(tempRoot, "cwd");
    const cwdConfDir = pathJoin(cwdDir, ".kairos");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(cwdConfDir, { recursive: true });

    writeFileSync(
      pathJoin(userDir, "model-settings.yml"),
      `version: 1
models:
  - match: "ollama/llama3.1*"
    native_tools: false
    edit_format: whole
    num_ctx: 1111
`,
      "utf8",
    );
    writeFileSync(
      pathJoin(cwdConfDir, "model-settings.yml"),
      `version: 1
models:
  - match: "ollama/llama3.1*"
    native_tools: true
    edit_format: whole
    num_ctx: 2222
`,
      "utf8",
    );

    const reg = new ModelSettingsRegistry({
      userConfigDir: userDir,
      cwd: cwdDir,
      skipEnvOverride: true,
    });
    const s = reg.resolve("ollama", "llama3.1:8b");
    // cwd 勝ち
    expect(s.num_ctx).toBe(2222);
    expect(s.native_tools).toBe(true);
  });

  test("不正な YAML は警告出力してスキップ（builtin が使われる）", () => {
    const userDir = pathJoin(tempRoot, "userhome", ".kairos");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      pathJoin(userDir, "model-settings.yml"),
      "this is not: valid yaml: : :",
      "utf8",
    );
    const reg = new ModelSettingsRegistry({
      userConfigDir: userDir,
      cwd: tmpdir(),
      skipEnvOverride: true,
    });
    // builtin デフォルトが効く
    const s = reg.resolve("ollama", "llama3.1:8b");
    expect(s.match).toBe("ollama/llama3.1*");
  });

  test("エントリのフィールド欠落は個別スキップ、他のエントリは有効", () => {
    const userDir = pathJoin(tempRoot, "userhome", ".kairos");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      pathJoin(userDir, "model-settings.yml"),
      `version: 1
models:
  - match: "ollama/broken*"
    # native_tools 欠落
    edit_format: whole
  - match: "ollama/good*"
    native_tools: false
    edit_format: whole
    num_ctx: 12345
`,
      "utf8",
    );
    const reg = new ModelSettingsRegistry({
      userConfigDir: userDir,
      cwd: tmpdir(),
      skipEnvOverride: true,
    });
    const good = reg.resolve("ollama", "good-model");
    expect(good.num_ctx).toBe(12345);
    expect(good.native_tools).toBe(false);
    // broken は builtin の ollama/* にフォールバック
    const broken = reg.resolve("ollama", "broken-model");
    expect(broken.match).toBe("ollama/*");
  });
});

// ---------------------------------------------------------------------------
// parseSettingsYaml 単体
// ---------------------------------------------------------------------------

describe("parseSettingsYaml", () => {
  test("正常な YAML をパースできる", () => {
    const yaml = `version: 1
models:
  - match: "ollama/llama3.1*"
    native_tools: true
    edit_format: whole
    num_ctx: 8192
`;
    const result = parseSettingsYaml(yaml, "test");
    expect(result).toHaveLength(1);
    expect(result[0].match).toBe("ollama/llama3.1*");
  });

  test("models が配列でなければ空配列", () => {
    const yaml = `version: 1
models: "not an array"
`;
    const result = parseSettingsYaml(yaml, "test");
    expect(result).toEqual([]);
  });

  test("空入力は空配列", () => {
    expect(parseSettingsYaml("", "test")).toEqual([]);
  });

  test("edit_format が不正なエントリはスキップ", () => {
    const yaml = `version: 1
models:
  - match: "foo/bar"
    native_tools: true
    edit_format: invalid
  - match: "foo/baz"
    native_tools: true
    edit_format: whole
`;
    const result = parseSettingsYaml(yaml, "test");
    expect(result).toHaveLength(1);
    expect(result[0].match).toBe("foo/baz");
  });

  test("num_ctx が数値でも null でもなければスキップ", () => {
    const yaml = `version: 1
models:
  - match: "foo/bar"
    native_tools: true
    edit_format: whole
    num_ctx: "not a number"
  - match: "foo/baz"
    native_tools: true
    edit_format: whole
    num_ctx: null
`;
    const result = parseSettingsYaml(yaml, "test");
    expect(result).toHaveLength(1);
    expect(result[0].match).toBe("foo/baz");
  });
});

// ---------------------------------------------------------------------------
// シングルトン
// ---------------------------------------------------------------------------

describe("getModelSettingsRegistry シングルトン", () => {
  beforeEach(() => {
    resetModelSettingsRegistryForTests();
  });

  test("同じインスタンスを返す", () => {
    const a = getModelSettingsRegistry();
    const b = getModelSettingsRegistry();
    expect(a).toBe(b);
  });

  test("reset 後は新しいインスタンス", () => {
    const a = getModelSettingsRegistry();
    resetModelSettingsRegistryForTests();
    const b = getModelSettingsRegistry();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 型検証
// ---------------------------------------------------------------------------

describe("ModelSettings 型", () => {
  test("最小限のエントリが作れる", () => {
    const s: ModelSettings = {
      match: "foo/*",
      native_tools: true,
      edit_format: "whole",
    };
    expect(s.match).toBe("foo/*");
  });
});
