# サンドボックス (Workspace Isolation)

LunaCode は LLM が生成したコードを **ユーザのローカルマシンで直接編集・実行** するため、
`rm -rf` の誤発火・`git reset --hard` の事故・`node_modules` の破壊といった "事故" で
作業が失われる可能性があります。

サンドボックス機能は、エージェントの作業ツリーを本体プロジェクトから **物理的に分離**
することで、これらを防ぐためのものです。

現在の実装は **Tier 1（作業ツリーの分離）** までで、Tier 2 (コンテナ) と Tier 3
(OS ネイティブサンドボックス) は将来拡張として予約されています。

---

## 1. どう動くか

サンドボックスを有効にすると、`AgentLoop.initialize()` の中で以下が自動で行われます:

1. `.kairos/sandbox/workspace/<taskId>/` にプロジェクトの隔離コピーを作成
2. プロセスの作業ディレクトリ (`process.cwd()`) をそのコピー先に切り替え
   （`workspace.chdirOnActivate: false` なら chdir を省略し、`AgentLoop.basePath`
   経由で伝播。Phase 25 で追加）
3. 以降の `write_file` / `edit_file` / `bash` などは全て workspace 内で完結
4. タスク終了時、変更を `diff()` で確認し、必要なら `merge()` で本体へ反映

これにより、エージェントが何をしても **origin（本体プロジェクト）側のファイルは
一切変更されません**。

---

## 2. 有効化

`.kairos/config.json` に以下を追加します。

```json
{
  "sandbox": {
    "tier": "workspace",
    "workspace": {
      "strategy": "auto"
    }
  }
}
```

`workspace.enabled: true` だけでも同義です。

```json
{
  "sandbox": {
    "workspace": { "enabled": true }
  }
}
```

---

## 3. ストラテジー

隔離コピーの作り方は 4 種類あり、`strategy: "auto"` なら以下の順で試されます。

| strategy       | 条件                                       | 起動コスト    | 備考                                  |
| -------------- | ------------------------------------------ | ------------- | ------------------------------------- |
| `apfs-clone`   | macOS かつ APFS (`cp -cR` 成功)            | 〜10ms (O(1)) | Copy-on-Write。巨大リポジトリでも速い |
| `reflink`      | Linux btrfs/xfs (`cp --reflink=auto` 成功) | 〜10ms (O(1)) | 同上                                  |
| `git-worktree` | `.git/` が存在する (非 bare)               | 数百 ms       | HEAD ベースで新ブランチを生やす       |
| `copy`         | 常に可能 (ポータブル fallback)             | サイズ依存    | 実ファイルコピー。除外パターン必須    |

明示的に選ぶこともできます:

```json
{
  "sandbox": {
    "workspace": { "strategy": "copy" }
  }
}
```

---

## 4. 除外パターン

`copy` / `reflink` / `apfs-clone` で **コピーから除外される** パスです。
既定値は以下のとおりで、ユーザ設定は既定に **追加** されます（置き換えではない）。

```
node_modules
.kairos/sandbox     ← workspace 自身が origin 配下にあるため必須
dist
build
.venv
__pycache__
.pytest_cache
.next
.turbo
.cache
```

### 4.1 パターン構文（Phase 27 から gitignore 互換）

パターンは `.gitignore` とほぼ同じセマンティクスで評価されます（実装は
`src/sandbox/patternMatch.ts`）。

| 記法              | 意味                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| `foo`             | 任意深さの `foo` (basename 一致)                                     |
| `/foo`            | origin 直下の `foo` のみ (anchored)                                  |
| `foo/`            | ディレクトリ `foo` のみマッチ (末尾 `/` で dirOnly)                  |
| `*.log`           | `/` を跨がない任意文字列 + `.log`                                    |
| `?`               | `/` 以外の 1 文字                                                    |
| `**`              | 任意深さ (globstar)                                                  |
| `**/foo.txt`      | 任意ディレクトリ直下の `foo.txt`                                     |
| `dist/**`         | `dist/` サブツリー全体                                               |
| `a/**/z`          | `a/z`、`a/b/z`、`a/b/c/z` …                                          |
| `!keep.log`       | 先行パターンが除外したエントリを復活させる（gitignore 互換）         |

> **非対応**: 文字クラス `[abc]` / 否定クラス `[^a]` / brace expansion `{a,b}` は
> サポートしません。必要なら明示的に展開してください。

`matchAny()` は「最後にマッチしたパターンの極性が勝つ」gitignore 仕様で判定します。
否定を効かせたい場合、通常パターンの **後に** 否定パターンを置いてください。

### 4.2 `.gitignore` 自動取り込み

`workspace.respectGitignore`（既定 `true`、Phase 27 追加）が有効な場合、
`origin/.gitignore` の内容が自動で `excludePatterns` に合流します。マージ順は:

1. ユーザが `excludePatterns` で指定したもの
2. `origin/.gitignore` の内容（`respectGitignore: false` で無効化）
3. 組み込みの DEFAULT_EXCLUDE（`node_modules` 等）

サブディレクトリの `.gitignore` は再帰的には読み込みません（プロジェクト root の
1 枚のみ）。`negation` の効き目を確認したい場合は 4.1 の順序に注意してください。

### 4.3 設定例

```json
{
  "sandbox": {
    "workspace": {
      "excludePatterns": ["target", "out/**", "*.log", "!ci.log"],
      "respectGitignore": true
    }
  }
}
```

`git-worktree` は `.gitignore` + index の情報を使うため、`excludePatterns` は
作用しません。

---

## 5. ライフサイクル

| イベント                    | 挙動                                                               |
| --------------------------- | ------------------------------------------------------------------ |
| `initialize()`              | `WorkspaceIsolator.create()` で隔離コピーを作成、`process.chdir()` |
| ツール実行中                | すべて workspace 内で完結                                          |
| タスク成功                  | `merge({ dryRun: true })` で差分を提示（自動マージは既定 OFF）     |
| タスク失敗                  | `keepOnFailure: true`（既定）なら workspace を保持してデバッグ可能 |
| `disposeSandboxWorkspace()` | 必要に応じて merge → cleanup                                       |

明示的に別の taskId を使う、あるいは `keepOnFailure: false` にすると、失敗時に
即座に workspace が消えます。

---

## 6. 設定リファレンス

```json
{
  "sandbox": {
    "tier": "workspace",
    "workspace": {
      "enabled": true,
      "strategy": "auto",
      "basePath": ".kairos/sandbox/workspace",
      "autoMerge": false,
      "keepOnFailure": true,
      "excludePatterns": ["target"],
      "respectGitignore": true,
      "chdirOnActivate": true
    }
  }
}
```

| フィールド                    | 型                           | 既定                        | 説明                                                                                 |
| ----------------------------- | ---------------------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| `tier`                        | `"none"` \| `"workspace"` 等 | `"none"`                    | `"workspace"` で Tier 1 を有効化                                                     |
| `workspace.enabled`           | boolean                      | `tier` による               | `tier` の代わりにこれでも有効化できる                                                |
| `workspace.strategy`          | `"auto"` \| 各ストラテジー名 | `"auto"`                    | 使用する隔離方式                                                                     |
| `workspace.basePath`          | string                       | `.kairos/sandbox/workspace` | workspace 作成先（origin 相対 or 絶対）                                              |
| `workspace.autoMerge`         | boolean                      | `false`                     | 成功時に自動で本体に書き戻す（現状は要注意）                                         |
| `workspace.keepOnFailure`     | boolean                      | `true`                      | 失敗時に workspace を残してデバッグ可能にする                                        |
| `workspace.excludePatterns`   | string[]                     | 上記既定                    | gitignore 互換 glob パターン。ユーザ指定は `.gitignore` / 既定に「追加」される       |
| `workspace.respectGitignore`  | boolean                      | `true`                      | `origin/.gitignore` を自動で取り込むか（Phase 27 追加）                              |
| `workspace.chdirOnActivate`   | boolean                      | `true`                      | workspace 作成時に `process.chdir()` を呼ぶか。`false` なら cwd を変えず basePath 伝播 |

---

## 7. プログラムからの利用

CLI は将来（Phase 1.6）追加予定ですが、現状は API として直接呼び出せます。

```ts
import { WorkspaceIsolator } from "lunacode/sandbox";

const ws = await WorkspaceIsolator.create({
  origin: process.cwd(),
  taskId: "scratch-1",
  config: { strategy: "copy" },
});

// ws.path 以下で自由に編集...
await fs.writeFile(path.join(ws.path, "hello.ts"), 'console.log("hi")');

// 差分プレビュー
console.log(await ws.diff());

// 本体へ適用（dryRun で安全確認）
await ws.merge({ dryRun: true });

// 後始末
await ws.cleanup();
```

---

## 8. 制約と既知の落とし穴

- **origin の中に workspace がある**: 既定では `.kairos/sandbox/workspace/<id>/` が origin 配下に
  あるため、`copy` ストラテジーは自己再帰を避ける必要があります。実装側で skip していますが、
  `basePath` を origin 外に指定することも可能です。
- **シンボリックリンク**: `copy` は symlink をリンクとして複製します。リンク先が origin 外を指す
  場合、workspace からも同じ実体を指します（共有）。
- **巨大な `node_modules`**: `copy` で除外していても、誤って外してしまうと OS レベルで
  遅延の原因になります。`apfs-clone` / `reflink` / `git-worktree` 推奨。
- **`git-worktree` + dirty index**: HEAD 以外の変更（staged/unstaged）は workspace には入りません。
  この制約は将来 `--detach` オプションなどで緩和予定。
- **自動マージは実験的**: `autoMerge: true` は現状 origin を直接上書きするため、
  Git の管理下でないファイルの扱いに注意してください。

---

## 9. Tier 2 / Tier 3（将来）

Tier 1 は "作業ツリーが独立" なだけで、ネットワーク・ファイル外アクセス・シグナルは
制約していません。より強い分離が必要な場合は将来以下を追加予定です。

- **Tier 2**: Docker / Podman コンテナ。`--network=none` + `--read-only` + tmpfs。
- **Tier 3**: macOS `sandbox-exec` / Linux `bwrap` によるカーネル機能での分離。

Tier 2 / Tier 3 のスコープと導入時期は [`ROADMAP.md`](../ROADMAP.md) の「進行中・計画中」を参照してください。

---

## 9.5 CLI サブコマンド（Phase 26）

残存 workspace の確認・整理用に `lunacode sandbox` サブコマンドが用意されている。
`AgentLoop` が正常終了した場合は workspace が自動で片付くが、異常終了・`keepOnFailure` が `true`・
手動 kill などで残るケースがあるので、その運用窓口。

### 9.5.1 コマンド一覧

| コマンド | 役割 |
|----------|------|
| `lunacode sandbox list` | workspace を列挙（テーブル。`--json` で機械可読） |
| `lunacode sandbox diff <taskId>` | workspace と origin の差分を表示（`--only <paths...>` で対象絞り込み） |
| `lunacode sandbox merge <taskId>` | workspace → origin にマージ。**既定 dry-run**、実反映は `--apply` を付ける |
| `lunacode sandbox clean [<taskId>]` | workspace を削除。`--all` / `--older-than <days>` / `--dry-run` / `--yes` を受け付ける |

すべて `process.cwd()` を origin として解釈するので、プロジェクトルートで実行する前提。

### 9.5.2 使用例

```bash
# 残っている workspace を確認
$ lunacode sandbox list
📦 Sandbox workspaces (2)

TASK ID         SIZE     AGE   CREATED              STRATEGY
--------------  -------  ----  -------------------  ----------
session_abc123  12.4 MB  2h    2026-04-19 10:15:02  copy-like
session_def456  8.1 MB   1d    2026-04-18 09:03:41  git-worktree

  basePath: /path/to/project/.kairos/sandbox/workspace

# 差分を確認
$ lunacode sandbox diff session_abc123
M src/foo.ts
A src/bar.ts

# 一回 dry-run して、問題なければ apply
$ lunacode sandbox merge session_abc123
🔍 Dry-run merge preview for session_abc123 (pass --apply to actually merge)

  applied    : 2
  conflicted : 0
  skipped    : 0

$ lunacode sandbox merge session_abc123 --apply

# 古いものだけ掃除
$ lunacode sandbox clean --older-than 7 --yes

# 全消し
$ lunacode sandbox clean --all
About to delete 2 workspace(s):
  - session_abc123  (12.4 MB)  /path/.../session_abc123
  - session_def456  (8.1 MB)   /path/.../session_def456

Proceed? [y/N]
```

### 9.5.3 注意

- `merge --apply` は既存ファイルを上書きする。心配なら `--only <paths...>` で対象を
  絞るか、先に `git commit` / `git stash` しておくこと。
- `clean` に `--dry-run` を付ければ削除候補だけ表示して実際には消さない。
- 実装は `src/sandbox/cli.ts`。`WorkspaceIsolator.open()` 経由で diff / merge を呼ぶので、
  Phase 25 の堅牢化（mtime fast-path 削除、size 一致時も内容比較）の恩恵をそのまま受ける。

---

## 10. トラブルシュート

**Q. `Cannot create workspace: destination already exists` と言われる**

同じ `taskId` で workspace を二度作ろうとしています。`keepOnFailure: true` のまま前回失敗した
workspace が残っている可能性があるので、`.kairos/sandbox/workspace/` 配下を手動で消すか、
別の taskId を使ってください。

**Q. `strategy: "apfs-clone"` にしたのに `copy` にフォールバックする**

対象ディレクトリが APFS ではない（外付け HDD・tmpfs など）可能性があります。
`diskutil info <path>` で確認してください。`auto` なら自動で `copy` に落ちます。

**Q. workspace が大きすぎる**

既定の除外に漏れているディレクトリがあります。`excludePatterns` に追加するか、
Node/Rust のように CoW が効く FS なら `strategy: "apfs-clone"` / `reflink` を使ってください。

---

## 11. 旧 `SandboxEnvironment` について（Phase 27 で削除）

`src/security/SandboxEnvironment.ts` にはかつて別系統のサンドボックス実装がありました
（Phase 4.2 由来）。Phase 25 (2026-04-19) で `@deprecated` 化し、**Phase 27 で物理削除**
しました（以下の理由で、セキュリティ機能として実効性が乏しかったため）:

- ルール判定が `command.includes(pattern)` のみ。`rm  -rf /`（二重空白）、
  `/bin/rm -rf /`、`$(echo rm) -rf /` 等で容易にバイパス可能
- `allow` ルールは評価されておらず `deny` のみチェック
- `maxExecutionTime` は `console.warn` するだけでプロセスを殺さない
- `allowNetwork` / `maxMemoryUsage` は設定を受け取るのみで何も強制しない
- 「サンドボックス」を謳っているが実体は `cwd` 変更と環境変数追加のみ

作業ツリー分離は本ドキュメントで説明する `WorkspaceIsolator`（Tier 1）を使用して
ください。プロセスレベルの隔離が必要な場合は、今後追加予定の Tier 2 / Tier 3 を
待ってください。

---

## 関連ドキュメント

- [`VALIDATION.md`](./VALIDATION.md) — 構文チェック（サンドボックスとは別系統の safety）
- [`KAIROS_DIRECTORY.md`](./KAIROS_DIRECTORY.md) — `.kairos/` 配下の構造
- [`ROADMAP.md`](../ROADMAP.md) — 進行中・計画中の Tier 2 / Tier 3 サンドボックス
