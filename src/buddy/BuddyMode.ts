/**
 * ペットの種類
 */
export enum PetType {
  CAT = "cat",
  DOG = "dog",
  RABBIT = "rabbit",
  BIRD = "bird",
  FOX = "fox",
  OWL = "owl",
  PANDA = "panda",
  KOALA = "koala",
  SLOTH = "sloth",
  OTTER = "otter",
  PENGUIN = "penguin",
  DUCK = "duck",
  TURTLE = "turtle",
  HAMSTER = "hamster",
  FERRET = "ferret",
  CHINCHILLA = "chinchilla",
  HEDGEHOG = "hedgehog",
}

/**
 * ペットの感情
 */
export enum PetEmotion {
  HAPPY = "happy",
  SAD = "sad",
  EXCITED = "excited",
  SLEEPY = "sleepy",
  HUNGRY = "hungry",
  BORED = "bored",
  CURIOUS = "curious",
  AFFECTIONATE = "affectionate",
  PLAYFUL = "playful",
  CONTENT = "content",
}

/**
 * ペットの状態
 */
export interface PetState {
  name: string;
  type: PetType;
  emotion: PetEmotion;
  energy: number; // 0-100
  hunger: number; // 0-100
  happiness: number; // 0-100
  lastInteraction: number;
}

/**
 * ペットの反応
 */
export interface PetResponse {
  message: string;
  emotion: PetEmotion;
  action?: string;
}

/**
 * ペットの種類ごとの情報
 */
const PET_INFO: Record<string, { emoji: string; personality: string }> = {
  [PetType.CAT]: { emoji: "🐱", personality: "独立心が強く、好奇心旺盛" },
  [PetType.DOG]: { emoji: "🐶", personality: "忠実で遊び好き、活発" },
  [PetType.RABBIT]: { emoji: "🐰", personality: "おとなしく、繊細" },
  [PetType.BIRD]: { emoji: "🐦", personality: "元気で、歌うのが好き" },
  [PetType.FOX]: { emoji: "🦊", personality: "賢く、いたずら好き" },
  [PetType.OWL]: { emoji: "🦉", personality: "賢く、観察力が高い" },
  [PetType.PANDA]: { emoji: "🐼", personality: "穏やかで、のんびり" },
  [PetType.KOALA]: { emoji: "🐨", personality: "リラックスした性格" },
  [PetType.SLOTH]: { emoji: "🦥", personality: "ゆったりとした性格" },
  [PetType.OTTER]: { emoji: "🦦", personality: "遊び好き、好奇心旺盛" },
  [PetType.PENGUIN]: { emoji: "🐧", personality: "社交的、集団行動が好き" },
  [PetType.DUCK]: { emoji: "🦆", personality: "友好的、水面が好き" },
  [PetType.TURTLE]: { emoji: "🐢", personality: "慎重で、忍耐強い" },
  [PetType.HAMSTER]: { emoji: "🐹", personality: "活発で、回し車が好き" },
  [PetType.FERRET]: { emoji: "🦝", personality: "遊び好き、探検が好き" },
  [PetType.CHINCHILLA]: { emoji: "🐁", personality: "活発で、夜行性" },
  [PetType.HEDGEHOG]: { emoji: "🦔", personality: "控えめで、警戒心が強い" },
};

/**
 * 感情ごとの反応
 */
const EMOTION_RESPONSES: Record<string, string[]> = {
  happy: ["🎉 元気いっぱい！", "😊 とってもハッピー！", "✨ 楽しい！"],
  sad: ["😢 さみしいな...", "😔 ぽつん...", "😿 涙が止まらない..."],
  excited: ["🎊 わくわく！", "🤩 やったー！", "🎉 すごーい！"],
  sleepy: ["😴 ぐー...", "💤 ねむい...", "🌙 おやすみ..."],
  hungry: [
    "🍽️ おなかすいた...",
    "🍎 なにかおいしいものない？",
    "🥕 おなかぺこぺこ",
  ],
  bored: ["😐 つまんない...", "🥱 退屈...", "😑 何かしよう..."],
  curious: ["🤔 なになに？", "🧐 おもしろそう！", "👀 なんだろう？"],
  affectionate: ["😻 だーいすき！", "🥰 だいすきー！", "💕 すきすきー！"],
  playful: ["🎮 あそぼー！", "🎉 げーむ！", "🎊 たのしー！"],
  content: ["😌 しあわせ", "🥳 リラックス", "✨ ちょうどいいかんじ"],
};

/**
 * Buddyモード - AIペットシステム
 *
 * Phase 3.3: Buddyモード（オプション）
 * - ペットキャラクター実装
 * - 名前呼び出し対応
 * - 感情システム
 */
export class BuddyMode {
  private state: PetState;
  private interactionCount: number = 0;

  constructor(name: string, petType: PetType) {
    this.state = {
      name,
      type: petType,
      emotion: PetEmotion.CONTENT,
      energy: 80,
      hunger: 30,
      happiness: 80,
      lastInteraction: Date.now(),
    };
  }

  /**
   * ペットの名前で呼びかける
   */
  callByName(name: string): PetResponse {
    if (!this.isNameMatch(name)) {
      return {
        message: "🤔 だれかな？",
        emotion: PetEmotion.CURIOUS,
      };
    }

    // 感情を更新
    this.state.emotion = PetEmotion.HAPPY;
    this.state.hunger = Math.min(100, this.state.hunger + 5);
    this.state.energy = Math.max(0, this.state.energy - 5);
    this.state.lastInteraction = Date.now();
    this.interactionCount++;

    // ランダムな反応
    const responses = EMOTION_RESPONSES[this.state.emotion];
    const message = responses[Math.floor(Math.random() * responses.length)];

    return {
      message: `${this.getEmoji()} ${this.state.name}ちゃん！\n${message}`,
      emotion: this.state.emotion,
      action: this.getRandomAction(),
    };
  }

  /**
   * ペットに話しかける
   */
  talk(message: string): PetResponse {
    // 感情を更新
    this.updateEmotion(message);
    this.state.lastInteraction = Date.now();
    this.interactionCount++;

    const emotionResponses = EMOTION_RESPONSES[this.state.emotion];

    return {
      message: `${this.getEmoji()} ${emotionResponses[Math.floor(Math.random() * emotionResponses.length)]}`,
      emotion: this.state.emotion,
      action: this.getTalkingAction(message),
    };
  }

  /**
   * ペットを撫でる
   */
  pet(): PetResponse {
    // 感情を更新
    this.state.emotion = PetEmotion.AFFECTIONATE;
    this.state.happiness = Math.min(100, this.state.happiness + 10);
    this.state.lastInteraction = Date.now();
    this.interactionCount++;

    return {
      message: `${this.getEmoji()} ${this.state.name}ちゃん、撫でられた！\n😻 だーいすき！`,
      emotion: this.state.emotion,
      action: "撫でる動作",
    };
  }

  /**
   * ペットに餌をあげる
   */
  feed(): PetResponse {
    // 感情を更新
    this.state.emotion = PetEmotion.HAPPY;
    this.state.hunger = Math.max(0, this.state.hunger - 30);
    this.state.happiness = Math.min(100, this.state.happiness + 15);
    this.state.lastInteraction = Date.now();
    this.interactionCount++;

    return {
      message: `${this.getEmoji()} ${this.state.name}ちゃん、おいしい！\n🍽️ ごちそうさま！`,
      emotion: this.state.emotion,
      action: "餌を食べる",
    };
  }

  /**
   * ペットと遊ぶ
   */
  play(): PetResponse {
    // 感情を更新
    this.state.emotion = PetEmotion.PLAYFUL;
    this.state.energy = Math.max(0, this.state.energy - 20);
    this.state.hunger = Math.min(100, this.state.hunger + 10);
    this.state.happiness = Math.min(100, this.state.happiness + 15);
    this.state.lastInteraction = Date.now();
    this.interactionCount++;

    return {
      message: `${this.getEmoji()} ${this.state.name}ちゃん、たのしい！\n🎮 あそぼー！`,
      emotion: this.state.emotion,
      action: "遊ぶ動作",
    };
  }

  /**
   * ペットを休ませる
   */
  sleep(): PetResponse {
    // 感情を更新
    this.state.emotion = PetEmotion.SLEEPY;
    this.state.energy = Math.min(100, this.state.energy + 30);
    this.state.lastInteraction = Date.now();

    return {
      message: `${this.getEmoji()} ${this.state.name}ちゃん、おやすみ...\n💤 ぐー...`,
      emotion: this.state.emotion,
      action: "寝る動作",
    };
  }

  /**
   * ペットの状態を更新
   */
  updateState(): void {
    // エネルギーの減少
    this.state.energy = Math.max(0, this.state.energy - 2);

    // 空腹度の増加
    this.state.hunger = Math.min(100, this.state.hunger + 3);

    // 幸福度の減少（空腹や疲労）
    if (this.state.hunger > 70 || this.state.energy < 20) {
      this.state.happiness = Math.max(0, this.state.happiness - 5);
      this.state.emotion = PetEmotion.SAD;
    } else if (this.state.happiness > 80) {
      this.state.emotion = PetEmotion.HAPPY;
    }

    // 最後のインタラクションからの経過時間をチェック
    const timeSinceLastInteraction = Date.now() - this.state.lastInteraction;

    if (timeSinceLastInteraction > 3600000) {
      // 1時間以上
      this.state.emotion = PetEmotion.BORED;
    }
  }

  /**
   * ペットの状態を取得
   */
  getState(): PetState {
    return { ...this.state };
  }

  /**
   * ペットの情報を表示
   */
  displayInfo(): string {
    const petInfo = PET_INFO[this.state.type as string] || {
      emoji: "🐾",
      personality: "かわいい",
    };

    return `
${this.getEmoji()} ${this.state.name}ちゃん

**種類:** ${this.state.type}
**性格:** ${petInfo.personality}
**感情:** ${this.state.emotion}
**エネルギー:** ${this.state.energy}/100
**空腹度:** ${this.state.hunger}/100
**幸福度:** ${this.state.happiness}/100
**インタラクション回数:** ${this.interactionCount}
**最後のインタラクション:** ${new Date(this.state.lastInteraction).toISOString()}
    `.trim();
  }

  /**
   * 名前がマッチするかチェック
   */
  private isNameMatch(input: string): boolean {
    const normalizedInput = input.toLowerCase().replace(/[-_\s]/g, "");
    const normalizedName = this.state.name.toLowerCase().replace(/[-_\s]/g, "");

    return normalizedInput.includes(normalizedName);
  }

  /**
   * 感情を更新
   */
  private updateEmotion(message: string): void {
    const lowerMessage = message.toLowerCase();

    if (
      lowerMessage.includes("悲") ||
      lowerMessage.includes("さみ") ||
      lowerMessage.includes("涙")
    ) {
      this.state.emotion = PetEmotion.SAD;
      this.state.happiness = Math.max(0, this.state.happiness - 10);
    } else if (
      lowerMessage.includes("楽") ||
      lowerMessage.includes("たの") ||
      lowerMessage.includes("嬉")
    ) {
      this.state.emotion = PetEmotion.HAPPY;
      this.state.happiness = Math.min(100, this.state.happiness + 10);
    } else if (
      lowerMessage.includes("ねむ") ||
      lowerMessage.includes("おやす")
    ) {
      this.state.emotion = PetEmotion.SLEEPY;
    } else if (
      lowerMessage.includes("おなか") ||
      lowerMessage.includes("腹") ||
      lowerMessage.includes("飢")
    ) {
      this.state.emotion = PetEmotion.HUNGRY;
      this.state.hunger = Math.min(100, this.state.hunger + 10);
    } else if (
      lowerMessage.includes("何") ||
      lowerMessage.includes("なに") ||
      lowerMessage.includes("どう")
    ) {
      this.state.emotion = PetEmotion.CURIOUS;
    } else {
      // ランダムな感情
      const emotions = Object.values(PetEmotion);
      this.state.emotion =
        emotions[Math.floor(Math.random() * emotions.length)];
    }
  }

  /**
   * 絵文字を取得
   */
  private getEmoji(): string {
    return PET_INFO[this.state.type as string]?.emoji || "🐾";
  }

  /**
   * ランダムなアクションを取得
   */
  private getRandomAction(): string {
    const actions = [
      "尻尾を振る",
      "頭を傾げる",
      "耳をピクッと動かす",
      "目を輝かせる",
      "鼻をツンツンする",
    ];
    return actions[Math.floor(Math.random() * actions.length)];
  }

  /**
   * 話しかけた時のアクションを取得
   */
  private getTalkingAction(message: string): string {
    if (message.length < 10) {
      return "小さく返事";
    } else if (message.includes("？") || message.includes("?")) {
      return "首を傾げて考える";
    } else {
      return "興味深く聞く";
    }
  }

  /**
   * インタラクション回数を取得
   */
  getInteractionCount(): number {
    return this.interactionCount;
  }

  /**
   * ペットの種類を取得
   */
  getType(): PetType {
    return this.state.type;
  }

  /**
   * ペットの名前を取得
   */
  getName(): string {
    return this.state.name;
  }
}

/**
 * ペットの種類のリストを取得
 */
export function getPetTypes(): Array<{
  type: PetType;
  emoji: string;
  personality: string;
}> {
  return Object.entries(PET_INFO).map(([type, info]) => ({
    type: type as PetType,
    emoji: info.emoji,
    personality: info.personality,
  }));
}

/**
 * ランダムなペットの種類を取得
 */
export function getRandomPetType(): PetType {
  const types = Object.values(PetType);
  return types[Math.floor(Math.random() * types.length)];
}

/**
 * デフォルトのペット名を生成
 */
export function generateDefaultPetName(petType: PetType): string {
  const names: Record<PetType, string[]> = {
    [PetType.CAT]: ["ミケ", "タマ", "クロ", "シロ", "モモ"],
    [PetType.DOG]: ["ポチ", "シバ", "クロ", "シロ", "マル"],
    [PetType.RABBIT]: ["ウサ", "ピョン", "ミミ", "チョコ", "ララ"],
    [PetType.BIRD]: ["チー", "ピオ", "キジ", "スズメ", "トラ"],
    [PetType.FOX]: ["ギツネ", "コギツ", "コン", "キツ", "ギン"],
    [PetType.OWL]: [
      "フクロウ",
      "ホウオウ",
      "ミミズク",
      "アオバズク",
      "シロフクロウ",
    ],
    [PetType.PANDA]: ["パンダ", "モモ", "シロ", "クロ", "タツ"],
    [PetType.KOALA]: ["コアラ", "ユーカ", "マル", "シロ", "タツ"],
    [PetType.SLOTH]: ["ナマケモノ", "スロウ", "スージ", "ライム", "フリッツ"],
    [PetType.OTTER]: ["カワウソ", "オッター", "ママ", "パパ", "チビ"],
    [PetType.PENGUIN]: ["ペンギン", "タカ", "ヒナ", "ポポ", "ララ"],
    [PetType.DUCK]: ["アヒル", "ガガ", "クワ", "ポポ", "ララ"],
    [PetType.TURTLE]: ["カメ", "タマ", "ミニ", "カメ吉", "ウメ"],
    [PetType.HAMSTER]: ["ハムスター", "モモ", "チョコ", "キラ", "リラ"],
    [PetType.FERRET]: ["イタチ", "ココ", "チョコ", "キラ", "リラ"],
    [PetType.CHINCHILLA]: ["チンチラ", "モモ", "チョコ", "キラ", "リラ"],
    [PetType.HEDGEHOG]: ["ハリネズミ", "トゲ", "チュン", "モモ", "リラ"],
  };

  const typeNames = names[petType];
  return typeNames[Math.floor(Math.random() * typeNames.length)];
}
