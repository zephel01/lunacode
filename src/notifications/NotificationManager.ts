/**
 * 通知チャンネル
 */
export enum NotificationChannel {
  CONSOLE = "console",
  OS = "os",
  PUSHOVER = "pushover",
  TELEGRAM = "telegram",
}

/**
 * 通知優先度
 */
export enum NotificationPriority {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
  URGENT = "urgent",
}

/**
 * 通知メッセージ
 */
export interface NotificationMessage {
  title: string;
  message: string;
  priority: NotificationPriority;
  channel?: NotificationChannel;
  timestamp?: number;
}

/**
 * 通知設定
 */
export interface NotificationSettings {
  enabled: boolean;
  channels: NotificationChannel[];
  priority: NotificationPriority;
  quietHours?: {
    start: string; // HH:MM format
    end: string; // HH:MM format
  };
  filters?: {
    minPriority: NotificationPriority;
    patterns?: string[]; // メッセージに含まれるパターン
  };
}

/**
 * Push通知設定
 */
export interface PushNotificationConfig {
  pushover?: {
    userKey: string;
    apiToken: string;
  };
  telegram?: {
    botToken: string;
    chatId: string;
  };
}

/**
 * 通知マネージャー
 *
 * Phase 3.2: 通知システム
 * - OS通知実装
 * - Push通知実装
 * - 通知設定管理
 * - 通知キュー
 */
export class NotificationManager {
  private settings: NotificationSettings;
  private pushConfig: PushNotificationConfig;
  private notificationQueue: NotificationMessage[] = [];
  private isProcessingQueue: boolean = false;

  constructor(
    settings?: Partial<NotificationSettings>,
    pushConfig?: PushNotificationConfig,
  ) {
    this.settings = {
      enabled: true,
      channels: [NotificationChannel.CONSOLE],
      priority: NotificationPriority.MEDIUM,
      ...settings,
    };

    this.pushConfig = pushConfig || {};
  }

  /**
   * 通知を送信
   */
  async send(message: NotificationMessage): Promise<void> {
    if (!this.settings.enabled) {
      return;
    }

    // 静止時間のチェック
    if (this.isQuietHours()) {
      console.log("🔇 Quiet hours, notification suppressed");
      return;
    }

    // フィルタリング
    if (!this.shouldSend(message)) {
      return;
    }

    // タイムスタンプの設定
    message.timestamp = message.timestamp || Date.now();

    // チャンネルごとに送信
    const channels = message.channel
      ? [message.channel]
      : this.settings.channels;

    for (const channel of channels) {
      await this.sendToChannel(message, channel);
    }
  }

  /**
   * チャンネルに送信
   */
  private async sendToChannel(
    message: NotificationMessage,
    channel: NotificationChannel,
  ): Promise<void> {
    switch (channel) {
      case NotificationChannel.CONSOLE:
        this.sendToConsole(message);
        break;
      case NotificationChannel.OS:
        await this.sendToOS(message);
        break;
      case NotificationChannel.PUSHOVER:
        await this.sendToPushover(message);
        break;
      case NotificationChannel.TELEGRAM:
        await this.sendToTelegram(message);
        break;
    }
  }

  /**
   * コンソールに送信
   */
  private sendToConsole(message: NotificationMessage): void {
    const priorityEmoji = this.getPriorityEmoji(message.priority);

    console.log(
      `\n${priorityEmoji} [${message.priority.toUpperCase()}] ${message.title}`,
    );
    console.log(`📝 ${message.message}\n`);
  }

  /**
   * OS通知に送信
   */
  private async sendToOS(message: NotificationMessage): Promise<void> {
    try {
      // Node.jsの`process.platform`をチェックして、プラットフォームに適した通知を送信
      const platform = process.platform;

      switch (platform) {
        case "darwin":
          await this.sendMacOSNotification(message);
          break;
        case "linux":
          await this.sendLinuxNotification(message);
          break;
        case "win32":
          await this.sendWindowsNotification(message);
          break;
        default:
          console.log(`Unsupported platform for OS notifications: ${platform}`);
      }
    } catch (error) {
      console.error("Failed to send OS notification:", error);
    }
  }

  /**
   * 文字列をサニタイズ（コマンドインジェクション対策）
   */
  private sanitizeForShell(input: string): string {
    // シングルクォート、ダブルクォート、バックスラッシュ、特殊文字を除去
    return input.replace(/['"\\`$!;&|<>(){}[\]\n\r]/g, "");
  }

  /**
   * macOS通知
   */
  private async sendMacOSNotification(
    message: NotificationMessage,
  ): Promise<void> {
    try {
      const { execFile } = await import("child_process");

      const safeTitle = this.sanitizeForShell(message.title);
      const safeMessage = this.sanitizeForShell(message.message);

      const script = `display notification "${safeMessage}" with title "${safeTitle}" subtitle "LunaCode"`;

      // execFile + 引数配列方式でインジェクション対策
      execFile("osascript", ["-e", script], (error) => {
        if (error) {
          console.error("Failed to send macOS notification:", error);
        }
      });
    } catch (error) {
      console.error("Failed to send macOS notification:", error);
    }
  }

  /**
   * Linux通知（libnotify）
   */
  private async sendLinuxNotification(
    message: NotificationMessage,
  ): Promise<void> {
    try {
      const { execFile } = await import("child_process");

      // execFile + 引数配列方式でインジェクション対策
      execFile(
        "notify-send",
        [message.title, message.message, "--app-name=LunaCode"],
        (error) => {
          if (error) {
            console.error("Failed to send Linux notification:", error);
          }
        },
      );
    } catch (error) {
      console.error("Failed to send Linux notification:", error);
    }
  }

  /**
   * Windows通知
   */
  private async sendWindowsNotification(
    message: NotificationMessage,
  ): Promise<void> {
    try {
      const { execFile } = await import("child_process");

      const safeTitle = this.sanitizeForShell(message.title);
      const safeMessage = this.sanitizeForShell(message.message);

      const script = `
        Add-Type -AssemblyName System.Windows.Forms;
        $notify = New-Object System.Windows.Forms.NotifyIcon;
        $notify.Icon = [System.Drawing.SystemIcons]::Information;
        $notify.Visible = $true;
        $notify.ShowBalloonTip(5000, '${safeTitle}', '${safeMessage}', [System.Windows.Forms.ToolTipIcon]::Info);
      `;

      // execFile方式で実行
      execFile("powershell", ["-Command", script], (error) => {
        if (error) {
          console.error("Failed to send Windows notification:", error);
        }
      });
    } catch (error) {
      console.error("Failed to send Windows notification:", error);
    }
  }

  /**
   * Pushover通知
   */
  private async sendToPushover(message: NotificationMessage): Promise<void> {
    if (
      !this.pushConfig.pushover ||
      !this.pushConfig.pushover.userKey ||
      !this.pushConfig.pushover.apiToken
    ) {
      console.log("Pushover not configured, skipping");
      return;
    }

    try {
      const { default: fetch } = await import("node-fetch");

      const response = await fetch("https://api.pushover.net/1/messages.json", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user: this.pushConfig.pushover.userKey,
          token: this.pushConfig.pushover.apiToken,
          title: message.title,
          message: message.message,
          priority: this.getPushoverPriority(message.priority),
        }),
      });

      if (!response.ok) {
        console.error(
          "Failed to send Pushover notification:",
          await response.text(),
        );
      }
    } catch (error) {
      console.error("Failed to send Pushover notification:", error);
    }
  }

  /**
   * Telegram通知
   */
  private async sendToTelegram(message: NotificationMessage): Promise<void> {
    if (
      !this.pushConfig.telegram ||
      !this.pushConfig.telegram.botToken ||
      !this.pushConfig.telegram.chatId
    ) {
      console.log("Telegram not configured, skipping");
      return;
    }

    try {
      const { default: fetch } = await import("node-fetch");

      const url = `https://api.telegram.org/bot${this.pushConfig.telegram.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: this.pushConfig.telegram.chatId,
          text: `${message.title}\n\n${message.message}`,
          parse_mode: "Markdown",
        }),
      });

      if (!response.ok) {
        console.error(
          "Failed to send Telegram notification:",
          await response.text(),
        );
      }
    } catch (error) {
      console.error("Failed to send Telegram notification:", error);
    }
  }

  /**
   * 通知をキューに追加
   */
  queueNotification(message: NotificationMessage): void {
    this.notificationQueue.push(message);
    this.processQueue();
  }

  /**
   * キューを処理
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.notificationQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.notificationQueue.length > 0) {
      const message = this.notificationQueue.shift();
      if (message) {
        await this.send(message);
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * 静止時間のチェック
   */
  private isQuietHours(): boolean {
    if (!this.settings.quietHours) {
      return false;
    }

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const [startHour, startMin] = this.settings.quietHours.start
      .split(":")
      .map(Number);
    const [endHour, endMin] = this.settings.quietHours.end
      .split(":")
      .map(Number);

    const startMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;

    // 静止時間が夜中をまたぐ場合
    if (startMinutes > endMinutes) {
      return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
    }

    // 静止時間が一日の中
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }

  /**
   * 通知を送信するかどうかの判断
   */
  private shouldSend(message: NotificationMessage): boolean {
    // 優先度のチェック
    const priorityOrder = {
      [NotificationPriority.LOW]: 1,
      [NotificationPriority.MEDIUM]: 2,
      [NotificationPriority.HIGH]: 3,
      [NotificationPriority.URGENT]: 4,
    };

    const minPriority =
      this.settings.filters?.minPriority || NotificationPriority.LOW;

    if (priorityOrder[message.priority] < priorityOrder[minPriority]) {
      return false;
    }

    // パターンのチェック
    if (this.settings.filters?.patterns) {
      const content = `${message.title} ${message.message}`.toLowerCase();
      const shouldBlock = this.settings.filters.patterns.some((pattern) =>
        content.includes(pattern.toLowerCase()),
      );

      if (shouldBlock) {
        return false;
      }
    }

    return true;
  }

  /**
   * 優先度の絵文字を取得
   */
  private getPriorityEmoji(priority: NotificationPriority): string {
    const emojis = {
      [NotificationPriority.LOW]: "🔵",
      [NotificationPriority.MEDIUM]: "🟡",
      [NotificationPriority.HIGH]: "🟠",
      [NotificationPriority.URGENT]: "🔴",
    };

    return emojis[priority] || "🟡";
  }

  /**
   * Pushoverの優先度を取得
   */
  private getPushoverPriority(priority: NotificationPriority): number {
    const priorityMap = {
      [NotificationPriority.LOW]: -1,
      [NotificationPriority.MEDIUM]: 0,
      [NotificationPriority.HIGH]: 1,
      [NotificationPriority.URGENT]: 2,
    };

    return priorityMap[priority] || 0;
  }

  /**
   * 設定を更新
   */
  updateSettings(settings: Partial<NotificationSettings>): void {
    this.settings = { ...this.settings, ...settings };
  }

  /**
   * 設定を取得
   */
  getSettings(): NotificationSettings {
    return { ...this.settings };
  }

  /**
   * Push通知設定を更新
   */
  updatePushConfig(config: Partial<PushNotificationConfig>): void {
    this.pushConfig = { ...this.pushConfig, ...config };
  }

  /**
   * Push通知設定を取得
   */
  getPushConfig(): PushNotificationConfig {
    return { ...this.pushConfig };
  }

  /**
   * キューのサイズを取得
   */
  getQueueSize(): number {
    return this.notificationQueue.length;
  }

  /**
   * キューをクリア
   */
  clearQueue(): void {
    this.notificationQueue = [];
  }
}
