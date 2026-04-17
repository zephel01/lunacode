/**
 * SyntaxValidator のユニットテスト。
 *
 * 対象:
 *  - detectLanguage: 拡張子からの言語判定
 *  - validateSyntax: JSON/YAML の成功・失敗パス（外部コマンド不要）
 *  - setValidationConfig / resetValidationConfigForTests: 設定の切り替え
 *  - formatValidationWarning: 警告メッセージの整形
 *
 * 外部コマンド (node --check / bun build / tsc / python3) を使う言語は、
 * CI 環境によって存在しないので対応外拡張子と同じくスキップ扱いされる
 * ことのみ保証する（成功・失敗の具体挙動は統合テスト側で検証する）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import {
  detectLanguage,
  validateSyntax,
  setValidationConfig,
  resetValidationConfigForTests,
  formatValidationWarning,
} from "../src/tools/SyntaxValidator.js";

describe("detectLanguage", () => {
  test("JSON 拡張子を認識", () => {
    expect(detectLanguage("/tmp/foo.json")).toBe("json");
    expect(detectLanguage("FOO.JSON")).toBe("json");
  });

  test("YAML 拡張子を認識（yml / yaml）", () => {
    expect(detectLanguage("/tmp/a.yml")).toBe("yaml");
    expect(detectLanguage("/tmp/a.yaml")).toBe("yaml");
  });

  test("JS 系拡張子を認識（js / mjs / cjs / jsx）", () => {
    expect(detectLanguage("a.js")).toBe("javascript");
    expect(detectLanguage("a.mjs")).toBe("javascript");
    expect(detectLanguage("a.cjs")).toBe("javascript");
    expect(detectLanguage("a.jsx")).toBe("javascript");
  });

  test("TS 系拡張子を認識（ts / tsx）", () => {
    expect(detectLanguage("a.ts")).toBe("typescript");
    expect(detectLanguage("a.tsx")).toBe("typescript");
  });

  test("Python 拡張子を認識", () => {
    expect(detectLanguage("script.py")).toBe("python");
  });

  test("未対応の拡張子は null", () => {
    expect(detectLanguage("README.md")).toBeNull();
    expect(detectLanguage("noext")).toBeNull();
    expect(detectLanguage("a.rs")).toBeNull();
  });
});

describe("validateSyntax - JSON", () => {
  beforeEach(() => {
    resetValidationConfigForTests();
  });

  test("有効な JSON は valid=true", async () => {
    const result = await validateSyntax("/tmp/x.json", '{"a": 1}');
    expect(result.validated).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.language).toBe("json");
    expect(result.validator).toBe("JSON.parse");
  });

  test("破損した JSON は valid=false + errorMessage", async () => {
    const result = await validateSyntax("/tmp/x.json", "{a: 1,,}");
    expect(result.validated).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.language).toBe("json");
    expect(result.errorMessage).toBeDefined();
    expect(result.errorMessage!.length).toBeGreaterThan(0);
  });
});

describe("validateSyntax - YAML", () => {
  beforeEach(() => {
    resetValidationConfigForTests();
  });

  test("有効な YAML は valid=true", async () => {
    const result = await validateSyntax(
      "/tmp/x.yml",
      "version: 1\nitems:\n  - a\n  - b\n",
    );
    expect(result.validated).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.language).toBe("yaml");
    expect(result.validator).toBe("js-yaml");
  });

  test("破損した YAML は valid=false", async () => {
    const result = await validateSyntax(
      "/tmp/x.yaml",
      "foo: [1, 2\nbar: baz\n",
    );
    expect(result.validated).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.language).toBe("yaml");
    expect(result.errorMessage).toBeDefined();
  });
});

describe("validateSyntax - 設定", () => {
  beforeEach(() => {
    resetValidationConfigForTests();
  });

  test("enabled=false なら validated=false", async () => {
    setValidationConfig({ enabled: false });
    const result = await validateSyntax("/tmp/x.json", "{bad json}");
    expect(result.validated).toBe(false);
    expect(result.valid).toBe(true);
  });

  test("postWrite=false なら validated=false", async () => {
    setValidationConfig({ postWrite: false });
    const result = await validateSyntax("/tmp/x.json", "{bad json}");
    expect(result.validated).toBe(false);
    expect(result.valid).toBe(true);
  });

  test("languages.json=false なら json はスキップ", async () => {
    setValidationConfig({ languages: { json: false } });
    const result = await validateSyntax("/tmp/x.json", "{bad json}");
    expect(result.validated).toBe(false);
    expect(result.valid).toBe(true);
    expect(result.language).toBe("json");
  });

  test("対応外拡張子は validated=false", async () => {
    const result = await validateSyntax("/tmp/README.md", "# Hello");
    expect(result.validated).toBe(false);
    expect(result.valid).toBe(true);
  });
});

describe("validateSyntax - 実ファイル (JS/TS/Python)", () => {
  let tempDir: string;

  beforeEach(() => {
    resetValidationConfigForTests();
    tempDir = mkdtempSync(pathJoin(tmpdir(), "syntax-validator-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // 外部コマンド未インストール環境では notFound で {validated:false} が返る
  // そのため result.validated=false でも合格とする。
  test("有効な JS は valid=true もしくはスキップ", async () => {
    const filePath = pathJoin(tempDir, "ok.js");
    const content = "const a = 1;\nconsole.log(a);\n";
    writeFileSync(filePath, content);
    const result = await validateSyntax(filePath, content);
    if (result.validated) {
      expect(result.valid).toBe(true);
      expect(result.language).toBe("javascript");
    } else {
      // node が PATH に無い環境
      expect(result.valid).toBe(true);
    }
  });

  test("破損した JS は valid=false もしくはスキップ", async () => {
    const filePath = pathJoin(tempDir, "bad.js");
    const content = "const a = ;\n";
    writeFileSync(filePath, content);
    const result = await validateSyntax(filePath, content);
    if (result.validated) {
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toBeDefined();
    }
  });

  test("有効な Python は valid=true もしくはスキップ", async () => {
    const filePath = pathJoin(tempDir, "ok.py");
    const content = "x = 1\nprint(x)\n";
    writeFileSync(filePath, content);
    const result = await validateSyntax(filePath, content);
    if (result.validated) {
      expect(result.valid).toBe(true);
      expect(result.language).toBe("python");
    }
  });

  test("破損した Python は valid=false もしくはスキップ", async () => {
    const filePath = pathJoin(tempDir, "bad.py");
    const content = "def (:\n";
    writeFileSync(filePath, content);
    const result = await validateSyntax(filePath, content);
    if (result.validated) {
      expect(result.valid).toBe(false);
    }
  });
});

describe("formatValidationWarning", () => {
  test("valid な結果では空文字列", () => {
    expect(
      formatValidationWarning({
        validated: true,
        valid: true,
        language: "json",
      }),
    ).toBe("");
  });

  test("validated=false では空文字列", () => {
    expect(formatValidationWarning({ validated: false, valid: true })).toBe("");
  });

  test("valid=false では警告ブロックを返す", () => {
    const msg = formatValidationWarning({
      validated: true,
      valid: false,
      language: "json",
      validator: "JSON.parse",
      errorMessage: "Unexpected token 'a'",
    });
    expect(msg).toContain("Syntax check failed");
    expect(msg).toContain("JSON.parse");
    expect(msg).toContain("Unexpected token");
  });

  test("非常に長い errorMessage は truncated される", () => {
    const longMsg = "x".repeat(5000);
    const formatted = formatValidationWarning({
      validated: true,
      valid: false,
      errorMessage: longMsg,
    });
    expect(formatted.length).toBeLessThan(longMsg.length);
    expect(formatted).toContain("truncated");
  });
});
