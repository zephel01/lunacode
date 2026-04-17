# `.kairos/` ディレクトリ仕様

LunaCode はプロジェクト単位の状態・設定・ログを **すべて `<cwd>/.kairos/` 配下** に置きます。
Aider の `.aider*` や OpenCode の `.opencode/` に相当する、LunaCode の「ワーキングディレクトリ」です。

> TL;DR: `lunacode init` を実行すると `.kairos/config.json` が作られます。
> それ以外のファイルは、対応機能を使ったタイミングで自動生成されます。
> Git 管理したいのは原則 **`config.json`, `model-settings.yml`, `hooks.json`, `skills/`** の 4 つだけです。

---

## ディレクトリツリー（全貌）

```text
<project>/
└── .kairos/
    ├── config.json              # ★ メイン設定（lunacode init で生成）
    ├── model-settings.yml       # モデルごとの tool calling / num_ctx 設定（任意）
    ├── hooks.json               # ライフサイクルフック定義（任意）
    │
    ├── MEMORY.md                # コアメモリ（人間可読）
    ├── topics/                  # トピック別メモリ
    │   └── <topic>.md
    ├── logs/                    # 実行ログ（メモリ系 + pino ファイル出力）
    │   └── <YYYY-MM-DD>.log
    │
    ├── dreams/                  # ドリームモードのログ
    │   └── dream_<ISO8601>.log
    ├── dream_time.json          # 最後にドリームが走った時刻
    ├── sessions.json            # セッションカウンタ（デーモン用）
    ├── activity.json            # 最後のユーザアクティビティ時刻
    │
    ├── daemon.pid               # デーモン PID（起動中のみ）
    ├── buddy_state.json         # Buddy Mode の状態
    │
    ├── skills/                  # ローカルスキル定義
    │   └── <skill-name>/
    │       ├── skill.json
    │       ├── SKILL.md
    │       └── tools.ts         # 任意
    │
    ├── sandbox/                 # SandboxEnvironment 作業領域 + Tier 1 workspace 分離
    │   ├── temp/
    │   ├── workspace/           # ★ Tier 1: タスクごとの隔離コピー (<taskId>/)
    │   ├── logs/
    │   └── cache/
    │
    └── test-report-<provider>-<ts>.json   # `lunacode test-provider --save` の出力
```

---

## ファイル・ディレクトリ一覧

凡例:

- **種類**: `user` = 人間が編集するファイル / `runtime` = プログラムが書き出す状態ファイル / `mixed` = 両方あり得る
- **git**: `✓` = コミット推奨 / `✗` = `.gitignore` 推奨 / `?` = 用途次第

| パス                       | 種類    | git | 書式         | 管理モジュール            | 用途                                                                                                               |
| -------------------------- | ------- | --- | ------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `config.json`              | user    | ✓   | JSON         | `ConfigManager`           | メイン設定（LLM / agent / memory / daemon / checkpoint / approval / mcp / autoGit / selfEval / routing / logging） |
| `model-settings.yml`       | user    | ✓   | YAML         | `ModelSettingsRegistry`   | モデルごとの `native_tools` / `edit_format` / `num_ctx` を宣言的に上書き                                           |
| `hooks.json`               | user    | ✓   | JSON         | `FileHookLoader`          | ツール実行前後に走るシェルコマンド                                                                                 |
| `MEMORY.md`                | mixed   | ?   | Markdown     | `MemorySystem`            | 人間可読なコアメモリ（自動圧縮あり）                                                                               |
| `topics/<topic>.md`        | runtime | ?   | Markdown     | `MemorySystem`            | トピック別メモリ（自動抽出・更新）                                                                                 |
| `logs/<date>.log`          | runtime | ✗   | plain text   | `MemorySystem` / `Logger` | 実行ログ。`logging.file` を指定すると pino もここに書く                                                            |
| `dreams/dream_*.log`       | runtime | ✗   | Markdown     | `AutoDream`               | ドリームモード（記憶統合）の実行ログ                                                                               |
| `dream_time.json`          | runtime | ✗   | JSON         | `KAIROSDaemon`            | `{ "lastDream": <epoch-ms> }`                                                                                      |
| `sessions.json`            | runtime | ✗   | JSON         | `KAIROSDaemon`            | `{ "sessionCount": number }`                                                                                       |
| `activity.json`            | runtime | ✗   | JSON         | `KAIROSDaemon`            | `{ "lastActivity": <epoch-ms> }`                                                                                   |
| `daemon.pid`               | runtime | ✗   | plain text   | `KAIROSDaemon`            | 起動中のデーモン PID（停止時に削除）                                                                               |
| `buddy_state.json`         | runtime | ✗   | JSON         | `BuddyMode`               | Buddy の名前・感情・エネルギーなど                                                                                 |
| `skills/<name>/skill.json` | user    | ✓   | JSON         | `SkillLoader`             | スキルマニフェスト（name, version, triggers）                                                                      |
| `skills/<name>/SKILL.md`   | user    | ✓   | Markdown     | `SkillLoader`             | LLM に注入する指示書                                                                                               |
| `skills/<name>/tools.ts`   | user    | ✓   | TypeScript   | `SkillLoader`             | スキル固有の追加ツール（任意）                                                                                     |
| `sandbox/`                 | runtime | ✗   | ディレクトリ | `SandboxEnvironment`      | サンドボックス実行の作業領域                                                                                       |
| `test-report-*.json`       | runtime | ✗   | JSON         | `ProviderTester`          | `lunacode test-provider --save` の出力                                                                             |

---

## 1. 設定ファイル（ユーザ編集）

### `config.json`

LunaCode の **メイン設定ファイル**。`lunacode init` で雛形が生成されます。

扱うセクション（`src/config/ConfigManager.ts` の `LunaCodeConfig` 参照）:

- `llm` — 使用プロバイダと接続情報（openai / ollama / lmstudio / litellm / zai）
- `agent` — `maxIterations`, `timeout`
- `memory` — `enabled`, `maxTokens`
- `daemon` — `enabled`, `tickIntervalSeconds`
- `checkpoint` — チェックポイント保存設定（Phase 5）
- `approval` — ツール承認フロー（Phase 6）
- `mcp` — MCP サーバ設定（Phase 9）
- `autoGit` — 自動 Git ワークフロー（commit / test / PR）
- `selfEval` — 自己評価ループ（Phase 14）
- `routing` — タスク種別ごとのモデルルーティング（Phase 15）
- `logging` — pino の `level` / `json` / `file`
- `validation` — `write_file` / `edit_file` の post-write 構文チェック（詳細は [`docs/VALIDATION.md`](./VALIDATION.md)）
- `sandbox` — 作業ツリー分離（Tier 1 / 詳細は [`docs/SANDBOX.md`](./SANDBOX.md)）

文字列値の中では `${ENV_VAR}` / `$ENV_VAR` が **環境変数展開** されます（未定義ならそのまま）。

読み書きには CLI を使うのがおすすめです:

```sh
lunacode config show
lunacode config set llm.provider ollama
lunacode config models
```

### `model-settings.yml`

**Phase 22（旧 Phase 9）で追加された、Aider 相当のモデル設定レジストリ**。
プロバイダ × モデル glob ごとに以下を宣言します:

- `native_tools` — ネイティブ tool calling を試みるか
- `edit_format` — 現状 `whole` のみ（将来 `diff` / `udiff` 予定）
- `num_ctx` — Ollama に送る context 長
- `extra_params` / `notes`

詳細とトラブルシュート手順は [`docs/MODEL_SETTINGS.md`](./MODEL_SETTINGS.md) を参照してください。

`.kairos/model-settings.yml` が **最優先** で、その下は `<repo>/.kairos/model-settings.yml` → `~/.kairos/model-settings.yml` → 同梱デフォルトの順でフォールバックします。

### `hooks.json`

ツール実行前後などに外部コマンドを走らせる **ライフサイクルフック**。
`FileHookLoader` が起動時に読み込み、`HookManager` に登録します。

```json
{
  "hooks": [
    {
      "name": "format-on-save",
      "event": "post_tool",
      "condition": {
        "toolName": ["write_file", "edit_file"],
        "filePattern": "*.ts"
      },
      "command": "./node_modules/.bin/prettier --write ${file}",
      "priority": 10
    }
  ]
}
```

- `event`: `pre_tool` / `post_tool` / `pre_agent` / `post_agent` など（`HookEvent` 型参照）
- `condition.toolName` は配列一致、`filePattern` は現状 `*.<ext>` サフィックス一致のみ
- `command` は 30 秒タイムアウトで `exec` 実行、`cwd` はプロジェクトルート
- 変数展開は `interpolate()` が担当（`${file}` などツールコンテキスト変数）

---

## 2. メモリ関連（MemorySystem が管理）

`MemorySystem(basePath=".kairos")` として構築されるため、以下は全て `.kairos/` 直下に出ます。

### `MEMORY.md`

3 層メモリ構造のうちの **コアメモリ（中期記憶）**。
初期化時にヘッダのみのファイルが作られ、`MicroCompact` / `MesoCompact` によって自動圧縮されます。
**人間が直接編集しても構いません** が、圧縮で上書きされうる点に注意。

### `topics/<topic>.md`

コンテキストから抽出されたトピック別メモリ。`AutoDream` や `MemorySystem.extractTopics()` が自動で作成・更新します。

### `logs/<YYYY-MM-DD>.log`

メモリ層のログ（`appendToLog()`）。さらに `config.logging.file` に `.kairos/logs/app.log` のようなパスを指定すると、pino の出力先としても使われます（`{ mkdir: true }` 相当）。

---

## 3. デーモン・ドリームモード関連

### `daemon.pid`

`KAIROSDaemon.start()` が自プロセスの PID を書き込みます。`stop` 時に削除。
他プロセスから起動済みかどうかの検出にも使います。

### `activity.json`

```json
{ "lastActivity": 1723000000000 }
```

アイドル検出（一定時間ユーザ操作が無いとドリームに入る）に使用。

### `sessions.json`

```json
{ "sessionCount": 7 }
```

前回ドリーム以降のセッション数。一定値を超えるとドリームが発火。

### `dream_time.json`

```json
{ "lastDream": 1723000000000 }
```

最後にドリームが完了した時刻。`consolidationIntervalHours` の判定に使用。

### `dreams/dream_<ISO>.log`

`AutoDream.logDream()` が 1 回の実行ごとに Markdown ログを書き出します。
ファイル名は `dream_2026-04-17T12-34-56-789Z.log` のような形式。
`lunacode dream history` が新しい順に 10 件まで表示します。

---

## 4. Buddy Mode

### `buddy_state.json`

`BuddyMode` の永続化。`name` / `type` / `emotion` / `energy` などが含まれます。
`lunacode buddy <call|pet|feed|play|sleep>` を叩くたびに更新されます。
未初期化時は `buddy info` で作られます。

---

## 5. スキル（`skills/<name>/`）

ローカル定義の LunaCode スキル。`SkillLoader` が起動時に全サブディレクトリを走査します。

必須:

- `SKILL.md` — LLM に注入する指示書。これがあれば最低限スキルとして扱われます。

任意:

- `skill.json` — マニフェスト（無い場合はディレクトリ名で暫定作成）

  ```json
  {
    "name": "pdf",
    "version": "0.1.0",
    "description": "PDF processing skill",
    "triggers": ["pdf", "PDF", ".pdf"]
  }
  ```

- `tools.ts` — スキル固有の追加ツール定義（SkillLoader が型チェックして読み込み）

チームで共有したいスキルは Git 管理対象にし、マシンローカルだけで使うスキルは `~/.kairos/skills/` に置くと棲み分けできます（将来対応予定）。

---

## 6. サンドボックス（`sandbox/`）

`SandboxEnvironment` と `WorkspaceIsolator` が共有する作業領域です。

```text
.kairos/sandbox/
├── temp/                    # 一時ファイル
├── workspace/               # Tier 1: タスクごとの隔離コピー
│   └── <taskId>/            #   ← agent が chdir する本番作業ディレクトリ
├── logs/                    # サンドボックス実行ログ
└── cache/                   # キャッシュ
```

用途は大きく 2 つ:

1. **`SandboxEnvironment` (Tier 0)** — 危険なシェルコマンドの allowlist/timeout/memoryLimit 実行。
2. **`WorkspaceIsolator` (Tier 1)** — LLM の編集から origin を守るための作業ツリー分離。
   `config.json` の `sandbox.tier = "workspace"` で有効化し、各タスクごとに
   `workspace/<taskId>/` が作られて agent が chdir します。詳細は [`docs/SANDBOX.md`](./SANDBOX.md)。

いずれも **`.gitignore` 推奨**（ランタイム専用領域）。

---

## 7. プロバイダテスト

### `test-report-<provider>-<timestamp>.json`

`lunacode test-provider --save [--output <path>]` の出力。
`ProviderTester.saveReport()` が JSON で書き出します。
現在のプロバイダ・モデルで各ツールが正しく動くかの回帰チェック結果を含みます。

---

## 推奨 `.gitignore`

最低限これだけ書けば OK:

```gitignore
# LunaCode runtime state — commit /config & /skills only
.kairos/*
!.kairos/config.json
!.kairos/model-settings.yml
!.kairos/hooks.json
!.kairos/skills/
.kairos/skills/*/node_modules/
```

`MEMORY.md` と `topics/` は **チームで共有するかどうかで判断** してください（個人利用なら `.gitignore` 推奨）。

---

## 解決順（重要）

LunaCode の設定ファイルは「`.kairos/` を含むディレクトリ」を複数段で探します。
**上にあるほど優先** です。

| 階層 | パス                                                     | 用途                     |
| ---- | -------------------------------------------------------- | ------------------------ |
| 1    | `<cwd>/.kairos/`                                         | カレントディレクトリ固有 |
| 2    | `<repo-root>/.kairos/`                                   | リポジトリ共通           |
| 3    | `~/.kairos/`                                             | マシン全体               |
| 4    | 同梱デフォルト（`src/providers/model-settings.yaml` 等） | LunaCode 組み込み        |

`config.json` は現状 1 のみ。`model-settings.yml` は 1〜4 全てで探索されます。

---

## 参考

- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — 内部アーキテクチャ全体像
- [`docs/MODEL_SETTINGS.md`](./MODEL_SETTINGS.md) — `model-settings.yml` の書き方
- [`docs/ADD_PROVIDER.md`](./ADD_PROVIDER.md) — 新規プロバイダの追加
- [`docs/USER_GUIDE.md`](./USER_GUIDE.md) — エンドユーザ向け使い方
- [`docs/SANDBOX.md`](./SANDBOX.md) — 作業ツリー分離 (Tier 1) の詳細
- [`docs/VALIDATION.md`](./VALIDATION.md) — write/edit 後の構文チェック
- `src/config/ConfigManager.ts` — `config.json` のスキーマ定義
- `src/providers/ModelSettingsRegistry.ts` — 同梱デフォルトと解決ロジック
