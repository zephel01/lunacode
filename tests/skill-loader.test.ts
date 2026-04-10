import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SkillLoader } from "../src/skills/SkillLoader.js";
import * as fs from "fs/promises";
import * as path from "path";

const TEST_DIR = "/tmp/lunacode-skill-test";
const SKILLS_DIR = path.join(TEST_DIR, "skills");

beforeAll(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("SkillLoader 基本機能", () => {
  test("skills ディレクトリがない場合は自動作成", async () => {
    const loader = new SkillLoader(TEST_DIR);
    await loader.loadAll();
    expect(loader.getSkillCount()).toBe(0);

    // ディレクトリが作成されたか確認
    const stat = await fs.stat(SKILLS_DIR);
    expect(stat.isDirectory()).toBe(true);
  });

  test("空の skills ディレクトリではスキル数0", async () => {
    const loader = new SkillLoader(TEST_DIR);
    await loader.loadAll();
    expect(loader.getSkillCount()).toBe(0);
    expect(loader.getAllSkills()).toHaveLength(0);
  });
});

describe("SkillLoader スキルの読み込み", () => {
  beforeAll(async () => {
    // テスト用スキルを作成
    const skillDir = path.join(SKILLS_DIR, "test-skill");
    await fs.mkdir(skillDir, { recursive: true });

    await fs.writeFile(
      path.join(skillDir, "skill.json"),
      JSON.stringify({
        name: "test-skill",
        version: "1.0.0",
        description: "テスト用スキル",
        triggers: ["test", "テスト", "testing"],
        category: "custom",
      }),
    );

    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "# Test Skill\n\nこれはテスト用スキルです。\n\n## 指示\nテストを実行してください。",
    );

    // SKILL.md のみのスキル（skill.json なし）
    const minimalDir = path.join(SKILLS_DIR, "minimal-skill");
    await fs.mkdir(minimalDir, { recursive: true });
    await fs.writeFile(
      path.join(minimalDir, "SKILL.md"),
      "# Minimal Skill\n\n最小構成のスキル。",
    );
  });

  test("skill.json + SKILL.md のスキルをロードできる", async () => {
    const loader = new SkillLoader(TEST_DIR);
    await loader.loadAll();

    const skill = loader.getSkill("test-skill");
    expect(skill).toBeDefined();
    expect(skill!.manifest.name).toBe("test-skill");
    expect(skill!.manifest.version).toBe("1.0.0");
    expect(skill!.manifest.triggers).toContain("test");
    expect(skill!.skillMdContent).toContain("テスト用スキル");
    expect(skill!.isEnabled).toBe(true);
  });

  test("SKILL.md のみのスキルもロードできる（自動マニフェスト生成）", async () => {
    const loader = new SkillLoader(TEST_DIR);
    await loader.loadAll();

    const skill = loader.getSkill("minimal-skill");
    expect(skill).toBeDefined();
    expect(skill!.manifest.name).toBe("minimal-skill");
    expect(skill!.manifest.version).toBe("0.1.0");
    expect(skill!.skillMdContent).toContain("最小構成");
  });

  test("全スキルを一覧取得できる", async () => {
    const loader = new SkillLoader(TEST_DIR);
    await loader.loadAll();

    const allSkills = loader.getAllSkills();
    expect(allSkills.length).toBeGreaterThanOrEqual(2);
  });
});

describe("SkillLoader スキル検索", () => {
  test("トリガーワードでスキルを検索できる", async () => {
    const loader = new SkillLoader(TEST_DIR);
    await loader.loadAll();

    const matches = loader.findRelevantSkills("テストを実行したい");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].skill.manifest.name).toBe("test-skill");
    expect(matches[0].matchedTriggers).toContain("テスト");
  });

  test("英語のトリガーワードでも検索できる", async () => {
    const loader = new SkillLoader(TEST_DIR);
    await loader.loadAll();

    const matches = loader.findRelevantSkills("run the test suite");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].matchedTriggers).toContain("test");
  });

  test("マッチしない入力では空配列を返す", async () => {
    const loader = new SkillLoader(TEST_DIR);
    await loader.loadAll();

    const matches = loader.findRelevantSkills("天気はどうですか");
    expect(matches).toHaveLength(0);
  });

  test("複数のトリガーがマッチすると関連度が高い", async () => {
    const loader = new SkillLoader(TEST_DIR);
    await loader.loadAll();

    const singleMatch = loader.findRelevantSkills("test");
    const multiMatch = loader.findRelevantSkills("test テスト");

    if (singleMatch.length > 0 && multiMatch.length > 0) {
      expect(multiMatch[0].relevance).toBeGreaterThanOrEqual(singleMatch[0].relevance);
    }
  });
});

describe("SkillLoader 有効/無効", () => {
  test("スキルを無効にできる", async () => {
    const loader = new SkillLoader(TEST_DIR);
    await loader.loadAll();

    expect(loader.setEnabled("test-skill", false)).toBe(true);

    const matches = loader.findRelevantSkills("テスト");
    const testMatch = matches.find((m) => m.skill.manifest.name === "test-skill");
    expect(testMatch).toBeUndefined(); // 無効なスキルは検索に出ない
  });

  test("スキルを再有効化できる", async () => {
    const loader = new SkillLoader(TEST_DIR);
    await loader.loadAll();
    loader.setEnabled("test-skill", false);
    loader.setEnabled("test-skill", true);

    const matches = loader.findRelevantSkills("テスト");
    expect(matches.length).toBeGreaterThan(0);
  });

  test("存在しないスキルの有効/無効は false を返す", async () => {
    const loader = new SkillLoader(TEST_DIR);
    await loader.loadAll();

    expect(loader.setEnabled("nonexistent", true)).toBe(false);
  });
});

describe("SkillLoader テンプレート作成", () => {
  test("スキルテンプレートを作成できる", async () => {
    const loader = new SkillLoader(TEST_DIR);
    await loader.loadAll();

    const skillDir = await loader.createSkillTemplate("my-new-skill", "テスト用新規スキル");

    // ファイルが作成されたか確認
    const manifest = JSON.parse(
      await fs.readFile(path.join(skillDir, "skill.json"), "utf-8"),
    );
    expect(manifest.name).toBe("my-new-skill");
    expect(manifest.description).toBe("テスト用新規スキル");

    const skillMd = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8");
    expect(skillMd).toContain("my-new-skill");

    // リロードされてスキルが追加されたか
    expect(loader.getSkill("my-new-skill")).toBeDefined();
  });
});

describe("SkillLoader プロンプト生成", () => {
  test("スキルをプロンプト用にフォーマットできる", async () => {
    const loader = new SkillLoader(TEST_DIR);
    await loader.loadAll();

    const skill = loader.getSkill("test-skill");
    expect(skill).toBeDefined();

    const formatted = loader.formatSkillForPrompt(skill!);
    expect(formatted).toContain("Skill: test-skill");
    expect(formatted).toContain("テスト用スキル");
  });

  test("複数スキルをまとめてフォーマットできる", async () => {
    const loader = new SkillLoader(TEST_DIR);
    await loader.loadAll();

    const skills = loader.getAllSkills().slice(0, 2);
    const formatted = loader.formatSkillsForPrompt(skills);
    expect(formatted).toContain("[Active Skills]");
  });

  test("空のスキルリストでは空文字を返す", async () => {
    const loader = new SkillLoader(TEST_DIR);
    await loader.loadAll();

    const formatted = loader.formatSkillsForPrompt([]);
    expect(formatted).toBe("");
  });

  test("スキル一覧をフォーマットできる", async () => {
    const loader = new SkillLoader(TEST_DIR);
    await loader.loadAll();

    const list = loader.formatSkillList();
    expect(list).toContain("test-skill");
  });
});
