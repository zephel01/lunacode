import { describe, it, expect, mock, beforeEach } from "bun:test";
import { SelfEvaluator } from "../src/agents/SelfEvaluator.js";
import type {
  SelfEvalConfig,
  EvalJudgment,
} from "../src/types/index.js";
import type { LLMProvider } from "../src/providers/LLMProvider.js";

// ── ヘルパー ──────────────────────────────────────────────────────────────────

function makeLLMProvider(responses: string[]): LLMProvider {
  let call = 0;
  return {
    chatCompletion: mock(async () => {
      const content = responses[call] ?? responses[responses.length - 1];
      call++;
      return {
        choices: [{ message: { role: "assistant", content } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      };
    }),
    getDefaultModel: () => "test-model",
    getType: () => "openai",
    supportsStreaming: () => false,
  } as unknown as LLMProvider;
}

function passJudgment(score = 8): string {
  return JSON.stringify({
    score,
    passed: true,
    issues: [],
    suggestion: "",
  } satisfies EvalJudgment);
}

function failJudgment(score = 4, issues = ["Missing error handling"]): string {
  return JSON.stringify({
    score,
    passed: false,
    issues,
    suggestion: "Add try/catch around async calls",
  } satisfies EvalJudgment);
}

const DEFAULT_CONFIG: SelfEvalConfig = {
  enabled: true,
  scoreThreshold: 7,
  maxRounds: 2,
  minResponseLength: 10,
};

// ── テスト ────────────────────────────────────────────────────────────────────

describe("SelfEvaluator", () => {
  describe("constructor / fromConfig", () => {
    it("fromConfig でインスタンスが生成される", () => {
      const evaluator = SelfEvaluator.fromConfig(
        makeLLMProvider([passJudgment()]),
        DEFAULT_CONFIG,
      );
      expect(evaluator).toBeInstanceOf(SelfEvaluator);
    });

    it("デフォルト設定で生成できる（オプションなし）", () => {
      const evaluator = new SelfEvaluator(makeLLMProvider([passJudgment()]));
      expect(evaluator).toBeInstanceOf(SelfEvaluator);
    });
  });

  describe("evaluate() — スキップケース", () => {
    it("応答が minResponseLength 未満ならスキップする", async () => {
      const evaluator = SelfEvaluator.fromConfig(
        makeLLMProvider([passJudgment()]),
        { ...DEFAULT_CONFIG, minResponseLength: 100 },
      );
      const result = await evaluator.evaluate({
        task: "test",
        response: "short",
        messages: [],
      });
      expect(result.skipped).toBe(true);
      expect(result.rounds).toBe(0);
      expect(result.finalResponse).toBe("short");
    });

    it("isSubAgent=true かつ evaluateSubAgents=false ならスキップ", async () => {
      const evaluator = SelfEvaluator.fromConfig(
        makeLLMProvider([passJudgment()]),
        { ...DEFAULT_CONFIG, evaluateSubAgents: false },
      );
      const result = await evaluator.evaluate(
        { task: "test", response: "long enough response", messages: [] },
        true,
      );
      expect(result.skipped).toBe(true);
    });

    it("evaluateSubAgents=true ならサブエージェントでも評価する", async () => {
      const evaluator = SelfEvaluator.fromConfig(
        makeLLMProvider([passJudgment(9)]),
        { ...DEFAULT_CONFIG, evaluateSubAgents: true },
      );
      const result = await evaluator.evaluate(
        { task: "test", response: "long enough response text", messages: [] },
        true,
      );
      expect(result.skipped).toBe(false);
      expect(result.finalScore).toBe(9);
    });
  });

  describe("evaluate() — 合格ケース", () => {
    it("初回で合格したら修正ラウンドゼロで返す", async () => {
      const evaluator = SelfEvaluator.fromConfig(
        makeLLMProvider([passJudgment(9)]),
        DEFAULT_CONFIG,
      );
      const result = await evaluator.evaluate({
        task: "Write a function",
        response: "Here is the implementation...",
        messages: [],
      });
      expect(result.skipped).toBe(false);
      expect(result.rounds).toBe(0);
      expect(result.finalScore).toBe(9);
      expect(result.corrections).toHaveLength(0);
    });
  });

  describe("evaluate() — 修正ループ", () => {
    it("1回失敗→2回目合格で rounds=1 になる", async () => {
      // 1回目: 評価 fail → 2回目: 修正応答 → 3回目: 評価 pass
      const evaluator = SelfEvaluator.fromConfig(
        makeLLMProvider([
          failJudgment(4),       // 1回目の評価: fail
          "Corrected response",  // 修正応答
          passJudgment(8),       // 2回目の評価: pass
        ]),
        { ...DEFAULT_CONFIG, maxRounds: 2 },
      );
      const result = await evaluator.evaluate({
        task: "Write a function",
        response: "Incomplete implementation",
        messages: [],
      });
      expect(result.rounds).toBe(1);
      expect(result.initialScore).toBe(4);
      expect(result.finalScore).toBe(8);
      expect(result.corrections).toHaveLength(1);
      expect(result.finalResponse).toBe("Corrected response");
    });

    it("maxRounds まで失敗し続けても無限ループしない", async () => {
      // maxRounds=2 の場合: 評価fail→修正→評価fail→修正→最終評価
      const evaluator = SelfEvaluator.fromConfig(
        makeLLMProvider([
          failJudgment(3),       // 1回目評価: fail
          "Correction 1",        // 1回目修正
          failJudgment(4),       // 2回目評価: fail
          "Correction 2",        // 2回目修正
          passJudgment(5),       // 最終評価
        ]),
        { ...DEFAULT_CONFIG, maxRounds: 2 },
      );
      const result = await evaluator.evaluate({
        task: "Write a function",
        response: "Bad implementation",
        messages: [],
      });
      expect(result.rounds).toBe(2);
      expect(result.corrections).toHaveLength(2);
      expect(result.finalResponse).toBe("Correction 2");
    });

    it("修正後の応答が finalResponse に反映される", async () => {
      const evaluator = SelfEvaluator.fromConfig(
        makeLLMProvider([
          failJudgment(5),
          "Improved implementation with error handling",
          passJudgment(8),
        ]),
        DEFAULT_CONFIG,
      );
      const result = await evaluator.evaluate({
        task: "test",
        response: "Original response",
        messages: [],
      });
      expect(result.finalResponse).toBe(
        "Improved implementation with error handling",
      );
    });
  });

  describe("evaluate() — JSON パースエラー耐性", () => {
    it("評価JSONが壊れていても合格扱いにしてクラッシュしない", async () => {
      const evaluator = SelfEvaluator.fromConfig(
        makeLLMProvider(["NOT VALID JSON {{{}"]),
        DEFAULT_CONFIG,
      );
      const result = await evaluator.evaluate({
        task: "test",
        response: "Some response longer than minimum",
        messages: [],
      });
      expect(result.skipped).toBe(false);
      expect(result.rounds).toBe(0); // パース失敗 → 合格扱い
    });

    it("```json フェンスで囲まれたJSONも正しくパースできる", async () => {
      const fenced = "```json\n" + passJudgment(9) + "\n```";
      const evaluator = SelfEvaluator.fromConfig(
        makeLLMProvider([fenced]),
        DEFAULT_CONFIG,
      );
      const result = await evaluator.evaluate({
        task: "test",
        response: "A valid and complete response here",
        messages: [],
      });
      expect(result.finalScore).toBe(9);
    });
  });

  describe("formatResult()", () => {
    it("スキップ時は skipped と表示", () => {
      const msg = SelfEvaluator.formatResult({
        enabled: true,
        skipped: true,
        initialScore: 0,
        finalScore: 0,
        rounds: 0,
        corrections: [],
        finalResponse: "",
      });
      expect(msg).toContain("skipped");
    });

    it("スコアが上がった場合は ↑ を表示", () => {
      const msg = SelfEvaluator.formatResult({
        enabled: true,
        skipped: false,
        initialScore: 4,
        finalScore: 8,
        rounds: 1,
        corrections: [],
        finalResponse: "improved",
      });
      expect(msg).toContain("↑4");
      expect(msg).toContain("4");
      expect(msg).toContain("8");
    });

    it("スコアが変わらない場合は → を表示", () => {
      const msg = SelfEvaluator.formatResult({
        enabled: true,
        skipped: false,
        initialScore: 8,
        finalScore: 8,
        rounds: 0,
        corrections: [],
        finalResponse: "",
      });
      expect(msg).toContain("→");
    });
  });

  describe("SelfEvalConfig 型検証", () => {
    it("全フィールドが省略可能", () => {
      const config: SelfEvalConfig = {};
      const evaluator = SelfEvaluator.fromConfig(
        makeLLMProvider([passJudgment()]),
        config,
      );
      expect(evaluator).toBeInstanceOf(SelfEvaluator);
    });

    it("scoreThreshold=10 なら常に修正ループが走る", async () => {
      // score=9 でも threshold=10 なら fail
      const evaluator = SelfEvaluator.fromConfig(
        makeLLMProvider([
          JSON.stringify({ score: 9, passed: false, issues: ["minor"], suggestion: "small fix" }),
          "Slightly improved",
          passJudgment(10),
        ]),
        { ...DEFAULT_CONFIG, scoreThreshold: 10, maxRounds: 1 },
      );
      const result = await evaluator.evaluate({
        task: "test",
        response: "Almost perfect response text",
        messages: [],
      });
      expect(result.rounds).toBe(1);
    });
  });
});
