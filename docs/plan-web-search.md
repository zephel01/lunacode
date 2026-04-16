# Web Search / Browser ツール統合

LunaCode エージェントが自律的に Web 検索・ページ取得を行えるようにする。
[mcp-wrapper](https://github.com/zephel01/mcp-wrapper) を MCP サーバーとして接続し、`MCPClientManager` 経由でツールを追加する。

---

## アーキテクチャ

```
LunaCode (AgentLoop)
  └── MCPClientManager
        └── mcp-wrapper (stdio MCP サーバー)
              ├── my_crawl    — URL → Markdown
              └── web_search  — キーワード → URL 一覧（DuckDuckGo）
```

LunaCode 側のコード変更はゼロ。ツール追加は mcp-wrapper に `.py + .yaml` を置くだけ。

---

## 実装状況

| フェーズ | 内容 | 状態 |
|---|---|---|
| Phase 1 | `config.json` に mcp-wrapper を追加（環境変数対応） | ✅ 完了 |
| Phase 2 | `web_search.py / .yaml` を追加（DuckDuckGo） | ✅ 完了 |
| Phase 3 | `my_crawl.py` に SSRF 対策を追加 | ✅ 完了 |

---

## Phase 1：LunaCode との接続

`config.json` の `mcp.servers` に mcp-wrapper を登録する。パスは環境変数で渡す（ConfigManager が `${VAR}` を自動展開）。

```json
"mcp": {
  "servers": [
    {
      "name": "mcp-wrapper",
      "transport": "stdio",
      "command": "${MCP_WRAPPER_PYTHON}",
      "args": ["${MCP_WRAPPER_SERVER}"]
    }
  ]
}
```

```bash
# .env または shell に設定
export MCP_WRAPPER_PYTHON="/path/to/mcp-wrapper/.venv/bin/python"
export MCP_WRAPPER_SERVER="/path/to/mcp-wrapper/server.py"
```

起動確認:

```bash
lunacode chat
> https://docs.anthropic.com/ja/api/getting-started の内容を要約して
```

エージェントが `my_crawl` を自律的に呼び出せば成功。

---

## Phase 2：web_search ツール

**ファイル:** `mcp-wrapper/scripts/web_search.py` / `web_search.yaml`

DuckDuckGo（`ddgs` パッケージ）を使用。APIキー不要。

**入力:**

| パラメータ | 型 | 説明 |
|---|---|---|
| `query` | string | 検索キーワード（必須） |
| `count` | integer | 取得件数（デフォルト: 5、最大: 10） |
| `region` | string | 地域コード（デフォルト: `wt-wt`、日本語優先: `jp-jp`） |

**出力:** `{ "query": "...", "results": [{ "title", "url", "description" }] }`

**エージェントの典型的な動き:**

```
1. web_search("TypeScript async iterator MDN")  → URL 一覧
2. my_crawl("https://...")                       → ページ内容（Markdown）
3. コードを実装
```

---

## Phase 3：SSRF 対策（my_crawl）

`my_crawl.py` の `validate_url()` でクロール前に URL を検証する。

**ブロック対象:**

| 種別 | 例 |
|---|---|
| `http(s)` 以外のスキーム | `file://`, `ftp://` など |
| 認証情報付き URL | `http://user:pass@host/` |
| プライベート IP | `10.x`, `172.16-31.x`, `192.168.x`, `100.64.x` |
| ループバック | `127.0.0.1`, `::1` |
| リンクローカル | `169.254.x.x`, `fe80::` |
| DNS 解決後もプライベート IP | DNS リバインディング対策 |

問題があれば `{ "error": "Blocked: ..." }` を返す。

---

## 検索バックエンドの切り替え

`web_search.py` と `web_search.yaml` の差し替えのみで切り替え可能。

| プロバイダー | APIキー | 無料枠 | 備考 |
|---|---|---|---|
| **DuckDuckGo**（現在） | 不要 | 無制限 | ゼロ設定 |
| Brave Search | 必要 | 月 2,000 クエリ | $3 / 1,000 クエリ〜 |
| Serper | 必要 | 月 2,500 クエリ | Google 結果・高精度 |
| Tavily | 必要 | 月 1,000 クエリ | AI 特化・要約付き |

Brave に切り替える場合は `packages: [requests]` に変更し、`BRAVE_API_KEY` 環境変数を設定する。

---

## 将来の拡張

`.py + .yaml` を追加するだけで実現できるツール案。

| ツール | 用途 |
|---|---|
| `github_search` | GitHub Code Search でコード例を検索 |
| `npm_info` | npm パッケージの最新バージョン・依存関係を確認 |
| `stack_overflow` | Stack Overflow 検索 |
| `docs_fetch` | MDN・Python docs など特定サイト専用クローラー |
