import * as fs from "fs/promises";
import * as path from "path";
import {
  SkillManifest,
  LoadedSkill,
  SkillMatch,
  Tool,
} from "../types/index.js";

/**
 * スキルの検出・ロード・検索を担当するクラス
 *
 * スキルは以下の構造を持つディレクトリ:
 *   .kairos/skills/<skill-name>/
 *     ├── skill.json    # マニフェスト（名前、説明、トリガーワード）
 *     ├── SKILL.md      # LLM に注入する指示書
 *     └── tools.ts      # 追加ツール定義（オプション）
 */
export class SkillLoader {
  private skillsDir: string;
  private skills: Map<string, LoadedSkill> = new Map();
  private loaded: boolean = false;

  constructor(basePath: string) {
    this.skillsDir = path.join(basePath, "skills");
  }

  /**
   * スキルディレクトリを走査し、全スキルをロード
   */
  async loadAll(): Promise<void> {
    this.skills.clear();

    try {
      await fs.access(this.skillsDir);
    } catch {
      // skills ディレクトリが存在しない場合は作成
      await fs.mkdir(this.skillsDir, { recursive: true });
      console.log(`📁 Created skills directory: ${this.skillsDir}`);
      this.loaded = true;
      return;
    }

    const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(this.skillsDir, entry.name);
      try {
        const skill = await this.loadSkill(skillDir);
        if (skill) {
          this.skills.set(skill.manifest.name, skill);
        }
      } catch (e) {
        console.warn(
          `⚠️ Failed to load skill "${entry.name}": ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    this.loaded = true;

    if (this.skills.size > 0) {
      console.log(
        `✅ Loaded ${this.skills.size} skill(s): ${[...this.skills.keys()].join(", ")}`,
      );
    }
  }

  /**
   * 個別のスキルディレクトリをロード
   */
  private async loadSkill(skillDir: string): Promise<LoadedSkill | null> {
    // skill.json を読み込み
    const manifestPath = path.join(skillDir, "skill.json");
    let manifest: SkillManifest;
    try {
      const raw = await fs.readFile(manifestPath, "utf-8");
      manifest = JSON.parse(raw) as SkillManifest;
    } catch {
      // skill.json がなければ SKILL.md のみで簡易ロード
      const skillMdPath = path.join(skillDir, "SKILL.md");
      try {
        await fs.access(skillMdPath);
      } catch {
        return null; // SKILL.md も skill.json もなければスキップ
      }

      const dirName = path.basename(skillDir);
      manifest = {
        name: dirName,
        version: "0.1.0",
        description: `Skill: ${dirName}`,
        triggers: [dirName],
      };
    }

    // SKILL.md を読み込み
    const skillMdPath = path.join(skillDir, "SKILL.md");
    let skillMdContent = "";
    try {
      skillMdContent = await fs.readFile(skillMdPath, "utf-8");
    } catch {
      console.warn(`⚠️ SKILL.md not found for "${manifest.name}"`);
      return null;
    }

    // 追加ツール（将来拡張用、現在は空）
    const tools: Tool[] = [];

    return {
      manifest,
      skillMdContent,
      dirPath: skillDir,
      tools,
      isEnabled: true,
    };
  }

  /**
   * ユーザー入力に関連するスキルを検索
   * トリガーワードによるマッチング
   */
  findRelevantSkills(userInput: string): SkillMatch[] {
    if (!this.loaded) return [];

    const input = userInput.toLowerCase();
    const matches: SkillMatch[] = [];

    for (const skill of this.skills.values()) {
      if (!skill.isEnabled) continue;

      const matchedTriggers: string[] = [];
      for (const trigger of skill.manifest.triggers) {
        if (input.includes(trigger.toLowerCase())) {
          matchedTriggers.push(trigger);
        }
      }

      if (matchedTriggers.length > 0) {
        // 関連度: マッチしたトリガー数 / 全トリガー数
        const relevance =
          matchedTriggers.length / skill.manifest.triggers.length;
        matches.push({ skill, matchedTriggers, relevance });
      }
    }

    // 関連度順にソート
    matches.sort((a, b) => b.relevance - a.relevance);
    return matches;
  }

  /**
   * 名前でスキルを取得
   */
  getSkill(name: string): LoadedSkill | undefined {
    return this.skills.get(name);
  }

  /**
   * 全スキル一覧を取得
   */
  getAllSkills(): LoadedSkill[] {
    return [...this.skills.values()];
  }

  /**
   * スキル数を取得
   */
  getSkillCount(): number {
    return this.skills.size;
  }

  /**
   * スキルの有効/無効を切り替え
   */
  setEnabled(name: string, enabled: boolean): boolean {
    const skill = this.skills.get(name);
    if (!skill) return false;
    skill.isEnabled = enabled;
    return true;
  }

  /**
   * スキルの SKILL.md 内容をシステムプロンプト用に整形
   */
  formatSkillForPrompt(skill: LoadedSkill): string {
    return `\n\n--- Skill: ${skill.manifest.name} ---\n${skill.skillMdContent}\n--- End Skill ---\n`;
  }

  /**
   * 複数スキルをシステムプロンプト用にまとめて整形
   */
  formatSkillsForPrompt(skills: LoadedSkill[]): string {
    if (skills.length === 0) return "";

    const header = `\n\n[Active Skills]\nThe following skills provide specialized instructions for this task:\n`;
    const body = skills.map((s) => this.formatSkillForPrompt(s)).join("");
    return header + body;
  }

  /**
   * スキルの一覧を表示用にフォーマット
   */
  formatSkillList(): string {
    if (this.skills.size === 0) {
      return "No skills installed. Create a skill in .kairos/skills/<name>/ with a SKILL.md file.";
    }

    const lines: string[] = [];
    for (const skill of this.skills.values()) {
      const status = skill.isEnabled ? "✅" : "⏸️";
      const triggers = skill.manifest.triggers.join(", ");
      lines.push(
        `${status} ${skill.manifest.name} (v${skill.manifest.version}) — ${skill.manifest.description}`,
      );
      lines.push(`   Triggers: ${triggers}`);
    }
    return lines.join("\n");
  }

  /**
   * 新しいスキルのテンプレートを作成
   */
  async createSkillTemplate(
    name: string,
    description: string,
  ): Promise<string> {
    const skillDir = path.join(this.skillsDir, name);
    await fs.mkdir(skillDir, { recursive: true });

    // skill.json
    const manifest: SkillManifest = {
      name,
      version: "0.1.0",
      description,
      triggers: [name],
      category: "custom",
    };
    await fs.writeFile(
      path.join(skillDir, "skill.json"),
      JSON.stringify(manifest, null, 2),
    );

    // SKILL.md テンプレート
    const skillMd = `# ${name}

## 概要
${description}

## 指示
このスキルがアクティブな場合、以下の手順に従ってください:

1. （ここにスキル固有の指示を記述）
2. （ツールの使い方や出力形式の指定など）

## 制約
- （スキル使用時の注意点や制約を記述）
`;
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMd);

    // リロード
    await this.loadAll();

    return skillDir;
  }
}
