# Changelog

All notable changes to LunaCode will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

次期バージョンで予定している変更はありません。

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
