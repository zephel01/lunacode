/**
 * ModelRouter — タスクに最適なプロバイダー+モデルを選択する
 *
 * Phase 4（既存）: light / heavy の 2 プロバイダーから複雑度で選択
 * Phase 15（拡張）: タスク種別ごとの config ルールでルーティング＋フォールバックチェーン
 */

import { ILLMProvider, LLMProviderType } from "../providers/LLMProvider.js";
import { TaskClassifier, ClassificationResult } from "./TaskClassifier.js";
import type { RoutingConfig, RoutingRule, TaskType } from "../types/index.js";

// ── Phase 4（既存）型定義 ────────────────────────────────────────────────────

export interface ModelRoutingConfig {
  enabled: boolean;
  light: { provider: LLMProviderType; model: string };
  heavy: { provider: LLMProviderType; model: string };
}

// ── Phase 15 型定義 ──────────────────────────────────────────────────────────

export interface RoutingSelection {
  provider: ILLMProvider;
  classification: ClassificationResult;
  /** ルーティング経由で選ばれたか（false なら Phase 4 の light/heavy フォールバック） */
  routedByRule: boolean;
  /** 選択されたルール（あれば） */
  matchedRule?: RoutingRule;
}

// ── ModelRouter ──────────────────────────────────────────────────────────────

export class ModelRouter {
  private lightProvider: ILLMProvider;
  private heavyProvider: ILLMProvider;
  private classifier: TaskClassifier;

  // Phase 15: 高度ルーティング
  private routingConfig?: RoutingConfig;
  private providerPool: Map<string, ILLMProvider> = new Map();
  private fallbackChain: string[] = [];

  constructor(lightProvider: ILLMProvider, heavyProvider: ILLMProvider) {
    this.lightProvider = lightProvider;
    this.heavyProvider = heavyProvider;
    this.classifier = new TaskClassifier();
  }

  // ── Phase 15: 高度ルーティングの初期化 ──────────────────────────────────────

  /**
   * 高度ルーティングを有効化する。
   * providerPool に登録されたプロバイダーが config のルールで使われる。
   */
  enableAdvancedRouting(
    config: RoutingConfig,
    providers: Map<string, ILLMProvider>,
  ): void {
    this.routingConfig = config;
    this.providerPool = providers;
    this.fallbackChain = config.fallbackChain ?? [];
  }

  /** 高度ルーティングが有効かどうか */
  isAdvancedRoutingEnabled(): boolean {
    return this.routingConfig?.enabled === true && this.providerPool.size > 0;
  }

  // ── プロバイダー選択 ────────────────────────────────────────────────────────

  selectProvider(
    userInput: string,
    context?: { iteration?: number; toolResultCount?: number },
  ): RoutingSelection {
    const classification = this.classifier.classify(userInput, context);

    // Phase 15: 高度ルーティングが有効ならルールベースで選択
    if (this.isAdvancedRoutingEnabled()) {
      const result = this.selectByRule(classification);
      if (result) {
        console.log(
          `🧭 Routing: ${classification.taskType} → ${result.provider.getType()}/${result.provider.getDefaultModel()} (rule match)`,
        );
        return {
          provider: result.provider,
          classification,
          routedByRule: true,
          matchedRule: result.rule,
        };
      }
    }

    // Phase 4 フォールバック: light / heavy
    const provider =
      classification.suggestedModel === "light"
        ? this.lightProvider
        : this.heavyProvider;

    console.log(
      `Brain routing: ${classification.complexity} → ${provider.getDefaultModel()} (${classification.reason})`,
    );

    return { provider, classification, routedByRule: false };
  }

  /**
   * フォールバックチェーンを使って次のプロバイダーを取得する。
   * 現在のプロバイダーが失敗した場合に呼び出す。
   * @param currentProviderType 現在失敗したプロバイダーの型
   * @returns 次のプロバイダー、またはチェーン終端なら undefined
   */
  getNextFallback(currentProviderType: string): ILLMProvider | undefined {
    if (this.fallbackChain.length === 0) return undefined;

    const idx = this.fallbackChain.indexOf(currentProviderType);
    // チェーン内の次のプロバイダーを探す
    const startIdx = idx >= 0 ? idx + 1 : 0;

    for (let i = startIdx; i < this.fallbackChain.length; i++) {
      const name = this.fallbackChain[i];
      const provider = this.providerPool.get(name);
      if (provider && name !== currentProviderType) {
        console.log(
          `🔄 Fallback: ${currentProviderType} → ${name}/${provider.getDefaultModel()}`,
        );
        return provider;
      }
    }
    return undefined;
  }

  // ── アクセサ（既存互換） ────────────────────────────────────────────────────

  getLightProvider(): ILLMProvider {
    return this.lightProvider;
  }

  getHeavyProvider(): ILLMProvider {
    return this.heavyProvider;
  }

  getClassifier(): TaskClassifier {
    return this.classifier;
  }

  getProviderPool(): Map<string, ILLMProvider> {
    return this.providerPool;
  }

  getRoutingConfig(): RoutingConfig | undefined {
    return this.routingConfig;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /** ルーティングルールから最適プロバイダーを探す */
  private selectByRule(
    classification: ClassificationResult,
  ): { provider: ILLMProvider; rule: RoutingRule } | undefined {
    const rules = this.routingConfig?.rules ?? [];
    const taskType = classification.taskType;

    // 1. タスク種別にマッチするルールを探す
    for (const rule of rules) {
      if (rule.taskType === taskType) {
        const provider = this.providerPool.get(rule.provider);
        if (provider) {
          return { provider, rule };
        }
      }
    }

    // 2. デフォルトプロバイダーにフォールバック
    const defaultName = this.routingConfig?.defaultProvider;
    if (defaultName) {
      const provider = this.providerPool.get(defaultName);
      if (provider) {
        return {
          provider,
          rule: { taskType, provider: defaultName },
        };
      }
    }

    return undefined; // Phase 4 の light/heavy にフォールバック
  }
}
