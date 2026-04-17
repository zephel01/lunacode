# モデル設定（Model Settings）

LunaCode はモデルごとに **Tool Calling を使うかどうか** や **`num_ctx` の既定値** などを、YAML ファイルで宣言的に管理します。Aider の `model-settings.yml` 相当です。

> 新しいモデルを使ったら「ファイルが書き込まれない」「空応答でループする」などの不具合に遭遇した場合、このドキュメントに従って 1 行エントリを足すだけで動くようになるケースがほとんどです。

---

## どこに書くか

以下のいずれかに YAML ファイルを置いてください。上にあるほど優先されます。
`lunacode init` が `.kairos/config.json` を作るので、その隣に `model-settings.yml` を
並べるのが最もシンプルな運用です（`.kairos/` ディレクトリ全体の仕様は
[`docs/KAIROS_DIRECTORY.md`](./KAIROS_DIRECTORY.md) を参照）。

| #   | パス                                | 用途                                                                                       |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | `<cwd>/.kairos/model-settings.yml`  | カレントディレクトリ固有。`lunacode init` で作った `.kairos/` と同じ場所で、もっとも一般的 |
| 2   | `<repo>/.kairos/model-settings.yml` | リポジトリ固有（チームで共有する）。cwd と異なる場合のみ読まれる                           |
| 3   | `~/.kairos/model-settings.yml`      | マシン全体で効かせたいときのユーザ設定                                                     |
| 4   | `src/providers/model-settings.yaml` | 同梱デフォルト（触らない）                                                                 |

優先ルール:

- **最初にマッチしたエントリ** が採用されます（glob 先頭マッチ、Aider と同じ方式）。
- 上位ファイルで書いたエントリは、下位ファイルの同名モデルより **必ず優先** されます。
- 書式はどの階層でも同じです。

---

## 書式

```yaml
# ~/.kairos/model-settings.yml
version: 1
models:
  # 例: 新しく入れた Qwen 量子化モデルが tool calling で詰まる場合
  - match: "ollama/qwen3.7:*"
    native_tools: false # tools パラメータを送らない
    edit_format: whole # whole-format（ファイル名付きコードブロック）で解釈
    num_ctx: 16384
    notes: "Q4 量子化は tool calling 不安定"

  # 例: 逆に同梱デフォルトで disable されているが、実機では動く場合
  - match: "ollama/qwen3.6:*-fp16"
    native_tools: true
    edit_format: whole
    num_ctx: 32768
```

フィールド:

| フィールド     | 型             | 説明                                                                                                 |
| -------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `match`        | string         | `"<provider>/<model-glob>"` 形式。`*` は任意文字列（`/` も含む）。大文字小文字無視                   |
| `native_tools` | boolean        | `true` ならネイティブ tool calling を試みる。`false` なら tools パラメータを送らず whole-format のみ |
| `edit_format`  | `"whole"`      | 現状は whole のみサポート（将来 `diff` / `udiff` を追加予定）                                        |
| `num_ctx`      | number \| null | Ollama に送る num_ctx。`null` は送信しない。省略時も送信しない                                       |
| `extra_params` | object         | プロバイダ素通しの追加パラメータ（将来拡張）                                                         |
| `notes`        | string         | ログに出る自由記述メモ（運用向け）                                                                   |

対応プロバイダ prefix: `ollama` / `lmstudio` / `openai` / `anthropic` / `zai`。

---

## 対応状況の自動チェック（`test-provider --check-model`）

「このモデルはネイティブ tool calling が通るのか？ registry の宣言は合っているのか？」
を確認したいときは、1 コマンドで判定できます。

```sh
lunacode test-provider --check-model
```

出力例:

```text
══════════════════════════════════════════════════════════════════════
  🔍 Model Compatibility Check
══════════════════════════════════════════════════════════════════════
  Provider  : ollama
  Model     : qwen2.5-coder:7b
  Duration  : 1.24s
──────────────────────────────────────────────────────────────────────
  📋 Registry Declaration
     match         : ollama/qwen2.5-coder*
     native_tools  : true
     edit_format   : whole
     num_ctx       : 32768
     notes         : Qwen2.5-Coder は tool calling 対応
──────────────────────────────────────────────────────────────────────
  🧪 Native Tool Calling Probe
     result        : ✅ tool_calls returned (1)
──────────────────────────────────────────────────────────────────────
  Verdict       : ✅ SUPPORTED
  Summary       : native tool calling が動作し、registry の宣言と一致 (1 tool call(s))
══════════════════════════════════════════════════════════════════════
```

registry と実機が乖離している場合は `⚠️ NEEDS TUNING` が出て、
そのまま貼り付けられる `model-settings.yml` パッチも提案されます:

```text
  💡 Suggested model-settings.yml patch:

     - match: "ollama/my-new-model:7b"
       native_tools: false
       edit_format: whole
       num_ctx: 16384
       notes: "実機で tool calling 非対応を確認 (test-provider --check-model)"
```

終了コード: `0`=supported / `2`=needs_tuning / `1`=unsupported or unknown。
CI で新モデル追加時のスモークテストにも流用できます。

> 現状は **今設定されているモデル 1 つ** に対するチェックです。
> 複数モデルの一括チェックは未実装（将来 `--check-unregistered` で
> builtin に無いモデルだけ自動で回す予定）。

---

## 困ったときの切り分け手順

LunaCode 起動時には以下のような info ログが 1 度だけ出ます。

```text
[OllamaProvider] モデル設定を解決しました（~/.kairos/model-settings.yml で上書き可）
  model="qwen3.6:35b-a3b-q4_K_M"
  match="ollama/qwen3.6*a3b*"
  native_tools=false
  edit_format="whole"
  num_ctx=16384
```

このログの `match` を見れば、**どのエントリが採用されたか** が分かります。
そのエントリを `~/.kairos/model-settings.yml` で同じ `match` を書いて上書きしてください。

### ケース別クックブック

#### ケース A: 新しいモデルで「何も書き込まれない / 空応答」になる

多くは **Tool Calling に失敗** しています。`~/.kairos/model-settings.yml` に以下を追加:

```yaml
version: 1
models:
  - match: "ollama/<your-model-prefix>*"
    native_tools: false
    edit_format: whole
    num_ctx: 16384
```

#### ケース B: デフォルトで無効化されたが実際は tool calling が動く

```yaml
version: 1
models:
  - match: "ollama/<your-model-name>" # * を使わず完全一致で最優先に
    native_tools: true
    edit_format: whole
    num_ctx: 32768
```

#### ケース C: 応答が途中で切れる（num_ctx 不足）

```yaml
version: 1
models:
  - match: "ollama/<your-model-prefix>*"
    native_tools: true
    edit_format: whole
    num_ctx: 65536 # モデルの context length まで上げる
```

---

## 環境変数（deprecated）

以下の環境変数は後方互換で **いまも効きます** が、新規では使わないでください。
起動時に 1 度だけ deprecation warning が出ます。

| 環境変数                                          | 動作                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| `LUNACODE_OLLAMA_DISABLE_TOOLS=1`                 | レジストリ内の全 Ollama エントリの `native_tools` を false に強制 |
| `LUNACODE_OLLAMA_NO_TOOLS_MODELS="qwen3.6,gemma"` | substring マッチした Ollama エントリだけ `native_tools: false`    |
| `LUNACODE_OLLAMA_NUM_CTX=16384`                   | 全 Ollama エントリの `num_ctx` を上書き                           |

これらは全てレジストリ層で適用されるため、ファイル設定と組み合わせても無矛盾に動きます。

---

## 同梱デフォルトのクイックリファレンス

| match                    | native_tools | num_ctx | 備考                            |
| ------------------------ | ------------ | ------- | ------------------------------- |
| `ollama/qwen3.6*a3b*`    | false        | 16384   | MoE Q4 量子化                   |
| `ollama/qwen3.5*`        | false        | 16384   | 小型量子化、tool calling 不安定 |
| `ollama/qwen2.5-coder*`  | true         | 32768   | Aider でも diff 推奨            |
| `ollama/qwen*`           | true         | 16384   |                                 |
| `ollama/gemma*`          | false        | 8192    | tool_call テンプレ生成が不安定  |
| `ollama/llama3.1*`       | true         | 8192    |                                 |
| `ollama/llama3*`         | true         | 8192    |                                 |
| `ollama/codellama*`      | false        | 16384   |                                 |
| `ollama/deepseek-coder*` | false        | 16384   |                                 |
| `ollama/mistral*`        | true         | 16384   |                                 |
| `ollama/*`               | true         | 8192    | Ollama 汎用フォールバック       |
| `lmstudio/*qwen3.6*`     | false        | —       |                                 |
| `lmstudio/*gemma*`       | false        | —       |                                 |
| `lmstudio/*`             | true         | —       |                                 |
| `openai/*`               | true         | null    |                                 |
| `anthropic/*`            | true         | null    |                                 |
| `zai/*`                  | true         | null    |                                 |
| `*/*`                    | true         | null    | 最終フォールバック              |

同梱デフォルトの厳密な定義は `src/providers/ModelSettingsRegistry.ts` の `BUILTIN_MODEL_SETTINGS` を参照してください（同じ内容が `src/providers/model-settings.yaml` にもユーザ向けテンプレートとして置かれています）。

---

## 将来の計画

- `edit_format: diff` / `udiff`（Aider 相当の SEARCH/REPLACE・unified diff 適用）
- ファジー edit 適用（完全一致 → 空白無視 → インデント保持 → difflib fuzzy）
- 学習型レジストリ（ランタイム検出結果を `~/.kairos/learned-models.json` に自動保存）
- architect mode（planner + editor 分離）

詳細は `docs/inside/plan.md` の Phase 22（旧 Phase 9）を参照してください。
