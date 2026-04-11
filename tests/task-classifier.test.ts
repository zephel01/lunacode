import { describe, test, expect } from "bun:test";
import { TaskClassifier } from "../src/agents/TaskClassifier.js";

describe("TaskClassifier", () => {
  const classifier = new TaskClassifier();

  describe("Simple queries", () => {
    test("should classify Japanese file list request as simple", () => {
      const result = classifier.classify("ファイルの一覧を見せて");
      expect(result.complexity).toBe("simple");
      expect(result.suggestedModel).toBe("light");
      expect(result.reason).toBeTruthy();
    });

    test("should classify English how-to question as simple", () => {
      const result = classifier.classify("what is this function?");
      expect(result.complexity).toBe("simple");
      expect(result.suggestedModel).toBe("light");
    });

    test("should classify help request as simple", () => {
      const result = classifier.classify("help");
      expect(result.complexity).toBe("simple");
      expect(result.suggestedModel).toBe("light");
    });

    test("should classify list command as simple", () => {
      const result = classifier.classify("list all files");
      expect(result.complexity).toBe("simple");
      expect(result.suggestedModel).toBe("light");
    });

    test("should classify description request as simple", () => {
      const result = classifier.classify("describe this code");
      expect(result.complexity).toBe("simple");
      expect(result.suggestedModel).toBe("light");
    });
  });

  describe("Complex queries", () => {
    test("should classify Japanese refactoring task as complex", () => {
      const result = classifier.classify(
        "このプロジェクト全体をリファクタリングして、パフォーマンスを最適化してください",
      );
      expect(result.complexity).toBe("complex");
      expect(result.suggestedModel).toBe("heavy");
    });

    test("should classify English refactoring task as complex", () => {
      const result = classifier.classify("refactor this codebase to improve maintainability and optimize performance");
      expect(result.complexity).toBe("complex");
      expect(result.suggestedModel).toBe("heavy");
    });

    test("should classify security vulnerability task as complex", () => {
      const result = classifier.classify(
        "セキュリティの脆弱性をデバッグして修正して",
      );
      expect(result.complexity).toBe("complex");
      expect(result.suggestedModel).toBe("heavy");
      // Should have multiple indicators
      expect(result.reason.includes("complex indicator")).toBeTruthy();
    });

    test("should classify multi-part test and optimization task as complex", () => {
      const result = classifier.classify(
        "Write tests for all the modules and optimize performance",
      );
      expect(result.complexity).toBe("complex");
      expect(result.suggestedModel).toBe("heavy");
    });

    test("should classify design task as complex", () => {
      const result = classifier.classify(
        "design the architecture for a large-scale distributed system with multiple microservices and complex interactions"
      );
      expect(result.complexity).toBe("complex");
      expect(result.suggestedModel).toBe("heavy");
    });

    test("should classify migration task as complex", () => {
      const result = classifier.classify(
        "migrate the database to a new version and optimize performance with indexing strategies",
      );
      expect(result.complexity).toBe("complex");
      expect(result.suggestedModel).toBe("heavy");
    });
  });

  describe("Moderate queries", () => {
    test("should classify ambiguous short task as moderate", () => {
      const result = classifier.classify("create a new file");
      expect(result.complexity).toBe("moderate");
      expect(result.suggestedModel).toBe("heavy");
    });

    test("should classify medium-length neutral query as moderate", () => {
      const result = classifier.classify("please review this code and provide feedback");
      expect(result.complexity).toBe("moderate");
      expect(result.suggestedModel).toBe("heavy");
    });
  });

  describe("Input length scoring", () => {
    test("should increase complexity score for long input", () => {
      const shortInput = "test";
      const longInput =
        "test refactor " + "word ".repeat(60); // Create a long input (>300 chars) with complex indicator

      const shortResult = classifier.classify(shortInput);
      const longResult = classifier.classify(longInput);

      expect(longResult.complexity).not.toBe(shortResult.complexity);
    });

    test("should consider length between 150-300 chars as moderately complex", () => {
      const input =
        "I need to refactor the code base and make sure " +
        "all the modules are properly structured";
      const result = classifier.classify(input);
      expect(result.suggestedModel).toBe("heavy");
    });
  });

  describe("Iteration context scoring", () => {
    test("should increase complexity with high iteration count", () => {
      const input = "continue processing";
      const simpleContext = { iteration: 1, toolResultCount: 2 };
      const deepContext = { iteration: 5, toolResultCount: 10 };

      const simpleResult = classifier.classify(input, simpleContext);
      const deepResult = classifier.classify(input, deepContext);

      // Deep iteration should suggest heavy model
      expect(deepResult.suggestedModel).toBe("heavy");
    });
  });

  describe("Classification result structure", () => {
    test("should always return a valid ClassificationResult", () => {
      const result = classifier.classify("any input");

      expect(result).toHaveProperty("complexity");
      expect(result).toHaveProperty("reason");
      expect(result).toHaveProperty("suggestedModel");

      expect(["simple", "moderate", "complex"]).toContain(
        result.complexity,
      );
      expect(["light", "heavy"]).toContain(result.suggestedModel);
      expect(typeof result.reason).toBe("string");
    });

    test("should provide meaningful reason string", () => {
      const complexResult = classifier.classify(
        "refactor this code and write tests",
      );
      expect(complexResult.reason.length).toBeGreaterThan(0);

      const simpleResult = classifier.classify("what is this?");
      expect(simpleResult.reason.length).toBeGreaterThan(0);
    });
  });

  describe("Edge cases", () => {
    test("should handle empty string", () => {
      const result = classifier.classify("");
      expect(result.complexity).toBeDefined();
      expect(result.suggestedModel).toBeDefined();
    });

    test("should handle special characters", () => {
      const result = classifier.classify("!@#$%^&*()");
      expect(result.complexity).toBeDefined();
      expect(result.suggestedModel).toBeDefined();
    });

    test("should be case insensitive", () => {
      const lowerResult = classifier.classify("refactor this code");
      const upperResult = classifier.classify("REFACTOR THIS CODE");
      expect(lowerResult.complexity).toBe(upperResult.complexity);
    });
  });
});
