import {
  DaemonState,
  TickEvent,
  TickHandler,
  TickTask,
  TickPriority,
  ProactiveResult,
  DaemonEvent,
  EventType,
  EventListener,
  ProactiveCondition,
  DreamState,
  DreamSettings,
  NotificationConfig,
} from "../types/index.js";
import { MemorySystem } from "../memory/MemorySystem.js";
import { ILLMProvider } from "../providers/LLMProvider.js";
import { AutoDream, DreamConsolidationResult } from "./AutoDream.js";
import * as fs from "fs/promises";
import * as path from "path";

export class KAIROSDaemon {
  private basePath: string;
  private pidPath: string;
  private state: DaemonState;
  private memorySystem: MemorySystem;
  private llmProvider: ILLMProvider | null;
  private autoDream: AutoDream;
  private tickTasks: Map<string, TickTask> = new Map();
  private tickInterval: NodeJS.Timeout | null = null;
  private eventListeners: Map<EventType, EventListener[]> = new Map();
  private isShuttingDown: boolean = false;

  // ユーザーアクティビティ追跡
  private lastUserActivityTime: number = Date.now();

  // プロアクティブ条件
  private proactiveConditions: ProactiveCondition[] = [
    {
      type: "idle_time",
      enabled: true,
      threshold: 1800, // 30分
      lastTriggerTime: 0,
    },
    {
      type: "memory_pressure",
      enabled: true,
      threshold: 500, // メモリ行数
      lastTriggerTime: 0,
    },
  ];

  // ドリーム設定
  private dreamSettings: DreamSettings = {
    autoTrigger: true,
    idleThresholdMinutes: 60, // 1時間
    maxDurationMinutes: 30, // 最大30分
    minSessionsSinceDream: 5,
    consolidationIntervalHours: 24,
  };

  // 通知設定
  private notificationConfig: NotificationConfig = {
    enabled: true,
    channels: ["console"],
    priority: "medium",
  };

  constructor(
    basePath: string,
    memorySystem: MemorySystem,
    llmProvider?: ILLMProvider,
  ) {
    this.basePath = basePath;
    this.pidPath = path.join(basePath, ".kairos", "daemon.pid");
    this.memorySystem = memorySystem;
    this.llmProvider = llmProvider || null;
    this.autoDream = new AutoDream(
      basePath,
      memorySystem,
      llmProvider || undefined,
    );
    this.state = {
      isRunning: false,
      startTime: 0,
      uptimeSeconds: 0,
      tickCount: 0,
      lastTickTime: 0,
    };
  }

  /**
   * デーモンの初期化
   */
  async initialize(): Promise<void> {
    try {
      // ディレクトリの作成
      await fs.mkdir(path.join(this.basePath, ".kairos"), { recursive: true });

      // AutoDreamの初期化
      await this.autoDream.initialize();

      // アクティビティ時間のロード
      await this.loadLastActivityTime();

      // 既存のPIDファイルを確認
      const existingPid = await this.checkExistingDaemon();
      if (existingPid) {
        throw new Error(`Daemon is already running with PID ${existingPid}`);
      }

      // 既存のPIDファイルを削除
      try {
        await fs.unlink(this.pidPath);
      } catch {
        // ファイルが存在しない場合は無視
      }

      // デフォルトのTickタスクを登録
      this.registerDefaultTickTasks();

      // イベント発行
      this.emitEvent({
        type: EventType.DAEMON_START,
        timestamp: Date.now(),
        data: {
          basePath: this.basePath,
        },
      });
    } catch (error) {
      console.error("Failed to initialize daemon:", error);
      throw error;
    }
  }

  /**
   * デーモンの起動
   */
  async start(): Promise<void> {
    if (this.state.isRunning) {
      throw new Error("Daemon is already running");
    }

    try {
      // PIDファイルの作成
      await fs.writeFile(this.pidPath, process.pid.toString(), "utf-8");

      this.state.isRunning = true;
      this.state.startTime = Date.now();
      this.state.uptimeSeconds = 0;
      this.state.tickCount = 0;
      this.state.lastTickTime = Date.now();
      this.state.pid = process.pid;

      // Tickタイマーの開始
      await this.startTicker();

      console.log(`🚀 KAIROS Daemon started (PID: ${process.pid})`);
      console.log(`📊 Tick interval: 60 seconds`);

      // シグナルハンドラーの設定
      this.setupSignalHandlers();
    } catch (error) {
      console.error("Failed to start daemon:", error);
      // エラーの場合はPIDファイルを削除
      await this.cleanupPidFile();
      throw error;
    }
  }

  /**
   * デーモンの停止
   */
  async stop(): Promise<void> {
    if (!this.state.isRunning) {
      console.log("Daemon is not running");
      return;
    }

    this.isShuttingDown = true;

    try {
      // Tickタイマーの停止
      if (this.tickInterval) {
        clearTimeout(this.tickInterval);
        this.tickInterval = null;
      }

      // 最終状態の記録
      this.state.isRunning = false;
      this.state.uptimeSeconds = Math.floor(
        (Date.now() - this.state.startTime) / 1000,
      );

      // イベント発行
      this.emitEvent({
        type: EventType.DAEMON_STOP,
        timestamp: Date.now(),
        data: {
          uptimeSeconds: this.state.uptimeSeconds,
          tickCount: this.state.tickCount,
        },
      });

      console.log(`🛑 KAIROS Daemon stopped`);
      console.log(`📊 Uptime: ${this.formatUptime(this.state.uptimeSeconds)}`);
      console.log(`📊 Total ticks: ${this.state.tickCount}`);
    } catch (error) {
      console.error("Error stopping daemon:", error);
    } finally {
      // PIDファイルの削除
      await this.cleanupPidFile();
      this.isShuttingDown = false;
    }
  }

  /**
   * デーモン状態の取得
   */
  getState(): DaemonState {
    return { ...this.state };
  }

  /**
   * Tickタスクの登録
   */
  registerTickTask(task: TickTask): void {
    this.tickTasks.set(task.id, task);
    console.log(`✅ Registered tick task: ${task.name}`);
  }

  /**
   * デフォルトのTickタスクを登録
   */
  private registerDefaultTickTasks(): void {
    // プロアクティブ判断タスク
    this.registerTickTask({
      id: "proactive-check",
      handler: this.handleProactiveCheck.bind(this),
      priority: TickPriority.HIGH,
      name: "Proactive Check",
      description: "Check if proactive action should be taken",
    });

    // ドリームトリガーチェック
    this.registerTickTask({
      id: "dream-trigger-check",
      handler: this.handleDreamTriggerCheck.bind(this),
      priority: TickPriority.MEDIUM,
      name: "Dream Trigger Check",
      description: "Check if dream should be triggered",
    });

    // メモリ統合チェック
    this.registerTickTask({
      id: "memory-consolidation-check",
      handler: this.handleMemoryConsolidationCheck.bind(this),
      priority: TickPriority.MEDIUM,
      name: "Memory Consolidation Check",
      description: "Check if memory consolidation is needed",
    });

    // ヘルスチェック
    this.registerTickTask({
      id: "health-check",
      handler: this.handleHealthCheck.bind(this),
      priority: TickPriority.LOW,
      name: "Health Check",
      description: "Check daemon health",
    });
  }

  /**
   * Tickタイマーの開始
   */
  private async startTicker(): Promise<void> {
    const tickIntervalSeconds = 60; // デフォルト60秒

    const executeTick = async () => {
      if (!this.state.isRunning || this.isShuttingDown) {
        return;
      }

      this.state.tickCount++;
      this.state.lastTickTime = Date.now();
      this.state.uptimeSeconds = Math.floor(
        (Date.now() - this.state.startTime) / 1000,
      );

      const event: TickEvent = {
        timestamp: Date.now(),
        tickNumber: this.state.tickCount,
        interval: tickIntervalSeconds,
      };

      this.emitEvent({
        type: EventType.TICK,
        timestamp: event.timestamp,
        data: event,
      });

      // 全てのTickタスクを実行
      await this.executeTickTasks(event);
    };

    // 最初のTickを即実行
    await executeTick();

    // 定期的なTick
    this.tickInterval = setInterval(executeTick, tickIntervalSeconds * 1000);
  }

  /**
   * 全てのTickタスクを実行
   */
  private async executeTickTasks(event: TickEvent): Promise<void> {
    const sortedTasks = Array.from(this.tickTasks.values()).sort((a, b) => {
      const priorityOrder = {
        [TickPriority.HIGH]: 1,
        [TickPriority.MEDIUM]: 2,
        [TickPriority.LOW]: 3,
      };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    for (const task of sortedTasks) {
      try {
        await task.handler(event);
      } catch (error) {
        console.error(`Error executing tick task ${task.name}:`, error);
        this.emitEvent({
          type: EventType.ERROR,
          timestamp: Date.now(),
          data: {
            task: task.name,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  /**
   * プロアクティブチェック
   */
  private async handleProactiveCheck(event: TickEvent): Promise<void> {
    console.log("🔍 Running proactive check...");

    const result = await this.evaluateProactiveConditions();

    if (result.shouldAct) {
      console.log(`✨ Proactive action needed: ${result.reason}`);

      if (result.suggestedAction) {
        console.log(`💡 Suggested action: ${result.suggestedAction}`);

        // ユーザーに通知
        await this.sendNotification(
          result.reason,
          result.suggestedAction,
          this.notificationConfig.priority,
        );
      }

      this.emitEvent({
        type: EventType.PROACTIVE_ACTION,
        timestamp: Date.now(),
        data: result,
      });
    } else {
      console.log("😴 No proactive action needed");
    }
  }

  /**
   * プロアクティブ条件の評価
   */
  private async evaluateProactiveConditions(): Promise<ProactiveResult> {
    const now = Date.now();

    for (const condition of this.proactiveConditions) {
      if (!condition.enabled) continue;

      let shouldAct = false;
      let reason = "";
      let suggestedAction = "";

      switch (condition.type) {
        case "idle_time":
          // アイドル時間チェック
          const lastUserActivity = this.getLastUserActivityTime();
          const idleTime = (now - lastUserActivity) / 1000; // 秒

          if (condition.threshold && idleTime > condition.threshold) {
            shouldAct = true;
            reason = `Idle time exceeded (${Math.floor(idleTime / 60)} minutes)`;
            suggestedAction = "Suggest task or ask if help is needed";
          }
          break;

        case "memory_pressure":
          // メモリ圧力チェック
          const stats = await this.memorySystem.getMemoryStats();

          if (condition.threshold && stats.memoryLines > condition.threshold) {
            shouldAct = true;
            reason = `Memory pressure high (${stats.memoryLines} lines)`;
            suggestedAction = "Run memory compaction";
          }
          break;

        default:
          break;
      }

      if (shouldAct) {
        return {
          shouldAct,
          actionType: "notification",
          reason,
          suggestedAction,
        };
      }
    }

    return {
      shouldAct: false,
      actionType: "none",
      reason: "No conditions met",
    };
  }

  /**
   * ドリームトリガーチェック
   */
  private async handleDreamTriggerCheck(event: TickEvent): Promise<void> {
    if (!this.dreamSettings.autoTrigger) {
      return;
    }

    const lastUserActivity = this.getLastUserActivityTime();
    const idleTimeMinutes = (Date.now() - lastUserActivity) / 60000;

    // セッション数のチェック（簡易的）
    const sessionsSinceDream = await this.getSessionsSinceDream();

    if (
      idleTimeMinutes >= this.dreamSettings.idleThresholdMinutes &&
      sessionsSinceDream >= this.dreamSettings.minSessionsSinceDream
    ) {
      console.log(
        "💤 Idle threshold and session count reached, triggering dream mode",
      );

      await this.startDream();
    }
  }

  /**
   * ドリームからのセッション数の取得
   */
  private async getSessionsSinceDream(): Promise<number> {
    const activityPath = path.join(this.basePath, ".kairos", "sessions.json");
    try {
      const content = await fs.readFile(activityPath, "utf-8");
      const data = JSON.parse(content);
      return data.sessionCount || 0;
    } catch {
      return 0;
    }
  }

  /**
   * メモリ統合チェック
   */
  private async handleMemoryConsolidationCheck(
    event: TickEvent,
  ): Promise<void> {
    const now = Date.now();
    const lastDreamTime = await this.getLastDreamTime();

    if (lastDreamTime > 0) {
      const hoursSinceDream = (now - lastDreamTime) / 3600000;

      if (hoursSinceDream >= this.dreamSettings.consolidationIntervalHours) {
        console.log("🧠 Memory consolidation interval reached");

        await this.memorySystem.batchConsolidate();
      }
    }
  }

  /**
   * ヘルスチェック
   */
  private async handleHealthCheck(event: TickEvent): Promise<void> {
    console.log(
      `💓 Health check - Uptime: ${this.formatUptime(this.state.uptimeSeconds)}, Ticks: ${this.state.tickCount}`,
    );

    const memoryStats = await this.memorySystem.getMemoryStats();
    console.log(
      `💓 Memory: ${memoryStats.memoryLines} lines, ${memoryStats.topicCount} topics`,
    );
  }

  /**
   * ドリームモードの開始
   */
  private async startDream(): Promise<void> {
    console.log("🌙 Starting dream mode...");

    this.emitEvent({
      type: EventType.DREAM_START,
      timestamp: Date.now(),
      data: {
        duration: this.dreamSettings.maxDurationMinutes,
      },
    });

    try {
      // AutoDreamの実行
      const result = await this.autoDream.run(this.dreamSettings);

      // ユーザーに通知
      await this.sendNotification(
        "Dream Mode Completed",
        `Processed ${result.logsProcessed} logs, resolved ${result.contradictionsResolved} contradictions, extracted ${result.insightsExtracted} insights`,
        "low",
      );

      // 最後のドリーム時間を更新
      await this.updateLastDreamTime();
    } catch (error) {
      console.error("Dream mode failed:", error);
      this.emitEvent({
        type: EventType.ERROR,
        timestamp: Date.now(),
        data: {
          error: error instanceof Error ? error.message : String(error),
          source: "dream",
        },
      });
    }

    // ドリーム完了イベント
    this.emitEvent({
      type: EventType.DREAM_END,
      timestamp: Date.now(),
      data: {
        duration: this.dreamSettings.maxDurationMinutes,
      },
    });
  }

  /**
   * 最後のユーザーアクティビティ時間の取得
   */
  private getLastUserActivityTime(): number {
    return this.lastUserActivityTime;
  }

  /**
   * ユーザーアクティビティ時間の更新
   */
  async updateLastActivityTime(): Promise<void> {
    this.lastUserActivityTime = Date.now();

    // アクティビティファイルに保存
    const activityPath = path.join(this.basePath, ".kairos", "activity.json");
    try {
      await fs.writeFile(
        activityPath,
        JSON.stringify({ lastActivity: this.lastUserActivityTime }),
        "utf-8",
      );
    } catch (error) {
      console.error("Failed to update activity file:", error);
    }
  }

  /**
   * アクティビティファイルから時間をロード
   */
  private async loadLastActivityTime(): Promise<void> {
    const activityPath = path.join(this.basePath, ".kairos", "activity.json");
    try {
      const content = await fs.readFile(activityPath, "utf-8");
      const data = JSON.parse(content);
      this.lastUserActivityTime = data.lastActivity || Date.now();
    } catch {
      // ファイルが存在しない場合は現在時刻を使用
      this.lastUserActivityTime = Date.now();
    }
  }

  /**
   * 最後のドリーム時間の取得
   */
  private async getLastDreamTime(): Promise<number> {
    const dreamPath = path.join(this.basePath, ".kairos", "dream_time.json");
    try {
      const content = await fs.readFile(dreamPath, "utf-8");
      const data = JSON.parse(content);
      return data.lastDream || 0;
    } catch {
      // ファイルが存在しない場合は24時間前を返す
      return Date.now() - 86400000;
    }
  }

  /**
   * 最後のドリーム時間の更新
   */
  private async updateLastDreamTime(): Promise<void> {
    const dreamPath = path.join(this.basePath, ".kairos", "dream_time.json");
    try {
      await fs.writeFile(
        dreamPath,
        JSON.stringify({ lastDream: Date.now() }),
        "utf-8",
      );
    } catch (error) {
      console.error("Failed to update dream time file:", error);
    }
  }

  /**
   * 通知の送信
   */
  private async sendNotification(
    title: string,
    message: string,
    priority: string,
  ): Promise<void> {
    if (!this.notificationConfig.enabled) {
      return;
    }

    // 静止時間のチェック
    if (this.notificationConfig.quietHours) {
      const now = new Date();
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();

      const [startHour, startMin] = this.notificationConfig.quietHours.start
        .split(":")
        .map(Number);
      const [endHour, endMin] = this.notificationConfig.quietHours.end
        .split(":")
        .map(Number);

      const currentMinutes = currentHour * 60 + currentMinute;
      const startMinutes = startHour * 60 + startMin;
      const endMinutes = endHour * 60 + endMin;

      if (currentMinutes >= startMinutes && currentMinutes <= endMinutes) {
        console.log("🔇 Quiet hours, notification suppressed");
        return;
      }
    }

    // 各チャンネルで通知
    for (const channel of this.notificationConfig.channels) {
      switch (channel) {
        case "console":
          console.log(`\n🔔 [${priority.toUpperCase()}] ${title}`);
          console.log(`📝 ${message}\n`);
          break;
        case "os":
          // TODO: OS通知の実装
          console.log("🔔 OS notification not yet implemented");
          break;
        case "push":
          // TODO: Push通知の実装
          console.log("🔔 Push notification not yet implemented");
          break;
      }
    }
  }

  /**
   * イベントリスナーの登録
   */
  on(eventType: EventType, listener: EventListener): void {
    if (!this.eventListeners.has(eventType)) {
      this.eventListeners.set(eventType, []);
    }
    this.eventListeners.get(eventType)!.push(listener);
  }

  /**
   * イベントリスナーの削除
   */
  off(eventType: EventType, listener: EventListener): void {
    const listeners = this.eventListeners.get(eventType);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }
  }

  /**
   * イベントの発行
   */
  private emitEvent(event: DaemonEvent): void {
    const listeners = this.eventListeners.get(event.type);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          console.error(`Error in event listener for ${event.type}:`, error);
        }
      }
    }
  }

  /**
   * イベントの発行（公開メソッド - テスト用）
   */
  public emit(event: DaemonEvent): void {
    this.emitEvent(event);
  }

  /**
   * 既存のデーモンを確認
   */
  public async checkExistingDaemon(): Promise<number | null> {
    try {
      const pidContent = await fs.readFile(this.pidPath, "utf-8");
      const pid = parseInt(pidContent.trim(), 10);

      // プロセスが存在するか確認
      try {
        process.kill(pid, 0); // シグナル0でプロセス確認
        return pid; // プロセスが存在する
      } catch {
        // プロセスが存在しない
        return null;
      }
    } catch {
      // PIDファイルが存在しない
      return null;
    }
  }

  /**
   * シグナルハンドラーの設定
   */
  private setupSignalHandlers(): void {
    const gracefulShutdown = async (signal: string) => {
      console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
      await this.stop();
      process.exit(0);
    };

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  }

  /**
   * PIDファイルのクリーンアップ
   */
  private async cleanupPidFile(): Promise<void> {
    try {
      await fs.unlink(this.pidPath);
    } catch {
      // ファイルが存在しない場合は無視
    }
  }

  /**
   * アップタイムのフォーマット
   */
  private formatUptime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  /**
   * 夢設定の更新
   */
  updateDreamSettings(settings: Partial<DreamSettings>): void {
    this.dreamSettings = { ...this.dreamSettings, ...settings };
  }

  /**
   * 通知設定の更新
   */
  updateNotificationSettings(settings: Partial<NotificationConfig>): void {
    this.notificationConfig = { ...this.notificationConfig, ...settings };
  }

  /**
   * プロアクティブ条件の更新
   */
  updateProactiveConditions(conditions: Partial<ProactiveCondition>[]): void {
    if (conditions) {
      this.proactiveConditions = conditions.map((cond, i) => ({
        ...this.proactiveConditions[i],
        ...cond,
      }));
    }
  }
}
