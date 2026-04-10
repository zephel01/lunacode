# トラブルシューティング

よくある問題と解決方法、FAQ をまとめています。

## 目次

- [インストール・起動](#インストール起動)
- [LLM プロバイダー接続](#llm-プロバイダー接続)
- [エージェント実行](#エージェント実行)
- [メモリシステム](#メモリシステム)
- [KAIROS デーモン](#kairos-デーモン)
- [通知](#通知)
- [FAQ](#faq)

---

## インストール・起動

### `bun install` でエラーが出る

**症状**: 依存関係のインストール中にエラーが発生する。

**対処**:

1. Bun のバージョンを確認:
```bash
bun --version  # 1.0.0 以上であること
```

2. node_modules を削除して再インストール:
```bash
rm -rf node_modules bun.lock
bun install
```

3. それでも解決しない場合は npm を試す:
```bash
npm install
```

### `lunacode` コマンドが見つからない

**症状**: グローバルインストール後に `lunacode: command not found` が表示される。

**対処**:

1. `bun link` の実行を確認
2. シェルの PATH にグローバル bin ディレクトリが含まれているか確認:
```bash
echo $PATH
```

3. 代替として直接実行:
```bash
bun run src/cli.ts "your query"
```

---

## LLM プロバイダー接続

### OpenAI: "API key is required" エラー

**症状**: `Error: API key is required for OpenAI provider`

**対処**:

1. 環境変数が正しく設定されているか確認:
```bash
echo $OPENAI_API_KEY
```

2. API キーが `sk-` で始まっているか確認

3. 代替の環境変数名も使用可能:
```bash
export LUNACODE_API_KEY="sk-..."
```

### OpenAI: レート制限エラー

**症状**: `429 Rate limit exceeded` や `Error: Too Many Requests`

**対処**:

1. しばらく待ってから再実行（通常1分程度）
2. `config.json` で `maxTokens` を下げる
3. モデルを `gpt-4o-mini` に変更する（より高いレート制限）

### Ollama: 接続できない

**症状**: `Ollama connection test failed`

**対処**:

1. Ollama が起動しているか確認:
```bash
ollama list
```

2. デフォルトポート (11434) でリッスンしているか確認:
```bash
curl http://localhost:11434/api/tags
```

3. モデルがダウンロードされているか確認:
```bash
ollama pull llama3.1
```

### Z.AI: 接続できない

**症状**: `Z.AI connection test failed`

**対処**:

1. 環境変数が設定されているか確認:
```bash
echo $ZAI_API_KEY
```

2. API キーが有効か確認（[API キー管理ページ](https://z.ai/manage-apikey/apikey-list)で確認）

3. Coding Plan のサブスクリプションが有効か確認

4. `ZHIPUAI_API_KEY` でも設定可能:
```bash
export ZHIPUAI_API_KEY="your-key"
```

### LM Studio: 接続できない

**症状**: `LM Studio connection test failed`

**対処**:

1. LM Studio のローカルサーバーが起動しているか確認
2. ポート番号が正しいか確認（デフォルト: 1234）
3. モデルが読み込まれているか確認（LM Studio の UI で確認）

### どのプロバイダーが使われているか分からない

**対処**: `provider` コマンドで確認:

```bash
lunacode provider
```

環境変数の自動検出優先順位: LM Studio > Ollama > Z.AI > OpenAI

---

## エージェント実行

### エージェントが無限ループしている

**症状**: エージェントがツールを何度も呼び出し続けて終了しない。

**対処**:

1. 通常は `maxIterations`（デフォルト: 50）で自動停止します
2. `Ctrl+C` で強制終了できます
3. `config.json` で `maxIterations` を下げる:
```json
{
  "agent": {
    "maxIterations": 20
  }
}
```

### ツールの実行結果が空になる

**症状**: ツール（特に `grep`）の出力が空で、マッチするはずの結果が返らない。

**対処**:

1. ripgrep がインストールされているか確認:
```bash
rg --version
```

2. インストールされていない場合:
```bash
# macOS
brew install ripgrep

# Ubuntu/Debian
sudo apt install ripgrep

# Bun グローバル
# (ripgrep は Rust 製のため bun/npm ではインストールできません)
```

### ファイルの編集が意図通りにならない

**症状**: `edit_file` ツールでの置換が期待と異なる。

**対処**:

LLM の出力精度に依存するため、複雑な編集の場合は:
1. より具体的なクエリを使用する
2. 1回の編集で変更する範囲を小さくする
3. 編集後に `read_file` で結果を確認するようクエリに含める

---

## メモリシステム

### メモリが肥大化している

**症状**: `MEMORY.md` が巨大になり、エージェントの応答が遅い。

**対処**:

1. 手動でメモリを圧縮:
```bash
lunacode memory compact
```

2. メモリの統計を確認:
```bash
lunacode memory stats
```

3. 必要に応じて `MEMORY.md` を直接編集して不要な情報を削除

### メモリが消えた / 壊れた

**症状**: `MEMORY.md` の内容が消えた、または壊れている。

**対処**:

1. サーキットブレーカーが OPEN 状態の可能性があります。30秒後に自動復帰します
2. `topics/` ディレクトリのトピックファイルは別途保存されているため、メインメモリが壊れてもトピックからの復元が可能です
3. `logs/` ディレクトリの生ログは常に保持されています

---

## KAIROS デーモン

### デーモンが起動しない

**症状**: `lunacode daemon start` がエラーになる。

**対処**:

1. 既存のデーモンプロセスが残っていないか確認:
```bash
lunacode daemon status
```

2. PID ファイルが残っている場合は削除:
```bash
rm -f .kairos/daemon.pid
```

3. 再度起動:
```bash
lunacode daemon start
```

### デーモンが頻繁にクラッシュする

**症状**: デーモンが一定時間後に停止する。

**対処**:

1. ログを確認:
```bash
lunacode daemon logs
```

2. LLM プロバイダーの接続が安定しているか確認
3. メモリ不足の場合は `maxTokens` を下げる

---

## 通知

### macOS の通知が表示されない

**対処**:

1. システム環境設定 > 通知 で、Terminal（またはお使いのターミナルアプリ）の通知が許可されているか確認
2. osascript が使用可能か確認:
```bash
osascript -e 'display notification "test" with title "LunaCode"'
```

### Linux の通知が表示されない

**対処**:

1. `notify-send` がインストールされているか確認:
```bash
which notify-send
```

2. インストールされていない場合:
```bash
sudo apt install libnotify-bin
```

### Pushover / Telegram 通知が届かない

**対処**:

1. 環境変数が正しく設定されているか確認:
```bash
# Pushover
echo $PUSHOVER_USER_KEY
echo $PUSHOVER_APP_TOKEN

# Telegram
echo $TELEGRAM_BOT_TOKEN
echo $TELEGRAM_CHAT_ID
```

2. ネットワーク接続を確認

---

## FAQ

### Q: LunaCode は Claude Code と同じですか？

いいえ。LunaCode は Claude Code のアーキテクチャにインスパイアされた独立したオープンソースプロジェクトです。クリーンルーム再実装として開発されており、Claude Code のソースコードは使用していません。

### Q: どの LLM プロバイダーがおすすめですか？

用途によって異なります:

- **安定性重視** → OpenAI (gpt-4o-mini / gpt-4o)
- **コーディング特化** → Z.AI (glm-5.1) — Coding 専用エンドポイントがあり、エージェント向けに最適化
- **プライバシー重視** → Ollama (llama3.1) または LM Studio
- **コスト重視** → Ollama / LM Studio（無料、ただしローカル GPU が必要）

ツールコールの精度は OpenAI が最も高く、Z.AI (GLM-5.1) も良好です。

### Q: メモリはどこに保存されますか？

プロジェクトルート直下に以下のファイル/ディレクトリが作成されます:

```
./MEMORY.md          # メインメモリ
./topics/            # トピックファイル
./logs/              # 日別ログ
./config.json        # 設定ファイル（手動作成）
```

### Q: 複数のプロジェクトで使えますか？

はい。LunaCode は実行時のカレントディレクトリをプロジェクトルートとして使用します。プロジェクトごとに独立したメモリとログが管理されます。

### Q: Ollama でツール呼び出しの精度が低い

Ollama はネイティブのツールコール API を持たないため、LunaCode は LLM の応答テキストから `<tool_call>` XML タグを解析してツールコールを検出しています。精度を上げるには:

1. ツール対応が良いモデルを使用する（llama3.1, mistral 等）
2. モデルサイズを大きくする（7B → 13B → 70B）
3. 可能であれば OpenAI を使用する

### Q: デーモンを本番運用するには？

長期運用には pm2 や systemd を使ったプロセス管理を推奨します:

```bash
# pm2 の場合
pm2 start "lunacode daemon start" --name lunacode-daemon

# systemd の場合は .service ファイルを作成
```

### Q: セキュリティ機能はプロダクションレディですか？

現時点では開発中のため、本番環境での使用は推奨しません。特に以下の点に注意してください:

- 認証システムは開発途中です
- BashTool のコマンドフィルタはブラックリスト方式で完全ではありません
- パスワードハッシュは SHA-256 を使用しています（bcrypt/Argon2 への移行を予定）

---

問題が解決しない場合は [GitHub Issues](https://github.com/zephel01/lunacode/issues) で報告してください。
