import { Tool } from "../types/index.js";

/**
 * ツール実行リクエスト
 */
export interface ToolExecutionRequest {
  tool: Tool;
  params: unknown;
  id: string;
  dependencies?: string[]; // 依存するツールIDのリスト
}

/**
 * ツール実行結果
 */
export interface ToolExecutionResult {
  id: string;
  tool: string;
  success: boolean;
  output: string;
  error?: string;
  executionTime: number;
}

/**
 * 並列実行結果
 */
export interface ParallelExecutionResult {
  results: ToolExecutionResult[];
  totalTime: number;
  successCount: number;
  failureCount: number;
}

/**
 * 並列ツール実行システム
 *
 * Phase 3.1: 並列ツール実行
 * - 複数ツールの同時実行
 * - 依存関係の自動解決
 * - 実行時間の短縮
 */
export class ParallelToolExecutor {
  private maxConcurrentExecutions: number;

  constructor(maxConcurrentExecutions: number = 5) {
    this.maxConcurrentExecutions = maxConcurrentExecutions;
  }

  /**
   * ツールを並列実行
   */
  async executeTools(
    requests: ToolExecutionRequest[],
  ): Promise<ParallelExecutionResult> {
    const startTime = Date.now();

    // 依存関係の解決と実行順序の決定
    const executionOrder = this.resolveDependencies(requests);

    // 並列実行
    const results = await this.executeInBatches(executionOrder);

    const totalTime = Date.now() - startTime;
    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.filter((r) => !r.success).length;

    return {
      results,
      totalTime,
      successCount,
      failureCount,
    };
  }

  /**
   * 依存関係を解決して実行順序を決定
   */
  private resolveDependencies(
    requests: ToolExecutionRequest[],
  ): ToolExecutionRequest[][] {
    // ツールIDをマップに
    const requestMap = new Map<string, ToolExecutionRequest>();
    requests.forEach((req) => {
      requestMap.set(req.id, req);
    });

    // 拓朴ソートで実行順序を決定
    const sorted = this.topologicalSort(requests);

    // 依存関係に基づいてバッチを作成
    const batches: ToolExecutionRequest[][] = [];
    const executed = new Set<string>();

    for (const req of sorted) {
      if (executed.has(req.id)) continue;

      // このバッチで実行できるツールを収集
      const batch = this.getExecutableTools(req, sorted, executed);
      batch.forEach((tool) => executed.add(tool.id));

      batches.push(batch);
    }

    return batches;
  }

  /**
   * 拓朴ソート
   */
  private topologicalSort(
    requests: ToolExecutionRequest[],
  ): ToolExecutionRequest[] {
    const visited = new Set<string>();
    const sorted: ToolExecutionRequest[] = [];
    const requestMap = new Map<string, ToolExecutionRequest>();
    requests.forEach((req) => requestMap.set(req.id, req));

    const visit = (req: ToolExecutionRequest) => {
      if (visited.has(req.id)) return;

      visited.add(req.id);

      // 依存ツールを先に訪問
      if (req.dependencies) {
        for (const depId of req.dependencies) {
          const depReq = requestMap.get(depId);
          if (depReq) {
            visit(depReq);
          }
        }
      }

      sorted.push(req);
    };

    for (const req of requests) {
      visit(req);
    }

    return sorted;
  }

  /**
   * 実行可能なツールを収集
   */
  private getExecutableTools(
    req: ToolExecutionRequest,
    allRequests: ToolExecutionRequest[],
    executed: Set<string>,
  ): ToolExecutionRequest[] {
    const executable: ToolExecutionRequest[] = [];

    // 依存関係のチェーンを追跡
    const collect = (currentReq: ToolExecutionRequest) => {
      if (executed.has(currentReq.id)) return;
      if (executable.includes(currentReq)) return;

      // 依存関係がある場合は、依存ツールを先に収集
      if (currentReq.dependencies) {
        for (const depId of currentReq.dependencies) {
          const depReq = allRequests.find((r) => r.id === depId);
          if (depReq) {
            collect(depReq);
          }
        }
      }

      executable.push(currentReq);
    };

    collect(req);
    return executable;
  }

  /**
   * バッチで並列実行
   */
  private async executeInBatches(
    batches: ToolExecutionRequest[][],
  ): Promise<ToolExecutionResult[]> {
    const allResults: ToolExecutionResult[] = [];

    for (const batch of batches) {
      // maxConcurrentExecutions でチャンク分割して並列実行
      for (let i = 0; i < batch.length; i += this.maxConcurrentExecutions) {
        const chunk = batch.slice(i, i + this.maxConcurrentExecutions);
        const chunkResults = await Promise.all(
          chunk.map((req) => this.executeTool(req)),
        );
        allResults.push(...chunkResults);
      }
    }

    return allResults;
  }

  /**
   * 単一のツールを実行
   */
  private async executeTool(
    request: ToolExecutionRequest,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();

    try {
      console.log(
        `🔧 Executing tool: ${request.tool.name} (ID: ${request.id})`,
      );

      // ツールの実行
      const result = await request.tool.execute(request.params);

      const executionTime = Date.now() - startTime;

      console.log(
        `✅ Tool ${request.tool.name} completed in ${executionTime}ms`,
      );

      return {
        id: request.id,
        tool: request.tool.name,
        success: result.success,
        output: result.output,
        error: result.error,
        executionTime,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;

      console.error(`❌ Tool ${request.tool.name} failed:`, error);

      return {
        id: request.id,
        tool: request.tool.name,
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
        executionTime,
      };
    }
  }

  /**
   * 並列実行結果をマージ
   */
  mergeResults(results: ToolExecutionResult[]): string {
    const sections: string[] = [];

    sections.push(`# Parallel Tool Execution Results`);
    sections.push(`\n**Total Tools:** ${results.length}`);
    sections.push(`**Successful:** ${results.filter((r) => r.success).length}`);
    sections.push(`**Failed:** ${results.filter((r) => !r.success).length}\n`);

    for (const result of results) {
      const statusIcon = result.success ? "✅" : "❌";
      const statusText = result.success ? "Success" : "Failed";

      sections.push(`## ${statusIcon} ${result.tool} (${statusText})`);
      sections.push(`\n**ID:** ${result.id}`);
      sections.push(`**Execution Time:** ${result.executionTime}ms`);

      if (result.success) {
        sections.push(`\n**Output:**\n\`\`\`\`\n${result.output}\n\`\`\``);
      } else {
        sections.push(
          `\n**Error:**\n\`\`\`\n${result.error || "Unknown error"}\n\`\`\``,
        );
      }

      sections.push("\n---\n");
    }

    return sections.join("\n");
  }

  /**
   * 最大同時実行数を設定
   */
  setMaxConcurrentExecutions(max: number): void {
    this.maxConcurrentExecutions = Math.max(1, max);
  }

  /**
   * 最大同時実行数を取得
   */
  getMaxConcurrentExecutions(): number {
    return this.maxConcurrentExecutions;
  }
}
