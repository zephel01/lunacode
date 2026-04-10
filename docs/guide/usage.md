# 使い方ガイド

LunaCode の基本操作とコマンドリファレンスです。

## 目次

- [基本的な使い方](#基本的な使い方)
- [コマンド一覧](#コマンド一覧)
  - [クエリ実行](#クエリ実行)
  - [プロバイダー管理](#プロバイダー管理)
  - [デーモン管理 (KAIROS)](#デーモン管理-kairos)
  - [ドリームモード (AutoDream)](#ドリームモード-autodream)
  - [メモリ管理](#メモリ管理)
  - [Buddy モード](#buddy-モード)
- [ツール一覧](#ツール一覧)
- [操作フロー](#操作フロー)

---

## 基本的な使い方

LunaCode は3つの動作モードから選べます:

### 1. 対話モード（推奨）— チャットしながら作業

```bash
lunacode          # または: lunacode chat
```

複数ステップのプロジェクト作成やリアルタイムのやり取りに最適。対話モード内で何度でも指示できます。

```
🌙 > JavaScript でテトリスを作成してください
🤖 テトリスの作成ですね... [回答]

🌙 > ゲームロジックから始めてください
🤖 ゲームボードの初期化... [実装開始]

🌙 > /exit
👋 Bye!
```

### 2. 自動実行モード — 自動でタスク完了まで

```bash
lunacode --auto "JavaScript でテトリスを作成"
lunacode --auto "REST API を Python で作成" --rounds 15
```

確認なしで自動的にツール実行・ファイル作成を行い、タスク完了まで続きます。

### 3. ワンショットモード — シンプルな質問

```bash
lunacode "Express で REST API を作成して"
lunacode "Python の学習順序は"
```

**LunaCode の思考プロセス — ReAct パターン:**

LunaCode は以下を繰り返します:

1. **考える (Thought)** — タスクの分析と次のアクションを決定
2. **行動する (Action)** — ツール（ファイル操作、コマンド実行等）を選択・実行
3. **観察する (Observation)** — ツールの結果を評価し、次のステップを判断

ツールコールが不要になるか、最大イテレーション数に到達すると、最終的な回答を返します。

---

## コマンド一覧

### クエリ実行

```bash
# 自然言語でタスクを依頼
lunacode "TypeScript で FizzBuzz 関数を作って"

# ファイル操作を含むタスク
lunacode "src/index.ts のエラーハンドリングを改善して"

# プロジェクト分析
lunacode "このプロジェクトの構造を説明して"
```

LLM が自動的にどのツールを使うべきかを判断します。直接ツールを指定する必要はありません。

### プロバイダー管理

```bash
# 現在のプロバイダー情報を表示
lunacode provider

# 接続テスト
lunacode test-provider
```

### デーモン管理 (KAIROS)

KAIROS デーモンは LunaCode をバックグラウンドで常駐させ、定期的なチェックやメモリ統合を自動実行します。

```bash
# デーモンを起動
lunacode daemon start

# プロバイダーを指定して起動
lunacode daemon start --provider openai

# 状態を確認
lunacode daemon status

# デーモンを停止
lunacode daemon stop

# 再起動
lunacode daemon restart

# ログを表示
lunacode daemon logs
```

デーモンは以下のタスクを60秒間隔で実行します:

- プロアクティブチェック（30分以上アイドルで発火）
- ドリームトリガー判定
- メモリ統合
- ヘルスチェック

### ドリームモード (AutoDream)

ドリームモードは、蓄積されたメモリとログを統合・整理する機能です。通常はデーモンのアイドル時に自動実行されますが、手動でも実行できます。

```bash
# ドリームを手動実行
lunacode dream run

# ドリーム履歴を表示
lunacode dream history

# ドリームの状態を確認
lunacode dream status
```

ドリームの処理内容:

1. ログの統合と要約
2. メモリ間の矛盾検出と解消（LLM を使用）
3. パターンやインサイトの抽出
4. メモリの圧縮と最適化

### メモリ管理

3層メモリシステムの状態確認と操作ができます。

```bash
# メモリ統計を表示
lunacode memory stats

# メモリを検索
lunacode memory search "API エンドポイント"

# メモリを手動圧縮
lunacode memory compact

# トピック一覧を表示
lunacode memory topics
```

メモリの3層構造:

| レイヤー | ファイル | 用途 |
|---|---|---|
| Layer 1 | `MEMORY.md` | メインメモリ（ポインタ + 重要情報） |
| Layer 2 | `topics/*.md` | トピック別の詳細情報 |
| Layer 3 | `logs/*.log` | 日付別の生ログ（grep 検索用） |

### Buddy モード

Buddy モードは、17種類のペットキャラクターと対話できるコンパニオンAI機能です。

```bash
# ペットの種類一覧
lunacode buddy types

# ペットを作成
lunacode buddy create --type cat --name タマ

# ペット情報を表示
lunacode buddy info

# ペットを呼ぶ
lunacode buddy call タマ

# ペットに話しかける
lunacode buddy talk "今日はいい天気だね"

# ペットを撫でる / 餌をあげる / 遊ぶ / 休ませる
lunacode buddy pet
lunacode buddy feed
lunacode buddy play
lunacode buddy sleep
```

対応ペットタイプ: cat, dog, rabbit, hamster, bird, fish, turtle, snake, lizard, frog, owl, fox, wolf, bear, penguin, dragon, hedgehog

各ペットには空腹度・エネルギー・幸福度のステートと、10種類の感情が設定されています。

---

## ツール一覧

エージェントが使用するコアツールの一覧です。

| ツール名 | 説明 | リスク |
|---|---|:---:|
| `bash` | シェルコマンドの実行。危険コマンドのフィルタリング付き | HIGH |
| `read_file` | ファイルの読み取り。行範囲の指定も可能 | LOW |
| `write_file` | ファイルへの書き込み（新規作成 or 上書き） | MEDIUM |
| `edit_file` | ファイル内の文字列置換。`old_string` → `new_string` | MEDIUM |
| `glob` | パターンマッチによるファイル検索 (fast-glob 使用) | LOW |
| `grep` | ファイル内容の正規表現検索 (ripgrep 使用) | LOW |
| `git` | Git コマンドの実行 (add, commit, diff, log 等) | MEDIUM |

ツールはリスクレベル (LOW / MEDIUM / HIGH) が設定されており、セキュリティモジュールと連携してアクセス制御が可能です。

---

## 操作フロー

### 典型的な開発フロー

```
1. lunacode "プロジェクトの構造を教えて"
   → glob, read_file を使ってプロジェクトを分析

2. lunacode "src/api.ts にバリデーションを追加して"
   → read_file → edit_file でコードを修正

3. lunacode "テストを実行して結果を確認"
   → bash で npm test を実行し結果を報告

4. lunacode "変更を git にコミットして"
   → git add → git commit を実行
```

### デーモン + AutoDream の活用

```
1. lunacode daemon start
   → KAIROS デーモンを起動

2. （通常の開発作業を行う）

3. lunacode memory stats
   → メモリの状態を確認

4. lunacode dream run
   → 手動でメモリ統合を実行（通常は自動）

5. lunacode daemon stop
   → 作業終了時にデーモンを停止
```

---

次のステップ: [機能詳細ガイド](./features.md) で各機能の仕組みを深く理解しましょう。
