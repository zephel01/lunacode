# Changelog

All notable changes to LunaCode will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Performance

**Phase 30: パフォーマンス改善 Wave 1-3 の正式記録（2026-04-19）**

2026-04-17 の非公式コミット `6abe1d0` (「パフォーマンス改善」) + `20b90fb`
(「fix パフォーマンス改善」) で実装されていた Wave 1-3 全 10 項目を
本 CHANGELOG に正式記録する。実装そのものは既に main に入っており、
Phase 30 ではこの帳簿合わせと、欠落していた単体テスト 12 本の追加を行った。

Wave 1（応答性に直結する 3 項目）:

- **W1-1**: `LongTermMemory.generateEmbeddingSafe()` に sha256(text) ベースの
  LRU キャッシュ（最大 2000 件）を追加。同一テキストの再 embedding を回避。
  `getCacheStats()` で hits / misses / size / hitRate を取得可
  (`src/memory/LongTermMemory.ts:81-84, 420-465`)
- **W1-2**: `TestRunnerTool.detectFramework()` を `Promise.allSettled` で
  並列 stat 化 + CWD ごとに 60 秒 TTL のフレームワーク検出キャッシュを追加
  (`src/tools/TestRunnerTool.ts:68-70, 86`)
- **W1-3**: `src/utils/gitRunner.ts` を新設し、`spawn` ベースの非同期 git 実行
  ヘルパ `runGit()` と `GitCommandError` を導入。`CheckpointManager` /
  `AutoGitWorkflow` の `execSync` 呼び出しを移行（メインスレッドブロックを解消）

Wave 2（Memory / VectorStore 周辺の効率化）:

- **W2-1**: `MemorySystem.searchMemory()` のトピックファイル読み込みを
  `Promise.all` で並列化 (`src/memory/MemorySystem.ts:427-437`)
- **W2-2**: `VectorStore.search()` の Top-K 管理を min-heap 的な置換ロジックに
  変更し、計算量を O(n log K) に抑制 (`src/memory/VectorStore.ts:177-213`)
- **W2-3**: `VectorStore.evict()` をインクリメンタル削除に変更
  (`src/memory/VectorStore.ts:301-324`)
- **W2-4**: `searchByKeyword()` で正規表現メタ文字 (`[`, `(`, `*` 等) を
  エスケープ + 正規表現キャッシュ (`src/memory/VectorStore.ts:224-225`)
- **W2-5**: `autoSaveTimer` に `unref()` を呼んでイベントループを引き留めない
  ように。`destroy()` で `clearInterval` (`src/memory/VectorStore.ts:65-70, 124`)
- **W2-6**: `MemorySystem.searchContent()` の前処理結果（`lines` /
  `linesLower`）を mtime ベースで 60 秒キャッシュ
  (`src/memory/MemorySystem.ts:24-27, 370-398`)

Wave 3:

- **W3-1**: `src/cli.ts` の重い依存をサブコマンド処理時の `await import()` に
  移してレイジーロード化。CLI 起動時のオーバーヘッド削減

### Added

**Phase 30: 不足していたパフォーマンス系テスト（2026-04-19）**

Wave 1-3 のうち単体テストが欠落していた箇所に追加（12 tests / `bun test`:
745 → 757 pass）。

- `tests/longterm-memory-cache.test.ts` (新規, 4 tests): W1-1 の embedding
  LRU キャッシュの hit/miss カウンタ、`getCacheStats()` の hitRate 計算、
  容量超過時の eviction、LRU 順序維持
- `tests/git-runner.test.ts` (新規, 6 tests): W1-3 `runGit()` の正常系
  (stdout 取得)・異常系 (`GitCommandError` の `exitCode` / `stderr`)・cwd
  反映・`combineStderr` オプション・`timeoutMs` での kill
- `tests/vector-memory.test.ts` (追補, 2 tests): W2-4 正規表現メタ文字
  (`[0]`, `foo(bar)`) の安全なリテラル検索、W2-5 `destroy()` の二重呼び出し
  安全性

### Changed

**Phase 29: `chdirOnActivate: false` をデフォルト化（破壊的変更）（2026-04-19）**

Phase 25 で導入したオプションフラグ `workspace.chdirOnActivate` の既定値を
**`true` → `false`** に反転した。これに合わせて、ツール側の相対パス解決経路を
`process.cwd()` から `ToolContext.basePath` に切り替えた。

- **BREAKING**: `WorkspaceSandboxConfig.chdirOnActivate` の既定値が `false` に
  なった。Phase 25–28 と同じ「workspace 作成と同時に `process.chdir(workspace.path)`
  も呼ぶ」挙動が必要な場合は、`.kairos/config.json` で
  `sandbox.workspace.chdirOnActivate: true` を明示する
- `AgentLoop` のシステムプロンプトが LLM に渡す cwd を `process.cwd()` ではなく
  `this.basePath` に変更。`chdirOnActivate: false` でも LLM 視点の cwd は
  workspace に揃うようになった

### Added

**Phase 29: `ToolContext` 注入機構（2026-04-19）**

ツールが「どのディレクトリを基準に動くか」を `ToolRegistry.setContext()` 経由で
明示的に注入できるようにした。`process.chdir()` というプロセス全体の副作用に
依存せずに workspace 切り替えが完結する。

- `src/types/index.ts` に `ToolContext { basePath: string }` を追加。
  `Tool` インタフェースに `setContext?(ctx: ToolContext): void` を任意メソッドとして
  追加（既存実装は壊さない）
- `src/tools/BaseTool.ts` に `setContext()` / `resolveBasePath()` /
  `resolvePath()` ヘルパを追加。`runCommand()` / `runCommandSafe()` も `cwd`
  引数を受け取り、未指定なら `resolveBasePath()` を `spawn` の cwd に渡す
- `BasicTools.ts` の `read_file` / `write_file` / `edit_file` / `glob` / `grep`、
  `MultiFileEditTool` / `TestRunnerTool` / `BashTool` を `resolvePath()` /
  `resolveBasePath()` 経由に書き換え。絶対パスは素通し、相対パスは
  `ToolContext.basePath` を起点に解決する
- `ToolRegistry.setContext(ctx)` / `getContext()` を追加。`setContext()` は登録済み
  全ツールに伝播し、後続 `register()` にも自動でコンテキストが渡る
- `AgentLoop` がコンストラクタで `basePath`、`setupSandboxWorkspace()` で
  `workspace.path`、`disposeSandboxWorkspace()` で `originPath` をそれぞれ
  `ToolRegistry.setContext()` に流すよう変更
- テスト: `tests/sandbox-phase29.test.ts` 14 pass（BaseTool / ToolContext 経路、
  ToolRegistry.setContext() 伝播、WorkspaceIsolator + Tool 結合テスト）

### Added

**Phase 28: `autoMerge` の衝突検知（origin 並行変更の detect）（2026-04-19）**

`WorkspaceIsolator.merge()` が origin 側の並行変更を検知し、ユーザのローカル変更を
sandbox 産ファイルで無言上書きする事故を防げるようにした。

- `src/sandbox/baseline.ts` を新規追加。origin のファイル一覧 + `{size, mtime}` を
  `<basePath>/<taskId>.baseline.json` に記録する `captureBaseline()`、
  ロード用 `loadBaseline()`、差分判定 `detectOriginConflicts()` を実装。
  conflict 種別は `externally-modified` / `externally-deleted` / `externally-added`
- `MergeOptions.onConflict?: "abort" | "skip-conflicted" | "force"` を追加。
  **既定は `"abort"`**（1 件でも衝突があれば何も適用せず `conflicted` に列挙）。
  従来の後勝ち挙動が必要な場合は `"force"` を明示する
- `WorkspaceIsolator.create()` が baseline ファイルを自動生成し、
  `cleanup()` が baseline も一緒に削除するよう変更
- `lunacode sandbox merge <taskId> --on-conflict <abort|skip-conflicted|force>`
  フラグを追加（既定 `abort`、不正値は exit code 1）
- テスト: `tests/sandbox-phase28.test.ts` 20 pass（baseline 単体・WorkspaceIsolator
  統合・3 つの衝突モード・dryRun CONFLICT 表示・CLI smoke）

### Changed

- `WorkspaceIsolator.merge()` の既定挙動が **origin 外部変更があれば中止** に
  切り替わった。Phase 27 までと同じ「後勝ち上書き」を維持したい呼び出し元は
  `merge({ onConflict: "force" })` を明示する必要がある

### Docs

- `docs/SANDBOX.md` に §8.5「衝突検知（Phase 28）」を追加（衝突種別表、
  `onConflict` の API / CLI 使い分け、実装メモ、非ゴール）。
  §9.5 CLI セクションの `merge` 行に `--on-conflict` を併記

**Phase 27: 除外パターンの glob 化と `.gitignore` 連携（2026-04-19）**

Phase 25 の残課題だった「サブディレクトリや glob で除外できない」制限を解消し、
`.gitignore` と同じ感覚で `excludePatterns` を書けるようにした。

- `src/sandbox/patternMatch.ts` を新規追加。`.gitignore` 互換の glob マッチャー
  (`compilePattern` / `matchOne` / `matchAny` / `parseGitignore`)。`*`・`?`・
  `**` (globstar)・先頭 `/` (anchored)・末尾 `/` (dirOnly)・`!negation` をサポート
- `src/sandbox/strategies.ts` の `isExcluded()` / `pruneExcluded()` / `makeExcludeFilter()`
  を新マッチャーベースに置き換え。`pruneExcluded()` は target を walk しながら
  glob で評価する実装に変更
- `WorkspaceSandboxConfig.respectGitignore?: boolean` を追加（既定 `true`）。
  `origin/.gitignore` を自動で excludePatterns に合流させる
- テスト: `tests/sandbox-phase27.test.ts` 21 pass（matcher 単体 + `WorkspaceIsolator`
  経由の統合テスト）

### Removed

**Phase 27: 旧 `SandboxEnvironment` の物理削除（2026-04-19）**

- `src/security/SandboxEnvironment.ts` を削除。Phase 25 で `@deprecated` 化
  していたもので、セキュリティ機能として実効性が乏しい（文字列 includes
  のみのルール判定、ignore される `allow` ルール、実際には殺さない
  `maxExecutionTime` 等）ため
- `tests/sandbox-phase25.test.ts` §4（deprecation 警告テスト）を削除
- `docs/SANDBOX.md` §11 / `docs/KAIROS_DIRECTORY.md` / `docs/ARCHITECTURE.md` /
  `AGENTS.md` の `@deprecated` 記述を、削除済みの注記に更新

**Phase 26: `lunacode sandbox` CLI サブコマンド（2026-04-19）**

Phase 24.1.6 の残タスクだった手動管理 CLI を実装。エージェントが落ちたり
`keepOnFailure` で残った workspace をコマンドラインから確認・整理できる。

- `lunacode sandbox list [--json]`: `.kairos/sandbox/workspace/` 配下を列挙
  （taskId / size / age / created / strategy-hint の表、または JSON 出力）
- `lunacode sandbox diff <taskId> [--only <paths...>]`: workspace と origin の
  差分を表示。`WorkspaceIsolator.open()` + `diff()` に委譲
- `lunacode sandbox merge <taskId> [--apply] [--only <paths...>]`: workspace →
  origin へのマージ。**既定 dry-run** で、実反映には `--apply` が必要
- `lunacode sandbox clean [<taskId>|--all|--older-than <days>] [--dry-run] [--yes]`:
  削除。`--all` は TTY で確認プロンプト、`--yes`/`-y` で省略可能
- 実装: `src/sandbox/cli.ts`（新規）+ `src/cli.ts` の commander.js 登録
- テスト: `tests/cli-sandbox.test.ts` 10 pass

### Changed

**Phase 25: サンドボックス実装の堅牢化（2026-04-19）**

- `src/security/SandboxEnvironment.ts` を `@deprecated` マーク。コンストラクタで初回のみ
  警告ログを出すようにした。ルール判定が文字列 `includes()` のみ、allow ルールが評価
  されていない、`maxExecutionTime` が `console.warn` するだけで実際のプロセスを殺さない
  等、セキュリティ機能として実効性が乏しかったため。代替は `WorkspaceIsolator`（Tier 1）
- `WorkspaceIsolator.filesDiffer` の mtime fast-path を削除。`APFS clone` / `reflink` /
  `CopyStrategy` の `utimes` は mtime を保存するため、同一サイズ・同一 mtime でも内容が
  異なるケース（同じ長さの文字列差し替えなど）を見落としていた
- `ReflinkStrategy.isSupported` のプローブディレクトリ名に `pid + timestamp + random`
  suffix を付与し、`try/finally` で確実に後片付けするようにした。従来はプロセス死亡時に
  origin に `.luna-reflink-probe/` が残存、並列起動で race が発生していた
- `GitWorktreeStrategy.clone` のブランチ名に random suffix を追加
  （`sandbox/<basename>-<timestamp>-<random>`）。事前の無条件 `git branch -D` を削除し、
  cleanup 時は `git worktree list --porcelain` で対象ブランチを特定 → `show-ref` で
  存在確認 → 削除、の流れに変更。ユーザーが偶然同名ブランチを持っていた場合の誤削除を
  防止
- `WorkspaceSandboxConfig.chdirOnActivate` フラグを追加（既定 `true` で後方互換）。
  `false` にするとプロセス全体の `process.chdir()` を行わず、`AgentLoop.basePath` 経由で
  workspace パスを伝播するモード（ツール側の完全対応は Phase 26 以降）

### Docs

- `docs/inside/plan.md` に Phase 25 セクションを追加
- `docs/SANDBOX.md` §4 に glob パターン構文と `.gitignore` 連携の章を追加 (Phase 27)

---

## [2.4.2] - 2026-04-17

### Added

**ローカル LLM 最適化・安全性 Phase 22〜24**

- **Phase 24 Complete**: サンドボックス階層 Tier 1（作業ツリー分離）を追加
  - `WorkspaceIsolator` がタスク毎に origin の隔離コピーを作成し、`process.chdir()` で切り替え
  - 4 ストラテジー: `apfs-clone`（macOS APFS, CoW）/ `reflink`（Linux btrfs/xfs）/ `git-worktree` / `copy`
  - `strategy: "auto"` で環境に応じて自動選択、巨大 `node_modules` 既定除外
  - `diff()` / `merge({ dryRun })` / `cleanup()` API、`keepOnFailure: true` でデバッグ容易
  - `.kairos/config.json` の `sandbox.tier = "workspace"` で有効化
  - テスト: 20 pass
  - ドキュメント: [`docs/SANDBOX.md`](docs/SANDBOX.md)
- **Phase 23 Complete**: post-write 構文チェック（SyntaxValidator）
  - `write_file` / `edit_file` / `multi_file_edit` の書き込み直後に言語別 parse チェックを実行
  - 対応: TypeScript / JavaScript / JSON / Python / YAML。失敗は警告のみでブロックしない
  - LLM 側に「壊れたコードを書いた」ことを返すことで次ターンでの自己修正を促す設計
  - テスト: 各言語分 pass（総計 676 pass へ寄与）
  - ドキュメント: [`docs/VALIDATION.md`](docs/VALIDATION.md)
- **Phase 22 Complete**: モデル設定レジストリ（Aider 方式）
  - `model-settings.yml` でモデル × 設定（`native_tools` / `edit_format` / `num_ctx`）を宣言管理
  - 4 階層の優先（cwd / repo / user / builtin）+ glob マッチ
  - `lunacode test-provider --check-model` で実機 probe とレジストリ宣言の一致を検証
  - 既存の `LUNACODE_OLLAMA_*` 環境変数は後方互換で維持（deprecation warning あり）
  - ドキュメント: [`docs/MODEL_SETTINGS.md`](docs/MODEL_SETTINGS.md)

### Changed

- テスト総数: 566 → 676 pass
- README の Phase バッジ: 21/22 → 23/24
- `ROADMAP.md` を新設し、公開用の進捗サマリーを `docs/inside/plan.md`（非公開）から分離
- リポジトリルートの `plan.md`（サンドボックス階層ワーキングメモ）を `docs/inside/plan.md` に統合・削除
- 採番整理: 旧 Phase 9（重複していた ModelSettingsRegistry）を Phase 22 にリネーム

### Docs

- 新規: `docs/SANDBOX.md` / `docs/VALIDATION.md` / `docs/MODEL_SETTINGS.md` / `docs/KAIROS_DIRECTORY.md` / `ROADMAP.md`

---

## [2.4.0] - 2026-04-16

### Added

**SWE-bench 対応 Phase 20・21**

- **Phase 21 Complete**: テスト実行ツール `run_tests`（TestRunnerTool）を追加
  - pytest / unittest / jest / vitest / bun / go test / cargo test / make の 8 フレームワークに対応
  - `pytest.ini` / `bun.lockb` / `go.mod` / `Cargo.toml` / `package.json` を検出してフレームワークを自動判定
  - 構造化出力: total / passed / failed / errors / skipped / failedTests[] / duration
  - パスインジェクション・env キー不正検証などのセキュリティバリデーション
  - タイムアウト制御（1〜600 秒）、出力 200 行切り詰め
  - テスト: 30 pass
- **Phase 20 Complete**: マルチファイル同時編集ツール `multi_file_edit`（MultiFileEditTool）
  - 全変更をアトミックに適用し、失敗時はロールバック
  - dry_run モードで事前検証、最大 50 ファイル、新規作成・置換・上書きに対応
  - テスト: 27 pass

### Changed

- コアツール数: 12 → 15（Phase 20・21 で 3 ツール追加）
- テスト総数: 497 → 566 pass

---

## [2.3.0] - 2026-04-16

### Added

**SWE-bench 対応 Phase 18**

- **Phase 18 Complete**: Git ツール強化（git_status / git_diff / git_commit / git_apply / git_log）
  - パラメータ単位の入力制限・危険操作ブロック・構造化出力
  - GitStatusTool: `git diff` ベースで stat cache 問題を回避
  - GitDiffTool: working / staged / 任意 ref 対応、context_lines・stat_only オプション
  - GitCommitTool: バッククォート・`$(` を含むメッセージ・パスをブロック
  - GitApplyTool: 一時ファイル経由でパッチ適用、dry-run・reverse オプション
  - GitLogTool: count 上限・since・file フィルタ、インジェクション対策
  - テスト: 41 pass

### Changed

- コアツール数: 7 → 12

---

## [2.2.0] - 2026-04-16

### Added

**Phase 17: CLI サブコマンド（commander.js / cobra 相当）**

- `cli.ts` の if/else チェーンを `commander.js` の `Command` ベースに置換
- ネストしたサブコマンド、エイリアス、オプション解析、`--help` 自動生成
- テスト: 11 pass（コマンド構造・サブコマンド・オプション解析）

---

## [2.1.0] - 2026-04-16

### Added

**Phase 16: 構造化ログ（pino）**

- JSON 構造化ログ / pino-pretty による開発時カラー出力
- コンポーネント別子ロガー（`logger.child({ component: '...' })`）
- エラーオブジェクトのスタックトレース自動シリアライズ
- テスト: 19 pass

---

## [2.0.0] - 2026-04-16

### Added

**Phase 10–15: 高度機能**

- **Phase 10 Complete**: 長期メモリ + ベクトル検索（TF-IDF / Ollama / OpenAI エンベディング、外部 DB 不要の純 TypeScript 実装）— テスト: 37 pass
- **Phase 11 Complete**: マルチエージェントオーケストレーション（PipelineOrchestrator による Planner / Coder / Reviewer パイプライン）— テスト: 15 pass
- **Phase 12 Complete**: 自動 Git ワークフロー（Conventional Commits 自動コミット、テスト実行・PR 作成）— テスト: 20 pass
- **Phase 13 Complete**: Web Search / Browser ツール統合（mcp-wrapper 連携、SSRF 対策）
- **Phase 14 Complete**: 自己評価・自己修正ループ（LLM スコアリング、閾値未満で自動修正・再生成）— テスト: 16 pass
- **Phase 15 Complete**: モデルルーティング高度化（TaskClassifier キーワードスコアリング拡張、フォールバックチェーン）— テスト: 32 pass

### Breaking Changes

- AgentLoop 内部 API 変更（SelfEvaluator / ModelRouter 統合）

---

## [1.0.0] - 2026-04-12

### Added

**コア機能（Phase 0）**

- ReAct パターン（Thought → Action → Observation）による自律ループ（最大50イテレーション）
- 7 のコアツール: Bash, read/write/edit_file, Glob, Grep, Git, delegate_task
- Multi-LLM provider support: OpenAI / Z.AI (GLM) / Ollama / LM Studio / LiteLLM
- React Ink-based TUI interface

**ローカル LLM 最適化（Phase 1–4）**

- **Phase 1 Complete**: Ollama NDJSON ストリーミング応答（AsyncGenerator ベース）— テスト: 8 pass
- **Phase 2 Complete**: コンテキストウィンドウ管理（TokenCounter CJK 対応、ContextManager 自動トリミング）— テスト: 24 pass
- **Phase 3 Complete**: プロバイダーフォールバック（CircuitBreaker + FallbackProvider）— テスト: 21 pass
- **Phase 4 Complete**: モデル自動ルーティング（TaskClassifier、ModelRouter）— テスト: 34 pass

**安全性・UX（Phase 5–6）**

- **Phase 5 Complete**: チェックポイント＆ロールバック（Git ベース自動スナップショット）— テスト: 18 pass
- **Phase 6 Complete**: Diff プレビュー＆承認フロー（auto/confirm/selective 3モード）— テスト: 33 pass

**拡張性（Phase 7–9）**

- **Phase 7 Complete**: ライフサイクルフック（11イベント: session/tool/iteration/response/mcp）— テスト: 22 pass
- **Phase 8 Complete**: サブエージェント並列実行（最大6タスク同時委譲、explorer/worker/reviewer ロール）— テスト: 20 pass
- **Phase 9 Complete**: MCP 統合（JSON-RPC 2.0 over stdio、ツール名前空間 `mcp_{server}_{tool}`）— テスト: 22 pass

### Bug Fixes（全23件）

- ConfigManager: インポートパス修正
- package.json: 無効 JSON 修正
- AccessControl: 認証バイパス脆弱性修正
- GrepTool: シェルインジェクション脆弱性修正
- AgentLoop: JSON パースエラー時のクラッシュ修正
- AutoDream: O(n²) 矛盾検出 → O(n log n) に最適化
- パスワードハッシュ: SHA-256 → scrypt に強化
- その他バグ・セキュリティ修正 16 件

### Test Coverage

- 315 pass / 671 アサーション / 0 失敗

---

## [0.9.0] - 2026-04-08

### Added

- Buddy mode（18種 AI ペット、感情・空腹・幸福度システム）
- 通知システム（OS通知 / Pushover / Telegram、Quiet Hours 対応）
- React Ink TUI コンポーネント
- Multi-agent coordinator
- Access control（RBAC、監査ログ）

## [0.8.0] - 2026-04-05

### Added

- AutoDream（メモリ統合・矛盾解消・洞察抽出）
- KAIROS デーモン（Tick / Heartbeat システム）
- Parallel tool executor
- 通知マネージャ

## [0.7.0] - 2026-04-02

### Added

- メモリ圧縮アルゴリズム
- トピック別メモリ組織化
- Auto-compact 機能

## [0.6.0] - 2026-03-30

### Added

- デーモンモード基盤
- Tick / イベントシステム
- 設定管理

## [0.5.0] - 2026-03-25

### Added

- 基本エージェントループ
- 7 コアツール（Bash, File, Grep, Git, Edit, Search）
- シンプルメモリ・CLI インタフェース

---

## Versioning

LunaCode follows [Semantic Versioning](https://semver.org/):

- **MAJOR**: 非互換 API 変更
- **MINOR**: 後方互換の機能追加
- **PATCH**: 後方互換のバグ修正

## Release Process

1. `package.json` のバージョンを更新
2. `CHANGELOG.md` を更新
3. Git タグを打つ（`git tag vX.Y.Z && git push --tags`）
4. GitHub Release を作成

## Future Plans

See [plan.md](docs/inside/plan.md) for upcoming features and roadmap.
