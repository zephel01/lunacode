# 構文チェック (Post-Write Validation)

`write_file` / `edit_file` / `multi_file_edit` は書き込み成功後に対象ファイルの **構文チェック** を走らせ、失敗した場合はツール応答に警告ブロックを付け足します。

設計方針:

- **ツール自体は常に `success: true`** を返す。ファイルは保存されている。
- 警告は ReAct ループの observation に含まれるので、次イテレーションで LLM が自発的に修正できる。
- 外部コマンド（node / bun / tsc / python3）が PATH に無い場合は **黙ってスキップ** する（毎回うるさい警告を出さない）。

---

## 対応言語

| 拡張子                             | バリデータ                                              | 外部コマンド |
| ---------------------------------- | ------------------------------------------------------- | ------------ |
| `.json`                            | `JSON.parse`（組み込み）                                | 不要         |
| `.yml` / `.yaml`                   | `js-yaml`（組み込み）                                   | 不要         |
| `.js` / `.mjs` / `.cjs` / `.jsx`   | `node --check`                                          | `node`       |
| `.ts` / `.tsx`                     | `bun build --no-bundle` → fallback `tsc --noEmit`       | `bun` / `tsc` |
| `.py`                              | `python3 -c "import ast; ast.parse(...)"`               | `python3`    |

未対応の拡張子は何もしません。

---

## 警告フォーマット

```text
Successfully wrote src/app.ts [verified: 1234 bytes on disk]

⚠️ Syntax check failed (bun build --no-bundle):
src/app.ts:5:12: ERROR: Unexpected token ')'
```

長い stderr は 1500 文字で `...(truncated)` として丸められます。

---

## `.kairos/config.json` での設定

全体は省略可能で、省略時はすべての言語チェックが有効です。

```json
{
  "validation": {
    "enabled": true,
    "postWrite": true,
    "languages": {
      "json": true,
      "yaml": true,
      "javascript": true,
      "typescript": true,
      "python": true
    },
    "typescriptChecker": "auto"
  }
}
```

| フィールド          | 型                                           | 既定   | 説明                                                                      |
| ------------------- | -------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| `enabled`           | boolean                                      | `true` | 全言語を一括で ON/OFF                                                     |
| `postWrite`         | boolean                                      | `true` | `write_file` / `edit_file` 後のフック自体を ON/OFF                        |
| `languages.<lang>`  | boolean                                      | `true` | 言語別に ON/OFF。`json` / `yaml` / `javascript` / `typescript` / `python` |
| `typescriptChecker` | `"bun"` / `"tsc"` / `"auto"`                 | `auto` | TypeScript に使うチェッカー。`auto` は bun → tsc の順で試す               |

### よくある使い分け

#### すべて止めたい

```json
{ "validation": { "enabled": false } }
```

#### TypeScript の tsc だけ使いたい（bun build を避けたい）

```json
{ "validation": { "typescriptChecker": "tsc" } }
```

#### Python だけ無効化したい（CI 用イメージに python が無い等）

```json
{ "validation": { "languages": { "python": false } } }
```

---

## `hooks.json` での拡張

組み込みチェッカーと **併用** で、言語固有のリンタ / 型チェッカーを走らせたい場合は
`post_tool` フックを使います（詳細は [`docs/KAIROS_DIRECTORY.md`](./KAIROS_DIRECTORY.md#hooks-json)）。

```json
{
  "hooks": [
    {
      "name": "eslint-after-write",
      "event": "post_tool",
      "condition": {
        "toolName": ["write_file", "edit_file"],
        "filePattern": "*.ts"
      },
      "command": "./node_modules/.bin/eslint ${file}",
      "priority": 20
    }
  ]
}
```

組み込みチェックはあくまで **構文レベル** の最低限の保証です。型エラーや lint 違反は hooks.json でチームルールに合わせて追加してください。

---

## 内部実装

- モジュール: `src/tools/SyntaxValidator.ts`
- 設定シングルトン: `setValidationConfig(config)` を `AgentLoop.initialize()` で呼ぶ
- エントリポイント: `validateSyntax(filePath, content): Promise<ValidationResult>`
- 警告整形: `formatValidationWarning(result): string`

`spawn({ shell: false, timeout: 10_000 })` で外部コマンドを呼び、`ENOENT` は黙ってスキップ。例外を投げず、呼び出し側のフロー（書き込み成功）を壊しません。

テスト:

- `tests/syntax-validator.test.ts` — 言語検出・JSON/YAML 成功失敗・設定・整形
- `tests/basic-tools-validation.test.ts` — `FileWriteTool` / `FileEditTool` / `MultiFileEditTool` 統合
