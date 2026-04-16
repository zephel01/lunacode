# Changelog

All notable changes to LunaCode will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

次期バージョンで予定している変更はありません。

## [1.1.0] - 2026-04-16

### Added

**SWE-bench 対応（Phase 18・20・21）**
- **Phase 21 Complete**: テスト実行ツール `run_tests`（TestRunnerTool）を追加
  - pytest / unittest / jest / vitest / bun / go test / cargo test / make の 8 フレームワークに対応
  - `pytest.ini` / `bun.lockb` / `go.mod` / `Cargo.toml` / `package.json` を検出してフレームワークを自動判定
  - 構造化出力: total / passed / failed / errors / skipped / failedTests[] / duration
  - パスインジェクション・env キー不正検証などのセキュリティバリデーション
  - タイムアウト制御（1〜600 秒）、出力 200 行切り詰め
  - テスト: 30 pass（ToolRegistry 統合、フレームワーク自動検出、パーサ、バリデーション、SWE-bench ワークフローシナリオ）
- **Phase 20 Complete**: マルチファイル同時編集ツール `multi_file_edit`（MultiFileEditTool）
  - 全ファイルをアトミックに編集し、失敗時はロールバック
  - dry_run モードで事前検証、最大 50 ファイル、新規作成・置換・上書きに対応
  - テスト: 27 pass
- **Phase 18 Complete**: Git ツール強化（git_status / git_diff / git_commit / git_apply / git_log）
  - パラメータ単位の入力制限・危険操作ブロック・構造化出力
  - テスト: 41 pass

### Changed

- コアツール数: 7 → 15（Phase 18・20・21 で 8 ツール追加）
- テスト総数: 536 → 566 pass

## [1.0.0] - 2026-04-10

### Added

**コア機能（Phase 0）**
- **Phase 0 Complete**: Basic agent loop with 8 core tools (Bash, read/write/edit_file, Glob, Grep, Git, delegate_task)
- ReAct パターン（Thought → Action → Observation）による自律ループ（最大50イテレーション）
- Multi-LLM provider support: OpenAI / Z.AI (GLM) / Ollama / LM Studio / LiteLLM
- React Ink-based TUI interface
- Comprehensive CLI with all commands

**ローカルLLM最適化（Phase 1–4）**
- **Phase 1 Complete**: Ollama NDJSON ストリーミング応答（AsyncGenerator ベース、リアルタイムトークン出力）
- **Phase 2 Complete**: コンテキストウィンドウ管理（TokenCounter CJK対応、ContextManager 自動トリミング、ModelRegistry 動的ルックアップ）
- **Phase 3 Complete**: プロバイダーフォールバック（CircuitBreaker + FallbackProvider、ラウンドロビン + sticky active）
- **Phase 4 Complete**: モデル自動ルーティング（TaskClassifier キーワードスコアリング、ModelRouter 軽量/高性能モデル自動選択）

**安全性・UX（Phase 5–6）**
- **Phase 5 Complete**: チェックポイント＆ロールバック（Git ベース自動スナップショット、undo/rollback/diff コマンド、maxCheckpoints プルーニング）
- **Phase 6 Complete**: Diff プレビュー＆承認フロー（unified diff 表示、auto/confirm/selective 3モード、リスクレベル別承認制御）

**拡張性・スケーラビリティ（Phase 7–8）**
- **Phase 7 Complete**: ライフサイクルフック（HookManager、FileHookLoader、11イベント対応: session/tool/iteration/response/mcp）
- **Phase 8 Complete**: サブエージェント並列実行（SubAgentManager、最大6タスク同時委譲、explorer/worker/reviewer ロール別権限）

**エコシステム連携（Phase 9）**
- **Phase 9 Complete**: MCP 統合（JSON-RPC 2.0 over stdio、MCPConnection ハンドシェイク、MCPClientManager 複数サーバー管理、ツール名前空間自動登録 `mcp_{server}_{tool}`）

**セキュリティ（全フェーズ）**
- Multi-agent coordination: Coordinator / Worker パターン、優先度キューイング
- Access control: RBAC、監査ログ
- Sandbox execution environment: SandboxEnvironment
- Modern TUI with React Ink
- Undercover Mode for commercial use（AI 参照除去）
- Buddy Mode: 18種 AI ペット、感情・空腹・幸福度システム
- 通知システム: OS通知 / Pushover / Telegram、Quiet Hours 対応

### Bug Fixes（全23件修正済み）

**クリティカル（P0）**
- ConfigManager: インポートパス `./LLMProvider.js` → `../providers/LLMProvider.js` 修正
- package.json: 余分な `}` による無効 JSON 修正
- AccessControl: 認証バイパス脆弱性（`hasPermission` 境界条件）修正
- GrepTool: シェルインジェクション脆弱性修正（引数サニタイズ強化）

**重要（P1）**
- AgentLoop: JSON パースエラー時のクラッシュ修正
- AutoDream: O(n²) 矛盾検出アルゴリズム → O(n log n) に最適化
- SandboxEnvironment: 変数シャドウイングバグ修正
- KAIROSDaemon: PID チェックで自プロセス除外（テスト環境誤検出防止）
- FileHookLoader: ファイル未存在（return 0）と JSON 構文エラー（throw）の分離
- daemon.test.ts: テスト用ディレクトリを `process.cwd()` 固定 → `os.tmpdir()` + `mkdtemp()` に変更

**セキュリティ（6件）**
- パスワードハッシュアルゴリズム: SHA-256 → scrypt に強化
- その他セキュリティ脆弱性 5件修正

**パフォーマンス改善（4件）**
- メモリ圧縮効率の改善
- 並列ツール実行の最適化
- 通知タイミングの修正
- 型定義の修正

### Test Coverage

- **全315テスト / 671アサーション / 0 失敗**
- Phase 1–9 対応テスト: 202 pass（streaming, context, fallback, router, checkpoint, diff, hooks, sub-agent, mcp）
- ツール・プロバイダー・セキュリティ・ベンチマーク等: 113 pass

### Providers

- OpenAI（推奨）
- Ollama（オフライン・無料）
- LM Studio（オフライン・無料）
- Z.AI / GLM（コーディング特化）
- LiteLLM（100+ プロバイダー統合プロキシ）

### Documentation

- README.md（プロジェクト概要・クイックスタート）
- docs/ARCHITECTURE.md（内部設計・パイプライン解説）
- docs/USER_GUIDE.md（ユーザー向け機能ガイド）
- docs/ADD_PROVIDER.md（プロバイダー追加ガイド）
- docs/guide/getting-started.md（セットアップ手順）
- docs/guide/features.md（機能詳細）
- docs/guide/usage.md（コマンド・ツール一覧）
- docs/guide/troubleshooting.md（トラブルシューティング）
- AGENTS.md（AI エージェント向け開発者ガイド）

### Breaking Changes

- None — Initial stable release

### Known Issues

- None — All major features implemented and tested

## [0.9.0] - 2026-04-08

### Added

- Buddy mode implementation
- Notification system with OS support
- React Ink TUI components
- Multi-agent coordinator
- Access control system

### Changed

- Improved memory compression efficiency
- Enhanced daemon reliability
- Optimized tool execution

## [0.8.0] - 2026-04-05

### Added

- AutoDream implementation
- Daemon mode with tick system
- Parallel tool executor
- Notification manager

### Changed

- Refactored agent loop for better performance
- Improved memory context management

## [0.7.0] - 2026-04-02

### Added

- Memory compression algorithms
- Topic-based memory organization
- Auto-compact feature
- Search functionality

### Changed

- Enhanced tool system with more tools
- Improved error handling

## [0.6.0] - 2026-03-30

### Added

- Daemon mode basics
- Tick / Heartbeat system
- Proactive judgment system
- Event system

### Changed

- Restructured project for scalability
- Added configuration management

## [0.5.0] - 2026-03-25

### Added

- Basic agent loop implementation
- 7 core tools (Bash, File, Grep, Git, Edit, Search)
- Simple memory system
- CLI interface

### Changed

- Initial release

---

## Versioning

LunaCode follows [Semantic Versioning](https://semver.org/):

- **MAJOR**: Incompatible API changes
- **MINOR**: Backwards-compatible functionality additions
- **PATCH**: Backwards-compatible bug fixes

## Release Process

1. Update version in `package.json`
2. Update CHANGELOG.md
3. Create Git tag
4. Create GitHub release
5. Update documentation
6. Announce release

## Future Plans

See [plan.md](docs/inside/plan.md) for upcoming features and roadmap.
