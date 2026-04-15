import { ILLMProvider } from "../providers/LLMProvider.js";
import { MemorySystem } from "../memory/MemorySystem.js";

/** Worker イベントのペイロード型 */
export interface WorkerEventData {
  taskId?: string;
  result?: string;
  error?: string;
  [key: string]: unknown;
}

/**
 * タスクの優先度
 */
export enum TaskPriority {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
  URGENT = "urgent",
}

/**
 * タスクの状態
 */
export enum TaskStatus {
  PENDING = "pending",
  ASSIGNED = "assigned",
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed",
  FAILED = "failed",
}

/**
 * エージェントタスク
 */
export interface AgentTask {
  id: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  assignedWorkerId?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
  retryCount?: number;
}

/**
 * Workerの状態
 */
export interface WorkerState {
  id: string;
  status: "idle" | "busy" | "offline";
  currentTask?: string;
  lastHeartbeat: number;
  tasksCompleted: number;
  tasksFailed: number;
}

/**
 * Coordinatorの状態
 */
export interface CoordinatorState {
  isRunning: boolean;
  workers: WorkerState[];
  tasks: AgentTask[];
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
}

/**
 * マルチエージェントCoordinator
 *
 * Phase 4.1: マルチエージェント協調
 * - Coordinator実装（マスターエージェント）
 * - Worker実装（従属エージェント）
 * - タスク分散
 * - エージェント間通信
 */
export class MultiAgentCoordinator {
  private llmProvider: ILLMProvider;
  private memorySystem: MemorySystem;
  private state: CoordinatorState;
  private workers: Map<string, WorkerAgent> = new Map();
  private tasks: Map<string, AgentTask> = new Map();
  private taskQueue: AgentTask[] = [];

  constructor(llmProvider: ILLMProvider, memorySystem: MemorySystem) {
    this.llmProvider = llmProvider;
    this.memorySystem = memorySystem;
    this.state = {
      isRunning: false,
      workers: [],
      tasks: [],
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
    };
  }

  /**
   * Coordinatorの初期化
   */
  async initialize(): Promise<void> {
    console.log("🤖 Initializing Multi-Agent Coordinator...");

    // デフォルトのWorkerを作成
    await this.createDefaultWorkers();

    console.log(`✅ Coordinator initialized with ${this.workers.size} workers`);
  }

  /**
   * Coordinatorの開始
   */
  async start(): Promise<void> {
    if (this.state.isRunning) {
      throw new Error("Coordinator is already running");
    }

    this.state.isRunning = true;

    // 全てのWorkerを開始
    for (const worker of this.workers.values()) {
      await worker.start();
    }

    // タスクの処理を開始
    await this.startTaskProcessing();

    console.log("🚀 Multi-Agent Coordinator started");
  }

  /**
   * Coordinatorの停止
   */
  async stop(): Promise<void> {
    if (!this.state.isRunning) {
      console.log("Coordinator is not running");
      return;
    }

    this.state.isRunning = false;

    // 全てのWorkerを停止
    for (const worker of this.workers.values()) {
      await worker.stop();
    }

    // タスク処理を停止
    await this.stopTaskProcessing();

    console.log("🛑 Multi-Agent Coordinator stopped");
  }

  /**
   * デフォルトのWorkerを作成
   */
  private async createDefaultWorkers(): Promise<void> {
    const workerCount = 3; // デフォルト3つのWorker

    for (let i = 0; i < workerCount; i++) {
      const workerId = `worker-${i + 1}`;
      const worker = new WorkerAgent(
        workerId,
        this.llmProvider,
        this.memorySystem,
      );

      await worker.initialize();
      this.workers.set(workerId, worker);

      // Workerイベントを監視
      worker.on("task_completed", (event: WorkerEventData) => {
        this.handleWorkerTaskCompleted(workerId, event);
      });

      worker.on("task_failed", (event: WorkerEventData) => {
        this.handleWorkerTaskFailed(workerId, event);
      });

      worker.on("heartbeat", (event: WorkerEventData) => {
        this.handleWorkerHeartbeat(workerId, event);
      });
    }
  }

  /**
   * Workerを追加
   */
  async addWorker(workerId: string): Promise<void> {
    const worker = new WorkerAgent(
      workerId,
      this.llmProvider,
      this.memorySystem,
    );

    await worker.initialize();
    this.workers.set(workerId, worker);

    if (this.state.isRunning) {
      await worker.start();
    }

    console.log(`✅ Added worker: ${workerId}`);
  }

  /**
   * Workerを削除
   */
  async removeWorker(workerId: string): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }

    await worker.stop();
    this.workers.delete(workerId);

    console.log(`🗑️ Removed worker: ${workerId}`);
  }

  /**
   * タスクを追加
   */
  async addTask(
    description: string,
    priority: TaskPriority = TaskPriority.MEDIUM,
  ): Promise<string> {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const task: AgentTask = {
      id: taskId,
      description,
      priority,
      status: TaskStatus.PENDING,
      createdAt: Date.now(),
    };

    this.tasks.set(taskId, task);
    this.taskQueue.push(task);
    this.state.totalTasks++;

    console.log(`📝 Added task: ${taskId} (${priority})`);
    console.log(`   ${description}`);

    // タスクの割り当てを試みる
    await this.assignTasks();

    return taskId;
  }

  /**
   * タスクを取得
   */
  getTask(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * 全てのタスクを取得
   */
  getAllTasks(): AgentTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * タスクを割り当て
   */
  private async assignTasks(): Promise<void> {
    // 優先度順にソート
    this.taskQueue.sort((a, b) => {
      const priorityOrder = {
        [TaskPriority.URGENT]: 1,
        [TaskPriority.HIGH]: 2,
        [TaskPriority.MEDIUM]: 3,
        [TaskPriority.LOW]: 4,
      };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    // アイドルなWorkerを探す
    const idleWorkers = Array.from(this.workers.values()).filter(
      (w) => w.getState().status === "idle",
    );

    // タスクをWorkerに割り当て
    for (const worker of idleWorkers) {
      if (this.taskQueue.length === 0) break;

      const task = this.taskQueue.shift();
      if (!task) break;

      await worker.assignTask(task);

      // タスクの状態を更新
      task.status = TaskStatus.ASSIGNED;
      task.assignedWorkerId = worker.getId();

      console.log(`🔄 Assigned task ${task.id} to worker ${worker.getId()}`);
    }
  }

  /**
   * タスク処理を開始
   */
  private async startTaskProcessing(): Promise<void> {
    const processInterval = 5000; // 5秒ごとにチェック

    const processTasks = async () => {
      if (!this.state.isRunning) return;

      // アイドルなWorkerがいれば、タスクを割り当て
      await this.assignTasks();

      // タイムアウトしたタスクをチェック
      await this.checkTimedOutTasks();

      // 定期的なタスク割り当て
      setTimeout(processTasks, processInterval);
    };

    setTimeout(processTasks, 0);
  }

  /**
   * タスク処理を停止
   */
  private async stopTaskProcessing(): Promise<void> {
    this.state.isRunning = false;
    // startTaskProcessingのsetTimeoutは次のprocessTasks実行時に
    // this.state.isRunning === false を検出して自動停止する
  }

  /**
   * タイムアウトしたタスクをチェック
   */
  private async checkTimedOutTasks(): Promise<void> {
    const now = Date.now();
    const timeoutThreshold = 300000; // 5分

    for (const task of this.tasks.values()) {
      if (
        task.status === TaskStatus.IN_PROGRESS &&
        task.startedAt &&
        now - task.startedAt > timeoutThreshold
      ) {
        console.warn(`⚠️ Task ${task.id} timed out, reassigning...`);

        // Workerに失敗を通知
        if (task.assignedWorkerId) {
          const worker = this.workers.get(task.assignedWorkerId);
          if (worker) {
            await worker.notifyTaskTimeout(task.id);
          }
        }

        // タスクを再割り当てのためにキューに戻す
        task.status = TaskStatus.PENDING;
        delete task.assignedWorkerId;
        delete task.startedAt;

        this.taskQueue.push(task);
      }
    }
  }

  /**
   * Workerのタスク完了ハンドラー
   */
  private async handleWorkerTaskCompleted(
    workerId: string,
    event: WorkerEventData,
  ): Promise<void> {
    if (!event.taskId) return;
    const task = this.tasks.get(event.taskId);
    if (!task) return;

    task.status = TaskStatus.COMPLETED;
    task.completedAt = Date.now();
    task.result = event.result;

    this.state.completedTasks++;

    console.log(`✅ Task ${event.taskId} completed by worker ${workerId}`);
  }

  /**
   * Workerのタスク失敗ハンドラー
   */
  private async handleWorkerTaskFailed(
    workerId: string,
    event: WorkerEventData,
  ): Promise<void> {
    if (!event.taskId) return;
    const task = this.tasks.get(event.taskId);
    if (!task) return;

    task.error = event.error;

    // リトライ回数を追跡（maxRetries: 3）
    const maxRetries = 3;
    task.retryCount = (task.retryCount || 0) + 1;

    console.error(
      `❌ Task ${event.taskId} failed on worker ${workerId} (attempt ${task.retryCount}/${maxRetries}):`,
      event.error,
    );

    if (task.retryCount < maxRetries) {
      // リトライ可能：キューに戻す
      task.status = TaskStatus.PENDING;
      delete task.assignedWorkerId;
      delete task.startedAt;
      this.taskQueue.push(task);
      console.log(`🔄 Task ${event.taskId} queued for retry`);
    } else {
      // リトライ上限到達：最終的に失敗とする
      task.status = TaskStatus.FAILED;
      task.completedAt = Date.now();
      this.state.failedTasks++;
      console.error(
        `💀 Task ${event.taskId} permanently failed after ${maxRetries} attempts`,
      );
    }
  }

  /**
   * Workerのハートビートハンドラー
   */
  private async handleWorkerHeartbeat(
    workerId: string,
    _event: WorkerEventData,
  ): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    worker.updateHeartbeat();
  }

  /**
   * Coordinatorの状態を取得
   */
  getState(): CoordinatorState {
    return {
      ...this.state,
      workers: Array.from(this.workers.values()).map((w) => w.getState()),
      tasks: this.getAllTasks(),
    };
  }

  /**
   * Worker一覧を取得
   */
  getWorkers(): WorkerState[] {
    return Array.from(this.workers.values()).map((w) => w.getState());
  }

  /**
   * 統計情報を取得
   */
  getStatistics() {
    return {
      totalWorkers: this.workers.size,
      idleWorkers: Array.from(this.workers.values()).filter(
        (w) => w.getState().status === "idle",
      ).length,
      busyWorkers: Array.from(this.workers.values()).filter(
        (w) => w.getState().status === "busy",
      ).length,
      totalTasks: this.state.totalTasks,
      completedTasks: this.state.completedTasks,
      failedTasks: this.state.failedTasks,
      pendingTasks: this.taskQueue.length,
    };
  }
}

/**
 * Workerエージェント
 *
 * 従属エージェントとしてタスクを実行
 */
export class WorkerAgent {
  private id: string;
  private llmProvider: ILLMProvider;
  private memorySystem: MemorySystem;
  private state: WorkerState;
  private eventListeners: Map<string, ((data: WorkerEventData) => void)[]> =
    new Map();
  private currentTask?: AgentTask;

  constructor(
    id: string,
    llmProvider: ILLMProvider,
    memorySystem: MemorySystem,
  ) {
    this.id = id;
    this.llmProvider = llmProvider;
    this.memorySystem = memorySystem;
    this.state = {
      id,
      status: "idle",
      lastHeartbeat: Date.now(),
      tasksCompleted: 0,
      tasksFailed: 0,
    };
  }

  /**
   * Workerの初期化
   */
  async initialize(): Promise<void> {
    console.log(`🤖 Initializing worker: ${this.id}`);
  }

  /**
   * Workerの開始
   */
  async start(): Promise<void> {
    if (this.state.status === "busy") {
      throw new Error(`Worker ${this.id} is already busy`);
    }

    this.state.status = "idle";
    console.log(`✅ Worker ${this.id} started`);
  }

  /**
   * Workerの停止
   */
  async stop(): Promise<void> {
    this.state.status = "offline";
    console.log(`🛑 Worker ${this.id} stopped`);
  }

  /**
   * タスクの割り当て
   */
  async assignTask(task: AgentTask): Promise<void> {
    if (this.state.status !== "idle") {
      throw new Error(`Worker ${this.id} is not idle`);
    }

    this.currentTask = task;
    this.state.status = "busy";
    this.state.currentTask = task.id;

    task.status = TaskStatus.IN_PROGRESS;
    task.startedAt = Date.now();

    console.log(`📋 Worker ${this.id} assigned task: ${task.id}`);

    // タスクを実行
    await this.executeTask(task);
  }

  /**
   * タスクの実行
   */
  private async executeTask(task: AgentTask): Promise<void> {
    try {
      console.log(`🔧 Worker ${this.id} executing task: ${task.description}`);

      // LLMを使用してタスクを実行
      const prompt = [
        "You are a specialized worker agent.",
        "Task: " + task.description,
        "Execute this task efficiently and return the result.",
        "Format your response as JSON:",
        "{",
        '  "success": true/false,',
        '  "result": "your execution result",',
        '  "error": "error message if failed"',
        "}",
      ].join("\n");

      const response = await this.llmProvider.generateResponse(prompt, {
        temperature: 0.7,
        maxTokens: 500,
      });

      // レスポンスをパース
      let result;
      try {
        result = JSON.parse(response);
      } catch {
        // JSONパース失敗時はレスポンスをそのまま使用
        result = {
          success: true,
          result: response,
          error: undefined,
        };
      }

      if (result.success) {
        this.state.tasksCompleted++;
        this.emitEvent("task_completed", {
          taskId: task.id,
          result: result.result,
        });
      } else {
        throw new Error(result.error || "Task execution failed");
      }
    } catch (error) {
      this.state.tasksFailed++;
      this.emitEvent("task_failed", {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.currentTask = undefined;
      this.state.currentTask = undefined;
      this.state.status = "idle";
      this.updateHeartbeat();
    }
  }

  /**
   * タスクタイムアウトの通知
   */
  async notifyTaskTimeout(taskId: string): Promise<void> {
    console.warn(`⚠️ Worker ${this.id} notified of task timeout: ${taskId}`);

    // 現在のタスクを中断
    if (this.currentTask && this.currentTask.id === taskId) {
      // タスクの中断処理
      this.state.tasksFailed++;
      this.emitEvent("task_failed", {
        taskId,
        error: "Task timed out",
      });

      this.currentTask = undefined;
      this.state.currentTask = undefined;
      this.state.status = "idle";
    }
  }

  /**
   * ハートビートの更新
   */
  updateHeartbeat(): void {
    this.state.lastHeartbeat = Date.now();
  }

  /**
   * 状態を取得
   */
  getState(): WorkerState {
    return { ...this.state };
  }

  /**
   * IDを取得
   */
  getId(): string {
    return this.id;
  }

  /**
   * イベントリスナーの登録
   */
  on(event: string, listener: (data: WorkerEventData) => void): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push(listener);
  }

  /**
   * イベントの発行
   */
  private emitEvent(event: string, data: WorkerEventData): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(data);
        } catch (error) {
          console.error(`Error in event listener for ${event}:`, error);
        }
      }
    }
  }
}
