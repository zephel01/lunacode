import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { KAIROSDaemon } from "../src/daemon/KAIROSDaemon.js";
import { AutoDream } from "../src/daemon/AutoDream.js";
import { MemorySystem } from "../src/memory/MemorySystem.js";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";

describe("KAIROSDaemon", () => {
  let daemon: KAIROSDaemon;
  let memorySystem: MemorySystem;
  let testPath: string;

  beforeEach(async () => {
    testPath = await fs.mkdtemp(path.join(os.tmpdir(), "test-kairos-"));

    memorySystem = new MemorySystem(testPath);
    await memorySystem.initialize();

    const provider = null; // テストではプロバイダーを使わない
    daemon = new KAIROSDaemon(testPath, memorySystem, provider);
    await daemon.initialize();
  });

  afterEach(async () => {
    // デーモンを停止
    try {
      await daemon.stop();
    } catch {
      // エラーは無視
    }

    // テストディレクトリのクリーンアップ
    await fs.rm(testPath, { recursive: true, force: true });
  });

  describe("初期化", () => {
    it("初期化できること", async () => {
      const state = daemon.getState();
      expect(state.isRunning).toBe(false);
      expect(state.uptimeSeconds).toBe(0);
    });

    it("PIDファイルが作成されること", async () => {
      await daemon.start();

      const pidPath = path.join(testPath, ".kairos", "daemon.pid");
      const exists = await fs
        .access(pidPath)
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(true);

      await daemon.stop();
    });

    it("AutoDreamが初期化されること", () => {
      const autoDream = (daemon as any).autoDream;
      expect(autoDream).toBeDefined();
      expect(autoDream instanceof AutoDream).toBe(true);
    });
  });

  describe("デーモン起動・停止", () => {
    it("デーモンを起動できること", async () => {
      await daemon.start();

      const state = daemon.getState();
      expect(state.isRunning).toBe(true);
      expect(state.pid).toBeGreaterThan(0);
    });

    it("デーモンを停止できること", async () => {
      await daemon.start();
      await daemon.stop();

      const state = daemon.getState();
      expect(state.isRunning).toBe(false);
    });

    it("すでに動いているデーモンを起動できないこと", async () => {
      await daemon.start();

      await expect(daemon.start()).rejects.toThrow("already running");
    });
  });

  describe("Tickシステム", () => {
    it("Tickタスクを登録できること", () => {
      const taskAdded = (event: any) => {
        expect(event.type).toBe("tick");
      };

      daemon.on("tick" as any, taskAdded);
    });

    it("プロアクティブ条件を評価できること", async () => {
      await daemon.start();

      // テスト用のプロアクティブ条件
      daemon.updateProactiveConditions([
        {
          type: "idle_time" as any,
          enabled: true,
          threshold: 0, // 即トリガー
        },
      ]);

      // 時間を待ってTickが実行されるのを待機
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // テスト後にデーモンを停止
      await daemon.stop();
    });

    it("ヘルスチェックが動作すること", async () => {
      await daemon.start();

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const state = daemon.getState();
      expect(state.tickCount).toBeGreaterThan(0);

      await daemon.stop();
    });
  });

  describe("イベントシステム", () => {
    it("イベントを発行できること", () => {
      let eventReceived = false;

      const listener = (event: any) => {
        if (event.type === "test_event") {
          eventReceived = true;
        }
      };

      daemon.on("test_event" as any, listener);

      // イベントの発行（テスト用）
      daemon.emit({
        type: "test_event" as any,
        timestamp: Date.now(),
        data: {},
      });

      expect(eventReceived).toBe(true);
    });

    it("イベントリスナーを削除できること", () => {
      const listener = () => {};

      daemon.on("test_event" as any, listener);
      daemon.off("test_event" as any, listener);
    });
  });

  describe("通知", () => {
    it("通知設定を更新できること", async () => {
      const initialSettings = (daemon as any).notificationConfig;

      daemon.updateNotificationSettings({
        enabled: true,
        channels: ["console" as any],
        priority: "high",
      });

      const updatedSettings = (daemon as any).notificationConfig;

      expect(updatedSettings.enabled).toBe(true);
      expect(updatedSettings.channels).toContain("console");
      expect(updatedSettings.priority).toBe("high");
    });

    it("静止時間の設定ができること", async () => {
      daemon.updateNotificationSettings({
        enabled: true,
        channels: ["console" as any],
        priority: "medium",
        quietHours: {
          start: "22:00",
          end: "06:00",
        },
      });

      const settings = (daemon as any).notificationConfig;

      expect(settings.quietHours).toBeDefined();
      expect(settings.quietHours.start).toBe("22:00");
      expect(settings.quietHours.end).toBe("06:00");
    });
  });

  describe("設定管理", () => {
    it("夢設定を更新できること", () => {
      const initialSettings = (daemon as any).dreamSettings;

      daemon.updateDreamSettings({
        idleThresholdMinutes: 120,
        maxDurationMinutes: 60,
      });

      const updatedSettings = (daemon as any).dreamSettings;

      expect(updatedSettings.idleThresholdMinutes).toBe(120);
      expect(updatedSettings.maxDurationMinutes).toBe(60);
      expect(updatedSettings.autoTrigger).toBe(initialSettings.autoTrigger);
    });

    it("プロアクティブ条件を更新できること", () => {
      const initialConditions = (daemon as any).proactiveConditions;

      daemon.updateProactiveConditions([
        {
          type: "idle_time" as any,
          enabled: false,
        },
      ]);

      expect((daemon as any).proactiveConditions[0].enabled).toBe(false);
      expect((daemon as any).proactiveConditions[0].type).toBe("idle_time");
    });
  });

  describe("AutoDream機能", () => {
    it("AutoDreamが初期化できること", async () => {
      const autoDream = (daemon as any).autoDream;
      expect(autoDream).toBeDefined();

      const state = autoDream.getState();
      expect(state.isRunning).toBe(false);
    });

    it("ドリーム履歴が取得できること", async () => {
      const autoDream = (daemon as any).autoDream;
      const history = await autoDream.getDreamHistory();

      expect(history).toBeDefined();
      expect(Array.isArray(history)).toBe(true);
    });

    it("ドリーム状態が取得できること", () => {
      const autoDream = (daemon as any).autoDream;
      const state = autoDream.getState();

      expect(state).toBeDefined();
      expect(state.isRunning).toBe(false);
      expect(state.startTime).toBe(0);
    });
  });

  describe("ヘルスチェック", () => {
    it("ヘルスチェックが正常に動作すること", async () => {
      await daemon.start();

      // テスト用のヘルスチェックタスク
      const result = {
        shouldAct: true,
        actionType: "notification" as any,
        reason: "Health check passed",
      };

      const state = daemon.getState();

      expect(state.isRunning).toBe(true);
      expect(state.tickCount).toBeGreaterThan(0);

      await daemon.stop();
    });
  });
});

describe("AutoDream", () => {
  let autoDream: AutoDream;
  let memorySystem: MemorySystem;
  let testPath: string;

  beforeEach(async () => {
    testPath = await fs.mkdtemp(path.join(os.tmpdir(), "test-autodream-"));

    memorySystem = new MemorySystem(testPath);
    await memorySystem.initialize();

    autoDream = new AutoDream(testPath, memorySystem);
    await autoDream.initialize();
  });

  afterEach(async () => {
    // テストディレクトリのクリーンアップ
    await fs.rm(testPath, { recursive: true, force: true });
  });

  describe("初期化", () => {
    it("初期化できること", () => {
      const state = autoDream.getState();
      expect(state.isRunning).toBe(false);
      expect(state.startTime).toBe(0);
    });

    it("ドリーム履歴が空であること", async () => {
      const history = await autoDream.getDreamHistory();
      expect(history).toBeDefined();
      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBe(0);
    });
  });

  describe("ドリーム状態管理", () => {
    it("ドリーム状態が取得できること", () => {
      const state = autoDream.getState();

      expect(state).toBeDefined();
      expect(state.isRunning).toBe(false);
      expect(state.memoryConsolidated).toBe(false);
      expect(state.contradictionsResolved).toBe(0);
      expect(state.insightsExtracted).toBe(0);
    });

    it("ドリーム履歴が取得できること", async () => {
      const history = await autoDream.getDreamHistory(5);

      expect(history).toBeDefined();
      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBeLessThanOrEqual(5);
    });
  });
});
