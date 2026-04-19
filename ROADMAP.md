# LunaCode ロードマップ

> 最終更新: 2026-04-19

LunaCode のこれまでの実装と、これから取り組む予定の公開ロードマップです。
このファイルは**利用者・コントリビューター向けの要約**です。設計の背景や意思決定の詳細、
PR 分割・工数見積りなどを含む完全版は開発者向けノートに置かれています。

---

## ステータス

- **完了 Phase**: 30 / 全 31（Phase 19 のみ保留）
- **テスト**: 780 pass / 3 todo / 0 fail
- **対応 LLM プロバイダー**: OpenAI / Ollama / LM Studio / LiteLLM / Z.AI

---

## 完了済み

### コア・エージェント基盤（Phase 1〜9）

| Phase | 項目                            | 要約                                                   |
| ----- | ------------------------------- | ------------------------------------------------------ |
| 1     | ストリーミング応答              | トークン単位のリアルタイム出力                         |
| 2     | コンテキストウィンドウ管理      | モデル別コンテキスト長を自動検出しトークン圧縮         |
| 3     | プロバイダーフォールバック      | サーキットブレーカー + フォールバック順                |
| 4     | モデル自動選択                  | タスク分類器によるモデル切替                           |
| 5     | チェックポイント & ロールバック | Git ベースのスナップショットと復元                     |
| 6     | Diff プレビュー & 承認フロー    | ファイル変更前に unified diff を提示                   |
| 7     | Hooks（ライフサイクルイベント） | `pre_tool` / `post_tool` などに外部コマンドを差し込む  |
| 8     | サブエージェント                | Hub-and-Spoke でタスクを委譲、最大 6 並列              |
| 9     | MCP 対応                        | Model Context Protocol（JSON-RPC 2.0）で外部ツール接続 |

### 拡張機能（Phase 10〜18, 20, 21）

| Phase | 項目                                   | 要約                                                      |
| ----- | -------------------------------------- | --------------------------------------------------------- |
| 10    | 長期メモリ + ベクトル検索              | TF-IDF/Embedding 両対応、セッション横断で記憶を再利用     |
| 11    | マルチエージェントオーケストレーション | Planner / Coder / Tester のパイプライン実行               |
| 12    | 自動 Git ワークフロー                  | Conventional Commits、テスト、PR 作成を自動化             |
| 13    | Web Search / Browser ツール統合        | DuckDuckGo 検索 + SSRF 対策付きフェッチ                   |
| 14    | 自己評価・自己修正ループ               | 自分の出力を採点して再試行                                |
| 15    | モデルルーティング高度化               | TaskType 判定と RoutingRule による細粒度制御              |
| 16    | 構造化ログ（pino）                     | JSON ログ + pretty カラー出力                             |
| 17    | CLI サブコマンド（commander.js）       | ネストしたサブコマンドとヘルプ自動生成                    |
| 18    | Git ツール強化                         | `git_status` / `git_diff` / `git_commit` / `git_apply` 等 |
| 20    | マルチファイル同時編集                 | `multi_file_edit`（アトミック・ロールバック・dry_run）    |
| 21    | テスト実行ツール                       | pytest / bun / jest / go / cargo を自動検出して実行       |

### ローカル LLM 最適化・安全性（Phase 22〜24）

| Phase | 項目                                        | 要約                                                                                     | 詳細                                               |
| ----- | ------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 22    | モデル設定レジストリ（Aider 方式）          | `model-settings.yml` でモデル × 設定（`native_tools`/`edit_format`/`num_ctx`）を宣言管理 | [`docs/MODEL_SETTINGS.md`](docs/MODEL_SETTINGS.md) |
| 23    | post-write 構文チェック                     | `write_file` / `edit_file` 後に言語別 parse チェック、失敗は警告のみ（破壊しない）       | [`docs/VALIDATION.md`](docs/VALIDATION.md)         |
| 24    | サンドボックス階層（Tier 1 作業ツリー分離） | タスク毎に origin の隔離コピーを作成（apfs-clone / reflink / git-worktree / copy）       | [`docs/SANDBOX.md`](docs/SANDBOX.md)               |

### サンドボックス強化・並列化（Phase 25〜31）

| Phase | 項目                                | 要約                                                                                                                                      | 詳細                                 |
| ----- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 25    | Tier 1 堅牢化                       | mtime fast-path 削除（size 一致時も内容比較）、reflink プローブを origin 外へ、git-worktree ブランチ名に random suffix                    | [`docs/SANDBOX.md`](docs/SANDBOX.md) |
| 26    | `lunacode sandbox` CLI              | `list / diff / merge / clean` の 4 サブコマンド。`merge` は既定 dry-run、`--apply` で反映、`--on-conflict abort\|skip-conflicted\|force`  | [`docs/SANDBOX.md`](docs/SANDBOX.md) |
| 27    | excludePatterns + `.gitignore` 連携 | glob / `**` / basename / `!` 否定に対応。`workspace.respectGitignore` で `origin/.gitignore` を自動取り込み。旧 `SandboxEnvironment` 削除 | [`docs/SANDBOX.md`](docs/SANDBOX.md) |
| 28    | auto-merge 衝突検知                 | baseline スナップショットで origin 並行変更を検出。`onConflict: "abort" \| "skip-conflicted" \| "force"` の 3 ポリシー                    | [`docs/SANDBOX.md`](docs/SANDBOX.md) |
| 29    | `ToolContext.basePath` 注入         | ツールが作用するディレクトリを明示的に注入。`chdirOnActivate` 既定を `false` に反転（プロセス全体の `process.chdir()` を廃止）            | [`docs/SANDBOX.md`](docs/SANDBOX.md) |
| 30    | パフォーマンス改善 Wave 1–3         | ファイル I/O の stream 化、ベクトル検索の IDF キャッシュ、ロガーのレベル別分岐                                                            | [`CHANGELOG.md`](CHANGELOG.md)       |
| 31    | マルチエージェント並列実行          | `ParallelAgentCoordinator` で複数のトップレベル AgentLoop を独立 workspace 上で並行起動。`lunacode parallel` CLI と連動                   | [`CHANGELOG.md`](CHANGELOG.md)       |

---

## 進行中・計画中

### Phase 32〜: サンドボックス Tier 2 / Tier 3

作業ツリーだけでなく、ファイル・ネットワーク・シグナルレベルで隔離する強化サンドボックス。

- **Tier 2**: Docker / Podman コンテナでツール実行をラップ（`--network=none` / `--read-only`）
- **Tier 3**: macOS `sandbox-exec` / Linux `bwrap` による OS ネイティブ分離

詳細設計は [`docs/SANDBOX.md`](docs/SANDBOX.md) の「Tier 2 / Tier 3（将来）」セクション参照。

### Phase 19: TUI 刷新（保留中）

Go 製 `bubbletea` 系の TUI を参考にした刷新を検討していましたが、本体は TypeScript ベースのため、
TypeScript エコシステムでの代替ライブラリ選定を継続検討中。

### その他の検討項目

- `edit_format: diff` / `udiff`（Aider 相当の SEARCH/REPLACE 形式）の追加
- ファジー edit 適用（難読 LLM 出力でも適用できる difflib ベースのフォールバック）
- 学習型モデルレジストリ（ランタイム検出結果を自動保存）

---

## 設計原則

LunaCode は以下の方針で設計しています。

1. **ローカル優先**: ローカル LLM（Ollama / LM Studio）で動く状態を保つ。クラウド LLM はオプション。
2. **破壊的ではないフィードバック**: 構文チェックやサンドボックスは「警告を重ねる」ことで LLM に修正を促し、
   書き込み自体はブロックしない。
3. **段階的な安全性**: プロセス権限（Tier 0）→ 作業ツリー分離（Tier 1）→ コンテナ（Tier 2）→
   OS ネイティブ（Tier 3）と、ユーザの環境に応じて段階的に導入できる。
4. **設定より規約**: デフォルトで動く。`.kairos/config.json` は必要に応じて上書きする。
5. **既存の慣習を尊重する**: Git / rsync / cp などの標準ツールを再発明しない。

---

## 詳細を知りたい方へ

| ドキュメント                                           | 内容                                               |
| ------------------------------------------------------ | -------------------------------------------------- |
| [`README.md`](README.md)                               | プロジェクトの概要・インストール・クイックスタート |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)         | 内部アーキテクチャ全体像                           |
| [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md)             | エンドユーザ向け利用ガイド                         |
| [`docs/KAIROS_DIRECTORY.md`](docs/KAIROS_DIRECTORY.md) | `.kairos/` 配下の設定・状態ファイル仕様            |
| [`docs/MODEL_SETTINGS.md`](docs/MODEL_SETTINGS.md)     | Phase 22: モデル別設定の書き方                     |
| [`docs/VALIDATION.md`](docs/VALIDATION.md)             | Phase 23: post-write 構文チェックの設定            |
| [`docs/SANDBOX.md`](docs/SANDBOX.md)                   | Phase 24: サンドボックスの設定・ストラテジー・API  |
| [`docs/ADD_PROVIDER.md`](docs/ADD_PROVIDER.md)         | 新しい LLM プロバイダーを追加する方法              |
| [`CHANGELOG.md`](CHANGELOG.md)                         | リリース履歴                                       |

---

## フィードバック

- バグ報告・機能要望: GitHub Issues
- プルリクエスト歓迎（`CONTRIBUTING.md` があれば参照、無い場合は Issue で方針相談）
