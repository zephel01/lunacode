/**
 * Sandbox Tier 1: 作業ツリー分離の型定義。
 *
 * LunaCode は LLM が編集するファイル操作を `.kairos/sandbox/workspace/<taskId>/`
 * 配下に閉じ込めるため、プロジェクトを「クローン」する。
 * クローン方法はプラットフォームとファイルシステムによって最適解が違うので、
 * 複数のストラテジーを `detectBestStrategy()` が自動選択する。
 */

/** 作業ツリーを複製するストラテジー */
export type WorkspaceStrategy =
  /** macOS APFS のクローン (`cp -c`)。O(1)、copy-on-write */
  | "apfs-clone"
  /** Linux btrfs / xfs の reflink (`cp --reflink=auto`)。O(1)、copy-on-write */
  | "reflink"
  /** `git worktree add`。git リポジトリ必須、履歴共有 */
  | "git-worktree"
  /** ポータブル full copy (`fs.cp -R`)。最終フォールバック */
  | "copy"
  /** 分離なし (既存挙動) */
  | "none";

/** 作業ツリー分離の設定 (`.kairos/config.json` → `sandbox.workspace`) */
export interface WorkspaceSandboxConfig {
  /** 有効化。false なら tier="workspace" でも無効 */
  enabled?: boolean;
  /** ストラテジー。"auto" は detectBestStrategy() に委譲 */
  strategy?: "auto" | WorkspaceStrategy;
  /** workspace の親ディレクトリ。既定 ".kairos/sandbox/workspace" */
  basePath?: string;
  /** タスク完了時に自動で origin へマージするか。既定 false */
  autoMerge?: boolean;
  /** 失敗時に workspace を残すか (デバッグ用)。既定 true */
  keepOnFailure?: boolean;
  /**
   * クローン時に除外するパス。
   * Phase 27 以降は gitignore 互換の glob パターンを受け付ける:
   *   - `*` / `?` / `**` (globstar) / `!negation` / 末尾 `/` (dirOnly) / 先頭 `/` (anchored)
   *   - `/` を含まない単純名 (`node_modules` 等) は任意深さで basename にマッチ。
   *   - 文字クラス `[abc]` と brace expansion `{a,b}` は未対応。
   */
  excludePatterns?: string[];
  /**
   * `origin/.gitignore` を読み込んで excludePatterns に合流させるか。既定 `true`。
   * Phase 27 から追加。サブディレクトリの `.gitignore` は再帰的には読み込まない
   * (プロジェクトルートの 1 枚のみを対象とする) 簡易実装。
   */
  respectGitignore?: boolean;
  /**
   * workspace 作成時にプロセス全体の `process.chdir(workspace.path)` を呼ぶか。
   * 既定 `true` (後方互換)。
   *
   * `true` にするとツールの相対パス解決が workspace 基点になるが、
   * プロセス全体の cwd が変わるため、logger / 並列タスク / テスト環境に
   * 副作用を及ぼす。Phase 26 以降で `false` を既定にし、ツール側に
   * `basePath` を注入する形に移行予定。
   */
  chdirOnActivate?: boolean;
}

/** コンテナサンドボックス設定 (Tier 2, 将来実装) */
export interface ContainerSandboxConfig {
  image?: string;
  network?: "none" | "bridge";
  cpus?: number;
  memoryMb?: number;
  cacheVolume?: string;
}

/** OS ネイティブサンドボックス設定 (Tier 3, 将来実装) */
export interface OsNativeSandboxConfig {
  macosPolicy?: string;
  linuxProfile?: string;
}

/** Sandbox 全体設定 */
export interface SandboxConfig {
  /** どの Tier で動かすか。既定 "none" */
  tier?: "none" | "workspace" | "container" | "os-native";
  workspace?: WorkspaceSandboxConfig;
  container?: ContainerSandboxConfig;
  osNative?: OsNativeSandboxConfig;
}

/** WorkspaceIsolator.create() が返す隔離済み作業ツリー */
export interface IsolatedWorkspace {
  /** 一意な ID (セッション ID 由来) */
  taskId: string;
  /** workspace の絶対パス */
  path: string;
  /** 本体プロジェクトの絶対パス */
  origin: string;
  /** 実際に採用されたストラテジー */
  strategy: WorkspaceStrategy;
  /** 生成時刻 */
  createdAt: Date;
  /** workspace を削除する */
  cleanup(): Promise<void>;
  /** workspace と origin の差分をマージする。dryRun=true なら確認のみ */
  merge(opts?: MergeOptions): Promise<MergeResult>;
  /** workspace と origin の差分を人間可読なテキストで返す (rsync/git diff 相当) */
  diff(opts?: DiffOptions): Promise<string>;
}

/**
 * `merge()` 時に origin 側が外部から変更されていた場合の扱い (Phase 28)。
 *
 * - `"abort"` (既定): 1 件でも衝突があれば何も適用せず、`conflicted` に列挙して返す。
 * - `"skip-conflicted"`: 衝突していないファイルだけを適用し、衝突分は `skipped`
 *   に入れる (他の merge は進む)。
 * - `"force"`: 衝突を無視して workspace 版で上書きする (Phase 27 までの挙動)。
 */
export type MergeConflictPolicy = "abort" | "skip-conflicted" | "force";

export interface MergeOptions {
  /** 適用せず計画だけ返す */
  dryRun?: boolean;
  /** このパスのみ対象とする (basePath からの相対) */
  onlyPaths?: string[];
  /**
   * origin 並行変更を検出したときの扱い (Phase 28)。
   * 既定は `"abort"`。
   */
  onConflict?: MergeConflictPolicy;
}

/**
 * `merge()` の戻り値。
 *
 * `conflicted` には 2 系統のエントリが入り得る:
 *   - Phase 28 の origin 外部変更衝突: `"path: origin が外部変更されています ..."` 形式
 *   - コピー中の I/O エラー: `"path: <error message>"` 形式
 *
 * 呼び出し側は差分を識別したければ `applied` / `skipped` との突合で判断する。
 */
export interface MergeResult {
  applied: string[];
  conflicted: string[];
  skipped: string[];
  /** dryRun=true の場合にセットされる人間可読プラン */
  preview?: string;
}

export interface DiffOptions {
  onlyPaths?: string[];
}

/**
 * ストラテジー実装が満たすインターフェース。
 * WorkspaceIsolator は detectBestStrategy() で選んだ Strategy を呼び出す。
 */
export interface WorkspaceStrategyImpl {
  /** 名前 (デバッグログ用) */
  readonly name: WorkspaceStrategy;
  /** この環境でこのストラテジーが使えるか (dry-run テストも可) */
  isSupported(origin: string): Promise<boolean>;
  /** origin を target にクローンする */
  clone(params: CloneParams): Promise<void>;
  /** workspace を破棄する (git worktree remove 等の特殊処理がある場合に利用) */
  cleanup(workspace: IsolatedWorkspace): Promise<void>;
}

export interface CloneParams {
  origin: string;
  target: string;
  excludePatterns: string[];
  /** ストラテジー別の追加オプション */
  extra?: Record<string, unknown>;
}
