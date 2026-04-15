import { ILLMProvider, LLMProviderType } from "../providers/LLMProvider.js";
import { TaskClassifier, ClassificationResult } from "./TaskClassifier.js";

export interface ModelRoutingConfig {
  enabled: boolean;
  light: { provider: LLMProviderType; model: string };
  heavy: { provider: LLMProviderType; model: string };
}

export class ModelRouter {
  private lightProvider: ILLMProvider;
  private heavyProvider: ILLMProvider;
  private classifier: TaskClassifier;

  constructor(lightProvider: ILLMProvider, heavyProvider: ILLMProvider) {
    this.lightProvider = lightProvider;
    this.heavyProvider = heavyProvider;
    this.classifier = new TaskClassifier();
  }

  selectProvider(
    userInput: string,
    context?: { iteration?: number; toolResultCount?: number },
  ): {
    provider: ILLMProvider;
    classification: ClassificationResult;
  } {
    const classification = this.classifier.classify(userInput, context);
    const provider =
      classification.suggestedModel === "light"
        ? this.lightProvider
        : this.heavyProvider;

    console.log(
      `Brain routing: ${classification.complexity} → ${provider.getDefaultModel()} (${classification.reason})`,
    );

    return { provider, classification };
  }

  getLightProvider(): ILLMProvider {
    return this.lightProvider;
  }

  getHeavyProvider(): ILLMProvider {
    return this.heavyProvider;
  }

  getClassifier(): TaskClassifier {
    return this.classifier;
  }
}
