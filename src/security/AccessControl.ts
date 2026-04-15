import * as crypto from "crypto";

/**
 * ユーザーロール
 */
export enum UserRole {
  ADMIN = "admin",
  USER = "user",
  GUEST = "guest",
}

/**
 * アクションタイプ
 */
export enum ActionType {
  READ = "read",
  WRITE = "write",
  EXECUTE = "execute",
  DELETE = "delete",
  SYSTEM = "system",
}

/**
 * アクセス権限
 */
export interface Permission {
  role: UserRole;
  actions: ActionType[];
  paths?: string[]; // 許可されたパス（globパターン）
}

/**
 * アクセスポリシー
 */
export interface AccessPolicy {
  id: string;
  name: string;
  permissions: Permission[];
  enabled: boolean;
}

/**
 * ユーザー情報
 */
export interface User {
  id: string;
  username: string;
  role: UserRole;
  permissions: string[];
  createdAt: number;
  lastLogin?: number;
}

/**
 * 認証情報
 */
export interface AuthToken {
  token: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
}

/**
 * アクセス制御マネージャー
 *
 * Phase 4.2: セキュリティ強化
 * - アクセス制御
 * - 認証システム
 * - 監査ログ拡張
 */
export class AccessControlManager {
  private users: Map<string, User> = new Map();
  private passwordHashes: Map<string, string> = new Map(); // userId -> hash
  private policies: Map<string, AccessPolicy> = new Map();
  private tokens: Map<string, AuthToken> = new Map();
  private auditLog: AuditLog;
  private secretKey: string;

  constructor(secretKey?: string) {
    this.secretKey = secretKey || this.generateSecretKey();
    this.auditLog = new AuditLog();
  }

  /**
   * 初期化
   */
  async initialize(): Promise<void> {
    console.log("🔐 Initializing Access Control Manager...");

    // デフォルトのポリシーを作成
    await this.createDefaultPolicies();

    // デフォルトの管理者ユーザーを作成
    await this.createDefaultAdmin();

    console.log("✅ Access Control Manager initialized");
  }

  /**
   * ユーザー作成
   */
  async createUser(
    username: string,
    role: UserRole,
    password?: string,
  ): Promise<User> {
    const userId = `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const user: User = {
      id: userId,
      username,
      role,
      permissions: [],
      createdAt: Date.now(),
    };

    // パスワードが提供された場合、ハッシュ化して保存
    if (password) {
      const passwordHash = this.hashPassword(password);
      this.passwordHashes.set(userId, passwordHash);
    }

    this.users.set(userId, user);

    // 監査ログに記録
    this.auditLog.log({
      action: "user_created",
      userId,
      username,
      timestamp: Date.now(),
      metadata: { role },
    });

    console.log(`✅ Created user: ${username} (${role})`);

    return user;
  }

  /**
   * ユーザー認証
   */
  async authenticate(
    username: string,
    password: string,
  ): Promise<AuthToken | null> {
    const user = Array.from(this.users.values()).find(
      (u) => u.username === username,
    );

    if (!user) {
      this.auditLog.log({
        action: "auth_failed",
        username,
        reason: "User not found",
        timestamp: Date.now(),
      });
      return null;
    }

    // パスワード検証
    const storedHash = this.passwordHashes.get(user.id);
    if (!storedHash) {
      this.auditLog.log({
        action: "auth_failed",
        userId: user.id,
        username,
        reason: "No password set for user",
        timestamp: Date.now(),
      });
      return null;
    }
    const isValid = storedHash === this.hashPassword(password);

    if (!isValid) {
      this.auditLog.log({
        action: "auth_failed",
        userId: user.id,
        username,
        reason: "Invalid password",
        timestamp: Date.now(),
      });
      return null;
    }

    // 認証トークンを作成
    const token = this.generateToken(user.id);

    // ユーザーの最終ログインを更新
    user.lastLogin = Date.now();

    this.auditLog.log({
      action: "auth_success",
      userId: user.id,
      username,
      timestamp: Date.now(),
      metadata: { token: token.token.substring(0, 16) + "..." },
    });

    console.log(`✅ User authenticated: ${username}`);

    return token;
  }

  /**
   * トークン検証
   */
  verifyToken(tokenString: string): boolean {
    const token = this.tokens.get(tokenString);

    if (!token) {
      return false;
    }

    // トークンの有効期限をチェック
    if (Date.now() > token.expiresAt) {
      this.tokens.delete(tokenString);
      return false;
    }

    return true;
  }

  /**
   * ユーザー権限のチェック
   */
  checkPermission(userId: string, action: ActionType, path: string): boolean {
    const user = this.users.get(userId);

    if (!user) {
      return false;
    }

    // ユーザーのロールに基づいて権限をチェック
    for (const policy of this.policies.values()) {
      if (!policy.enabled) continue;

      for (const permission of policy.permissions) {
        // ロールがマッチするか確認
        if (permission.role !== user.role) continue;

        // アクションがマッチするか確認
        if (!permission.actions.includes(action)) continue;

        // パスがマッチするか確認
        if (permission.paths && permission.paths.length > 0) {
          const pathMatches = permission.paths.some((pattern) =>
            this.matchPathPattern(path, pattern),
          );

          if (!pathMatches) continue;
        }

        return true;
      }
    }

    return false;
  }

  /**
   * アクセスポリシーの作成
   */
  async createPolicy(
    name: string,
    permissions: Permission[],
  ): Promise<AccessPolicy> {
    const policyId = `policy-${Date.now()}`;

    const policy: AccessPolicy = {
      id: policyId,
      name,
      permissions,
      enabled: true,
    };

    this.policies.set(policyId, policy);

    this.auditLog.log({
      action: "policy_created",
      policyId,
      timestamp: Date.now(),
      metadata: { name, permissions: permissions.length },
    });

    console.log(`✅ Created policy: ${name}`);

    return policy;
  }

  /**
   * アクセスポリシーの更新
   */
  async updatePolicy(
    policyId: string,
    updates: Partial<AccessPolicy>,
  ): Promise<void> {
    const policy = this.policies.get(policyId);

    if (!policy) {
      throw new Error(`Policy ${policyId} not found`);
    }

    const updatedPolicy = { ...policy, ...updates };
    this.policies.set(policyId, updatedPolicy);

    this.auditLog.log({
      action: "policy_updated",
      policyId,
      timestamp: Date.now(),
      metadata: { updates: Object.keys(updates) },
    });
  }

  /**
   * ポリシーの削除
   */
  async deletePolicy(policyId: string): Promise<void> {
    if (!this.policies.delete(policyId)) {
      throw new Error(`Policy ${policyId} not found`);
    }

    this.auditLog.log({
      action: "policy_deleted",
      policyId,
      timestamp: Date.now(),
    });
  }

  /**
   * すべてのユーザーを取得
   */
  getUsers(): User[] {
    return Array.from(this.users.values());
  }

  /**
   * すべてのポリシーを取得
   */
  getPolicies(): AccessPolicy[] {
    return Array.from(this.policies.values());
  }

  /**
   * 監査ログを取得
   */
  getAuditLog(limit: number = 100): AuditEntry[] {
    return this.auditLog.getRecentEntries(limit);
  }

  /**
   * デフォルトのポリシーを作成
   */
  private async createDefaultPolicies(): Promise<void> {
    // 管理者ポリシー
    await this.createPolicy("Admin Policy", [
      {
        role: UserRole.ADMIN,
        actions: [
          ActionType.READ,
          ActionType.WRITE,
          ActionType.EXECUTE,
          ActionType.DELETE,
          ActionType.SYSTEM,
        ],
      },
    ]);

    // ユーザーポリシー
    await this.createPolicy("User Policy", [
      {
        role: UserRole.USER,
        actions: [ActionType.READ, ActionType.WRITE, ActionType.EXECUTE],
      },
    ]);

    // ゲストポリシー
    await this.createPolicy("Guest Policy", [
      {
        role: UserRole.GUEST,
        actions: [ActionType.READ],
        paths: ["/README.md", "/docs/"],
      },
    ]);
  }

  /**
   * デフォルトの管理者を作成
   */
  private async createDefaultAdmin(): Promise<void> {
    const adminExists = Array.from(this.users.values()).some(
      (u) => u.role === UserRole.ADMIN,
    );

    if (!adminExists) {
      const adminUser = process.env.LUNACODE_ADMIN_USER || "admin";
      const adminPassword =
        process.env.LUNACODE_ADMIN_PASSWORD ||
        crypto.randomBytes(16).toString("hex");

      await this.createUser(adminUser, UserRole.ADMIN, adminPassword);

      if (!process.env.LUNACODE_ADMIN_PASSWORD) {
        console.log(
          `⚠️ Default admin user created. Username: ${adminUser}, Password: ${adminPassword}`,
        );
        console.log(
          "   Set LUNACODE_ADMIN_USER and LUNACODE_ADMIN_PASSWORD environment variables to customize.",
        );
      } else {
        console.log(
          `✅ Admin user '${adminUser}' created from environment variables.`,
        );
      }
    }
  }

  /**
   * トークン生成
   */
  private generateToken(userId: string): AuthToken {
    const tokenString = `${userId}:${Date.now()}:${Math.random().toString(36)}`;
    const token = crypto
      .createHash("sha256")
      .update(tokenString + this.secretKey)
      .digest("hex");

    const authToken: AuthToken = {
      token,
      userId,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24時間有効
      createdAt: Date.now(),
    };

    this.tokens.set(token, authToken);

    return authToken;
  }

  /**
   * パスワードハッシュ化（scrypt）
   */
  private hashPassword(password: string): string {
    // scrypt: N=16384, r=8, p=1, keylen=64
    const salt = this.secretKey;
    return crypto.scryptSync(password, salt, 64).toString("hex");
  }

  /**
   * シークレットキー生成
   */
  private generateSecretKey(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  /**
   * パスパターンマッチング
   */
  private matchPathPattern(path: string, pattern: string): boolean {
    // 簡易的なglobパターンマッチング
    const regexPattern = pattern.replace(/\*/g, ".*").replace(/\?/g, ".");
    const regex = new RegExp(`^${regexPattern}$`);

    return regex.test(path);
  }

  /**
   * トークンを削除
   */
  revokeToken(token: string): void {
    this.tokens.delete(token);
  }

  /**
   * 期限切れトークンをクリーンアップ
   */
  cleanupExpiredTokens(): number {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [token, authToken] of this.tokens.entries()) {
      if (now > authToken.expiresAt) {
        this.tokens.delete(token);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned up ${cleanedCount} expired tokens`);
    }

    return cleanedCount;
  }
}

/**
 * 監査ログエントリー
 */
export interface AuditEntry {
  id: string;
  action: string;
  userId?: string;
  username?: string;
  policyId?: string;
  path?: string;
  reason?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * 監査ログ
 *
 * 詳細な監査機能の実装
 */
export class AuditLog {
  private entries: AuditEntry[] = [];
  private maxSize: number = 10000; // 最大10000件

  /**
   * ログを記録
   */
  log(entry: Partial<AuditEntry>): void {
    const auditEntry: AuditEntry = {
      id: `audit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      action: entry.action || "unknown",
      timestamp: Date.now(),
      userId: entry.userId,
      username: entry.username,
      policyId: entry.policyId,
      path: entry.path,
      reason: entry.reason,
      metadata: entry.metadata,
    };

    this.entries.push(auditEntry);

    // 最大サイズを超えた場合、古いエントリーを削除
    if (this.entries.length > this.maxSize) {
      this.entries.shift();
    }
  }

  /**
   * 最近のエントリーを取得
   */
  getRecentEntries(limit: number = 100): AuditEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  /**
   * フィルタリングされたエントリーを取得
   */
  filterByAction(action: string): AuditEntry[] {
    return this.entries.filter((e) => e.action === action);
  }

  /**
   * ユーザーごとのエントリーを取得
   */
  getByUserId(userId: string): AuditEntry[] {
    return this.entries.filter((e) => e.userId === userId);
  }

  /**
   * 期間ごとのエントリーを取得
   */
  getByTimeRange(startTime: number, endTime: number): AuditEntry[] {
    return this.entries.filter(
      (e) => e.timestamp >= startTime && e.timestamp <= endTime,
    );
  }

  /**
   * エントリーをエクスポート
   */
  export(format: "json" | "csv" = "json"): string {
    if (format === "json") {
      return JSON.stringify(this.entries, null, 2);
    } else if (format === "csv") {
      const headers =
        "ID,Action,UserID,Username,PolicyID,Path,Reason,Timestamp,Metadata\n";
      const rows = this.entries
        .map((e) =>
          [
            e.id,
            e.action,
            e.userId || "",
            e.username || "",
            e.policyId || "",
            e.path || "",
            e.reason || "",
            e.timestamp,
            JSON.stringify(e.metadata || {}),
          ].join(","),
        )
        .join("\n");

      return headers + rows;
    }

    return "";
  }

  /**
   * ログをクリア
   */
  clear(): void {
    this.entries = [];
    console.log("🧹 Audit log cleared");
  }

  /**
   * エントリー数を取得
   */
  size(): number {
    return this.entries.length;
  }
}
