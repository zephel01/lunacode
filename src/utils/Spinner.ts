/**
 * シンプルなターミナルスピナー
 * 外部ライブラリに依存しない実装
 */

export class Spinner {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private currentFrame = 0;
  private intervalId: NodeJS.Timeout | null = null;
  private message = "";
  private isRunning = false;

  /**
   * スピナーを開始
   */
  start(message: string = ""): void {
    if (this.isRunning) return;

    this.message = message;
    this.isRunning = true;
    this.currentFrame = 0;

    this.intervalId = setInterval(() => {
      this.render();
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
    }, 80);
  }

  /**
   * スピナーを停止
   */
  stop(finalMessage?: string): void {
    if (!this.isRunning) return;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isRunning = false;

    // 最後のメッセージを表示
    if (finalMessage) {
      console.log(`\r\x1b[K${finalMessage}`);
    } else {
      console.log("\r\x1b[K"); // 行をクリア
    }
  }

  /**
   * メッセージを更新
   */
  update(message: string): void {
    this.message = message;
  }

  /**
   * フレームをレンダリング
   */
  private render(): void {
    const frame = this.frames[this.currentFrame];
    const text = `${frame} ${this.message}`;
    process.stdout.write(`\r\x1b[K${text}`);
  }

  /**
   * 成功メッセージで停止
   */
  succeed(message: string = ""): void {
    this.stop(`✅ ${message || this.message}`);
  }

  /**
   * エラーメッセージで停止
   */
  fail(message: string = ""): void {
    this.stop(`❌ ${message || this.message}`);
  }

  /**
   * 警告メッセージで停止
   */
  warn(message: string = ""): void {
    this.stop(`⚠️  ${message || this.message}`);
  }

  /**
   * 情報メッセージで停止
   */
  info(message: string = ""): void {
    this.stop(`ℹ️  ${message || this.message}`);
  }
}

/**
 * グローバルスピナーインスタンス
 */
export const globalSpinner = new Spinner();

/**
 * 簡易的なローディング表示（非同期処理用）
 */
export async function withSpinner<T>(
  promise: Promise<T>,
  message: string = "処理中...",
): Promise<T> {
  const spinner = new Spinner();
  spinner.start(message);

  try {
    const result = await promise;
    spinner.succeed();
    return result;
  } catch (error) {
    spinner.fail();
    throw error;
  }
}

/**
 * プログレスバー表示（複数ステップ用）
 */
export function showProgress(
  current: number,
  total: number,
  label: string = "",
): void {
  const percentage = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * 20);
  const empty = 20 - filled;

  const bar = "█".repeat(filled) + "░".repeat(empty);
  const text = `[${bar}] ${percentage}% ${label}`;

  process.stdout.write(`\r\x1b[K${text}`);

  if (current === total) {
    console.log(""); // 改行
  }
}
