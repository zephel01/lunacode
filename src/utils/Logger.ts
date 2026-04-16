import pino from "pino";

// ── 型定義 ──────────────────────────────────────────────────────────────────

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface LoggingConfig {
  /** ログレベル（デフォルト: "info"） */
  level?: LogLevel;
  /** JSON 構造化出力を有効にする（デフォルト: false → 人間向けカラー出力） */
  json?: boolean;
  /** ファイル出力先パス（省略時は stdout のみ） */
  file?: string;
}

// ── Logger クラス ───────────────────────────────────────────────────────────

/**
 * pino ベースの構造化ロガー。
 * - 開発時: pino-pretty による人間向けカラー出力（従来の console.log 互換）
 * - プロダクション / CI: JSON 構造化出力
 *
 * 使い方:
 *   const log = Logger.get("AgentLoop");
 *   log.info({ iteration: 3 }, "ReAct loop started");
 *   log.debug({ tool: "bash", args: { cmd: "ls" } }, "Executing tool");
 */
export class Logger {
  private static root: pino.Logger | null = null;
  private static config: LoggingConfig = {};
  private static configured: boolean = false;

  /**
   * グローバル設定を適用してルートロガーを（再）作成する。
   * AgentLoop.initialize() などアプリ起動時に 1 回呼ぶ。
   */
  static configure(config: LoggingConfig = {}): void {
    Logger.config = config;
    Logger.configured = true;

    const level = config.level ?? "info";
    const useJson = config.json ?? false;

    const targets: pino.TransportTargetOptions[] = [];

    if (useJson) {
      // JSON 構造化出力（stdout）
      targets.push({
        target: "pino/file",
        options: { destination: 1 }, // stdout
        level,
      });
    } else {
      // 人間向けカラー出力（pino-pretty）
      targets.push({
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname",
          messageFormat: "{msg}",
        },
        level,
      });
    }

    // ファイル出力（オプション）
    if (config.file) {
      targets.push({
        target: "pino/file",
        options: { destination: config.file, mkdir: true },
        level,
      });
    }

    Logger.root = pino({
      level,
      transport: { targets },
    });
  }

  /**
   * 名前付き子ロガーを取得する。
   * configure() 未呼び出しの場合はデフォルト設定で自動初期化。
   */
  static get(name: string): pino.Logger {
    if (!Logger.root) {
      Logger.configure(Logger.config);
    }
    return Logger.root!.child({ component: name });
  }

  /**
   * ルートロガーを直接取得（子ロガーなし）
   */
  static getRoot(): pino.Logger {
    if (!Logger.root) {
      Logger.configure(Logger.config);
    }
    return Logger.root!;
  }

  /**
   * 現在の設定を返す
   */
  static getConfig(): LoggingConfig {
    return { ...Logger.config };
  }

  /**
   * CLI などが事前に configure() を呼んだかどうか
   */
  static isConfigured(): boolean {
    return Logger.configured;
  }

  /**
   * テスト用: ルートロガーをリセット
   */
  static reset(): void {
    Logger.root = null;
    Logger.config = {};
    Logger.configured = false;
  }
}
