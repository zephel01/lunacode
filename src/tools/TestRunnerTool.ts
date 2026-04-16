/**
 * Phase 21: テスト実行ツール（SWE-bench 対応）
 *
 * SWE-bench ワークフロー「パッチ適用 → テスト実行 → 結果確認」の
 * テスト実行フェーズを担う。複数のテストフレームワークに対応し、
 * 構造化された結果（pass/fail/error 件数）を返す。
 *
 * 対応フレームワーク:
 *   - pytest  (Python)
 *   - unittest (Python)
 *   - jest    (Node.js)
 *   - vitest  (Node.js)
 *   - bun     (Bun)
 *   - go test (Go)
 *   - cargo test (Rust)
 *   - make test  (汎用 Makefile)
 */

import { BaseTool } from "./BaseTool.js";
import { ToolResult } from "../types/index.js";
import { spawn } from "child_process";
import { promises as fsp } from "fs";
import { existsSync, readFileSync } from "fs"; // Makefile 同期読み込みは当面残す
import { join, resolve } from "path";

// ──────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────

export type TestFramework =
  | "pytest"
  | "unittest"
  | "jest"
  | "vitest"
  | "bun"
  | "go"
  | "cargo"
  | "make"
  | "auto";

export interface TestResult {
  /** フレームワーク名 */
  framework: string;
  /** 合計テスト数 */
  total: number;
  /** 成功数 */
  passed: number;
  /** 失敗数 */
  failed: number;
  /** エラー数（実行時エラー） */
  errors: number;
  /** スキップ数 */
  skipped: number;
  /** 失敗・エラーのテスト名リスト */
  failedTests: string[];
  /** 実行時間（秒） */
  duration: number;
  /** 全体の stdout + stderr */
  rawOutput: string;
}

// ──────────────────────────────────────────────
// フレームワーク自動検出
// ──────────────────────────────────────────────

// CWD → 検出結果のキャッシュ（TTL 60 秒）
const DETECT_CACHE_TTL_MS = 60_000;
const CWD_DETECT_CACHE = new Map<string, { framework: TestFramework; ts: number }>();

const MARKER_FILES = [
  "Cargo.toml",
  "go.mod",
  "pytest.ini",
  "pyproject.toml",
  "setup.cfg",
  "conftest.py",
  "package.json",
  "bun.lockb",
  "Makefile",
  "setup.py",
] as const;

async function detectFramework(cwd: string): Promise<TestFramework> {
  const cached = CWD_DETECT_CACHE.get(cwd);
  if (cached && Date.now() - cached.ts < DETECT_CACHE_TTL_MS) {
    return cached.framework;
  }

  // マーカーファイルの存在を並列 stat
  const statResults = await Promise.allSettled(
    MARKER_FILES.map((m) => fsp.stat(join(cwd, m))),
  );
  const exists = new Map<string, boolean>();
  MARKER_FILES.forEach((m, i) => exists.set(m, statResults[i].status === "fulfilled"));

  const framework = await resolveFrameworkFromMarkers(cwd, exists);
  CWD_DETECT_CACHE.set(cwd, { framework, ts: Date.now() });
  return framework;
}

async function resolveFrameworkFromMarkers(
  cwd: string,
  exists: Map<string, boolean>,
): Promise<TestFramework> {
  if (exists.get("Cargo.toml")) return "cargo";
  if (exists.get("go.mod")) return "go";

  if (
    exists.get("pytest.ini") ||
    exists.get("pyproject.toml") ||
    exists.get("setup.cfg") ||
    exists.get("conftest.py")
  ) {
    return "pytest";
  }

  if (exists.get("package.json")) {
    try {
      const raw = await fsp.readFile(join(cwd, "package.json"), "utf-8");
      const pkg = JSON.parse(raw) as {
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      const testScript = pkg.scripts?.test ?? "";
      const allDeps = { ...pkg.devDependencies, ...pkg.dependencies };
      if (exists.get("bun.lockb") || testScript.includes("bun")) return "bun";
      if ("vitest" in allDeps || testScript.includes("vitest")) return "vitest";
      if ("jest" in allDeps || testScript.includes("jest")) return "jest";
      return "jest";
    } catch {
      // parse error → fall through
    }
  }

  if (exists.get("Makefile")) {
    const content = await fsp.readFile(join(cwd, "Makefile"), "utf-8");
    if (/^test\s*:/m.test(content)) return "make";
  }

  if (exists.get("setup.py")) return "pytest";

  return "pytest"; // SWE-bench はほぼ Python
}

// ──────────────────────────────────────────────
// コマンドビルダ
// ──────────────────────────────────────────────

interface RunConfig {
  cmd: string;
  args: string[];
}

function buildCommand(
  framework: TestFramework,
  testFile?: string,
  testFilter?: string,
  extraArgs?: string[],
): RunConfig {
  const extra = extraArgs ?? [];

  switch (framework) {
    case "pytest": {
      const args = [
        "-v",
        "--tb=short",
        "--no-header",
        "-rN", // suppress extra summary lines, keep failures
      ];
      if (testFile) args.push(testFile);
      if (testFilter) args.push("-k", testFilter);
      args.push(...extra);
      return { cmd: "python", args: ["-m", "pytest", ...args] };
    }

    case "unittest": {
      const args = ["-m", "unittest"];
      if (testFile) {
        // convert path to module: tests/foo.py → tests.foo
        const mod = testFile.replace(/\//g, ".").replace(/\.py$/, "");
        args.push(mod);
      } else {
        args.push("discover", "-v");
      }
      args.push(...extra);
      return { cmd: "python", args };
    }

    case "jest": {
      const args = ["--no-coverage"];
      if (testFile) args.push(testFile);
      if (testFilter) args.push("-t", testFilter);
      args.push(...extra);
      return { cmd: "npx", args: ["jest", ...args] };
    }

    case "vitest": {
      const args = ["run"];
      if (testFile) args.push(testFile);
      if (testFilter) args.push("-t", testFilter);
      args.push(...extra);
      return { cmd: "npx", args: ["vitest", ...args] };
    }

    case "bun": {
      const args = ["test"];
      if (testFile) args.push(testFile);
      if (testFilter) args.push("--test-name-pattern", testFilter);
      args.push(...extra);
      return { cmd: "bun", args };
    }

    case "go": {
      const args = ["test", "-v"];
      if (testFile) {
        args.push(testFile);
      } else {
        args.push("./...");
      }
      if (testFilter) args.push("-run", testFilter);
      args.push(...extra);
      return { cmd: "go", args };
    }

    case "cargo": {
      const args = ["test"];
      if (testFilter) args.push(testFilter);
      args.push("--", "--nocapture");
      args.push(...extra);
      return { cmd: "cargo", args };
    }

    case "make": {
      return { cmd: "make", args: ["test", ...extra] };
    }

    default:
      return { cmd: "python", args: ["-m", "pytest", "-v", "--tb=short"] };
  }
}

// ──────────────────────────────────────────────
// 出力パーサ
// ──────────────────────────────────────────────

function parseOutput(framework: string, output: string): Partial<TestResult> {
  switch (framework) {
    case "pytest":
      return parsePytest(output);
    case "unittest":
      return parseUnittest(output);
    case "jest":
    case "vitest":
      return parseJest(output);
    case "bun":
      return parseBun(output);
    case "go":
      return parseGo(output);
    case "cargo":
      return parseCargo(output);
    default:
      return parseGeneric(output);
  }
}

/** pytest: `5 passed, 2 failed, 1 error in 3.14s` */
function parsePytest(output: string): Partial<TestResult> {
  const result: Partial<TestResult> = {
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    failedTests: [],
    duration: 0,
  };

  // Summary line: "5 passed, 2 failed, 1 error in 3.14s"
  const summaryRe =
    /(\d+)\s+passed|(\d+)\s+failed|(\d+)\s+error(?:s)?|(\d+)\s+skipped/gi;
  let m: RegExpExecArray | null;
  while ((m = summaryRe.exec(output)) !== null) {
    if (m[1]) result.passed = parseInt(m[1], 10);
    if (m[2]) result.failed = parseInt(m[2], 10);
    if (m[3]) result.errors = parseInt(m[3], 10);
    if (m[4]) result.skipped = parseInt(m[4], 10);
  }

  // Duration: "in 3.14s"
  const durMatch = output.match(/in\s+([\d.]+)s/);
  if (durMatch) result.duration = parseFloat(durMatch[1]);

  // Failed test names: "FAILED tests/foo.py::test_bar"
  const failRe = /^FAILED\s+(.+?)(?:\s+-\s+.*)?$/gm;
  while ((m = failRe.exec(output)) !== null) {
    result.failedTests!.push(m[1].trim());
  }

  // Error test names: "ERROR tests/foo.py::test_bar"
  const errRe = /^ERROR\s+(.+?)(?:\s+-\s+.*)?$/gm;
  while ((m = errRe.exec(output)) !== null) {
    result.failedTests!.push(m[1].trim());
  }

  result.total =
    (result.passed ?? 0) +
    (result.failed ?? 0) +
    (result.errors ?? 0) +
    (result.skipped ?? 0);

  return result;
}

/** unittest: `Ran 10 tests in 0.123s` + `FAILED (failures=2, errors=1)` */
function parseUnittest(output: string): Partial<TestResult> {
  const result: Partial<TestResult> = {
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    failedTests: [],
    duration: 0,
  };

  const ranMatch = output.match(/Ran\s+(\d+)\s+tests?\s+in\s+([\d.]+)s/);
  if (ranMatch) {
    result.total = parseInt(ranMatch[1], 10);
    result.duration = parseFloat(ranMatch[2]);
  }

  const failedMatch = output.match(/failures=(\d+)/);
  if (failedMatch) result.failed = parseInt(failedMatch[1], 10);

  const errMatch = output.match(/errors=(\d+)/);
  if (errMatch) result.errors = parseInt(errMatch[1], 10);

  const skippedMatch = output.match(/skipped=(\d+)/);
  if (skippedMatch) result.skipped = parseInt(skippedMatch[1], 10);

  result.passed =
    (result.total ?? 0) -
    (result.failed ?? 0) -
    (result.errors ?? 0) -
    (result.skipped ?? 0);

  // FAIL: test_xxx (module.TestClass)
  const failRe = /^FAIL:\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = failRe.exec(output)) !== null) {
    result.failedTests!.push(m[1].trim());
  }
  const errRe2 = /^ERROR:\s+(.+)$/gm;
  while ((m = errRe2.exec(output)) !== null) {
    result.failedTests!.push(m[1].trim());
  }

  return result;
}

/** jest / vitest: "Tests: 3 failed, 10 passed, 13 total" */
function parseJest(output: string): Partial<TestResult> {
  const result: Partial<TestResult> = {
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    failedTests: [],
    duration: 0,
  };

  const passedM = output.match(/(\d+)\s+passed/);
  const failedM = output.match(/(\d+)\s+failed/);
  const skippedM = output.match(/(\d+)\s+skipped/);
  const totalM = output.match(/(\d+)\s+total/);

  if (passedM) result.passed = parseInt(passedM[1], 10);
  if (failedM) result.failed = parseInt(failedM[1], 10);
  if (skippedM) result.skipped = parseInt(skippedM[1], 10);
  if (totalM) {
    result.total = parseInt(totalM[1], 10);
  } else {
    result.total =
      (result.passed ?? 0) + (result.failed ?? 0) + (result.skipped ?? 0);
  }

  // Duration: "Time: 1.234 s"
  const durM = output.match(/Time:\s+([\d.]+)\s*s/);
  if (durM) result.duration = parseFloat(durM[1]);

  // Failed test: "● TestSuite > test name"
  const failRe = /^\s+●\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = failRe.exec(output)) !== null) {
    result.failedTests!.push(m[1].trim());
  }

  return result;
}

/** bun test: "✓ 10 tests | ✗ 2 failed" */
function parseBun(output: string): Partial<TestResult> {
  const result: Partial<TestResult> = {
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    failedTests: [],
    duration: 0,
  };

  // "X pass" / "X fail"
  const passM = output.match(/(\d+)\s+pass/i);
  const failM = output.match(/(\d+)\s+fail/i);
  const skipM = output.match(/(\d+)\s+skip/i);

  if (passM) result.passed = parseInt(passM[1], 10);
  if (failM) result.failed = parseInt(failM[1], 10);
  if (skipM) result.skipped = parseInt(skipM[1], 10);
  result.total =
    (result.passed ?? 0) + (result.failed ?? 0) + (result.skipped ?? 0);

  // Duration: "(Xms)"
  const durM = output.match(/\((\d+(?:\.\d+)?)\s*ms\)/);
  if (durM) result.duration = parseFloat(durM[1]) / 1000;

  // Failed test lines: "✗ test name"
  const failRe = /^.*✗\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = failRe.exec(output)) !== null) {
    result.failedTests!.push(m[1].trim());
  }

  return result;
}

/** go test: "--- FAIL: TestFoo (0.00s)" */
function parseGo(output: string): Partial<TestResult> {
  const result: Partial<TestResult> = {
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    failedTests: [],
    duration: 0,
  };

  const passLines = (output.match(/^--- PASS:/gm) ?? []).length;
  const failLines = (output.match(/^--- FAIL:/gm) ?? []).length;
  const skipLines = (output.match(/^--- SKIP:/gm) ?? []).length;

  result.passed = passLines;
  result.failed = failLines;
  result.skipped = skipLines;
  result.total = passLines + failLines + skipLines;

  // Duration: "ok pkg 0.123s"
  const durM = output.match(/^ok\s+\S+\s+([\d.]+)s/m);
  if (durM) result.duration = parseFloat(durM[1]);

  // Failed test names
  const failRe = /^--- FAIL:\s+(\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = failRe.exec(output)) !== null) {
    result.failedTests!.push(m[1]);
  }

  return result;
}

/** cargo test */
function parseCargo(output: string): Partial<TestResult> {
  const result: Partial<TestResult> = {
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    failedTests: [],
    duration: 0,
  };

  // "test result: ok. 5 passed; 2 failed; 0 ignored; 0 measured"
  const summaryM = output.match(
    /test result:\s+\w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored/,
  );
  if (summaryM) {
    result.passed = parseInt(summaryM[1], 10);
    result.failed = parseInt(summaryM[2], 10);
    result.skipped = parseInt(summaryM[3], 10);
    result.total = result.passed + result.failed + result.skipped;
  }

  // Failed test names: "test foo::bar ... FAILED"
  const failRe = /^test\s+(\S+)\s+\.\.\.\s+FAILED$/gm;
  let m: RegExpExecArray | null;
  while ((m = failRe.exec(output)) !== null) {
    result.failedTests!.push(m[1]);
  }

  return result;
}

/** 汎用: 数値を拾える範囲でパース */
function parseGeneric(output: string): Partial<TestResult> {
  const passM = output.match(/(\d+)\s+(?:pass(?:ed)?|ok)/i);
  const failM = output.match(/(\d+)\s+fail(?:ed)?/i);
  return {
    passed: passM ? parseInt(passM[1], 10) : 0,
    failed: failM ? parseInt(failM[1], 10) : 0,
    errors: 0,
    skipped: 0,
    failedTests: [],
    duration: 0,
    total: 0,
  };
}

// ──────────────────────────────────────────────
// コマンド実行（stdout + stderr を結合）
// ──────────────────────────────────────────────

function runTestCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<{ output: string; exitCode: number; durationMs: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    let output = "";

    const mergedEnv = {
      ...process.env,
      ...(env ?? {}),
    };

    const proc = spawn(cmd, args, {
      cwd,
      shell: false,
      env: mergedEnv,
      timeout: timeoutMs,
    });

    proc.stdout?.on("data", (d: Buffer) => {
      output += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      output += d.toString();
    });

    proc.on("close", (code) => {
      resolve({
        output,
        exitCode: code ?? 1,
        durationMs: Date.now() - start,
      });
    });

    proc.on("error", (err) => {
      output += `\nProcess error: ${err.message}`;
      resolve({
        output,
        exitCode: 1,
        durationMs: Date.now() - start,
      });
    });
  });
}

// ──────────────────────────────────────────────
// ToolResult フォーマッタ
// ──────────────────────────────────────────────

function formatResult(r: TestResult): string {
  const lines: string[] = [
    `Framework: ${r.framework}`,
    `Result: ${r.failed + r.errors === 0 ? "PASS" : "FAIL"}`,
    `Total: ${r.total}  Passed: ${r.passed}  Failed: ${r.failed}  Errors: ${r.errors}  Skipped: ${r.skipped}`,
    `Duration: ${r.duration.toFixed(2)}s`,
  ];

  if (r.failedTests.length > 0) {
    lines.push("");
    lines.push("Failed tests:");
    for (const t of r.failedTests) {
      lines.push(`  - ${t}`);
    }
  }

  lines.push("");
  lines.push("--- Output ---");
  // 出力が長い場合は末尾 200 行に切り詰め
  const outputLines = r.rawOutput.split("\n");
  const truncated =
    outputLines.length > 200
      ? [
          `[... ${outputLines.length - 200} lines truncated ...]`,
          ...outputLines.slice(-200),
        ]
      : outputLines;
  lines.push(truncated.join("\n"));

  return lines.join("\n");
}

// ──────────────────────────────────────────────
// TestRunnerTool
// ──────────────────────────────────────────────

/**
 * run_tests — テスト実行ツール
 *
 * フレームワークを自動検出し、テストを実行して構造化結果を返す。
 * SWE-bench ワークフローの「パッチ検証」フェーズで使用する。
 */
export class TestRunnerTool extends BaseTool {
  name = "run_tests";
  description =
    "Run tests and return structured results (pass/fail counts, failed test names). " +
    "Auto-detects pytest, unittest, jest, vitest, bun, go test, and cargo test. " +
    "Use after applying patches to verify correctness.";
  riskLevel: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM";

  parameters = {
    type: "object" as const,
    properties: {
      cwd: {
        type: "string",
        description:
          "Working directory where tests are run (default: current directory)",
      },
      framework: {
        type: "string",
        enum: [
          "auto",
          "pytest",
          "unittest",
          "jest",
          "vitest",
          "bun",
          "go",
          "cargo",
          "make",
        ],
        description:
          'Test framework to use. "auto" detects automatically (default: "auto")',
      },
      test_file: {
        type: "string",
        description:
          "Run only a specific test file (e.g. tests/test_foo.py, src/foo.test.ts)",
      },
      test_filter: {
        type: "string",
        description:
          "Filter tests by name/pattern (e.g. -k expression for pytest, --test-name-pattern for bun)",
      },
      timeout: {
        type: "number",
        description:
          "Timeout in seconds (default: 120, max: 600). Increase for large test suites.",
      },
      extra_args: {
        type: "array",
        items: { type: "string" },
        description: "Additional arguments to pass directly to the test runner",
      },
      env: {
        type: "object",
        description:
          "Additional environment variables (e.g. {PYTHONPATH: 'src'})",
        additionalProperties: { type: "string" },
      },
    },
    required: [] as string[],
  };

  async execute(params: unknown): Promise<ToolResult> {
    try {
      const {
        cwd: cwdRaw,
        framework: frameworkParam = "auto",
        test_file,
        test_filter,
        timeout = 120,
        extra_args,
        env,
      } = (params || {}) as {
        cwd?: string;
        framework?: string;
        test_file?: string;
        test_filter?: string;
        timeout?: number;
        extra_args?: string[];
        env?: Record<string, string>;
      };

      // ── 入力検証 ───────────────────────────────────────
      const cwd = resolve(cwdRaw ?? process.cwd());

      if (!existsSync(cwd)) {
        return {
          success: false,
          output: "",
          error: `Working directory does not exist: ${cwd}`,
        };
      }

      const timeoutMs = Math.max(1, Math.min(timeout, 600)) * 1000;

      // test_file のパスインジェクション対策
      if (test_file) {
        if (test_file.includes("\0") || test_file.includes("`")) {
          return {
            success: false,
            output: "",
            error: `Invalid test_file path: "${test_file}"`,
          };
        }
      }

      // test_filter のインジェクション対策
      if (test_filter) {
        if (test_filter.includes("\0") || test_filter.includes("`")) {
          return {
            success: false,
            output: "",
            error: `Invalid test_filter: "${test_filter}"`,
          };
        }
      }

      // env のキー/値検証
      if (env) {
        for (const [k, v] of Object.entries(env)) {
          if (!/^[A-Z_][A-Z0-9_]*$/i.test(k)) {
            return {
              success: false,
              output: "",
              error: `Invalid environment variable name: "${k}"`,
            };
          }
          if (typeof v !== "string") {
            return {
              success: false,
              output: "",
              error: `Environment variable value must be a string: ${k}`,
            };
          }
        }
      }

      // ── フレームワーク決定 ─────────────────────────────
      const framework: TestFramework =
        frameworkParam === "auto"
          ? await detectFramework(cwd)
          : (frameworkParam as TestFramework);

      // ── コマンドビルド ────────────────────────────────
      const { cmd, args } = buildCommand(
        framework,
        test_file,
        test_filter,
        extra_args,
      );

      // ── 実行 ──────────────────────────────────────────
      const { output: rawOutput, durationMs } = await runTestCommand(
        cmd,
        args,
        cwd,
        timeoutMs,
        env,
      );

      // ── パース ────────────────────────────────────────
      const parsed = parseOutput(framework, rawOutput);

      const testResult: TestResult = {
        framework,
        total: parsed.total ?? 0,
        passed: parsed.passed ?? 0,
        failed: parsed.failed ?? 0,
        errors: parsed.errors ?? 0,
        skipped: parsed.skipped ?? 0,
        failedTests: parsed.failedTests ?? [],
        duration:
          parsed.duration && parsed.duration > 0
            ? parsed.duration
            : durationMs / 1000,
        rawOutput,
      };

      // ── 出力 ──────────────────────────────────────────
      const success = testResult.failed === 0 && testResult.errors === 0;

      return {
        success,
        output: formatResult(testResult),
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
