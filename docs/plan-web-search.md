# Web Search / Browser ツール統合 実装計画

## 概要

LunaCode エージェントが自律的に Web 検索・ページ取得を行えるようにする。
[mcp-wrapper](https://github.com/zephel01/mcp-wrapper) を MCP サーバーとして接続し、
既存の `MCPClientManager` 経由でツールを提供する。

---

## 採用アーキテクチャ

```
LunaCode (AgentLoop)
  └── MCPClientManager
        └── mcp-wrapper (stdio MCP サーバー)
              ├── my_crawl     ← URL → Markdown（既存・即使用可）
              └── web_search   ← キーワード → URL 一覧（新規追加）
                    └── Brave Search API
```

コード変更は **LunaCode 側ゼロ**（config.json のみ）。
機能追加は **mcp-wrapper 側に .py + .yaml を置くだけ**。

---

## Phase 1：my_crawl を繋ぐ（設定変更のみ）

### やること

`.kairos/config.json` に以下を追加する。

```jsonc
{
  "mcp": {
    "servers": [
      {
        "name": "mcp-wrapper",
        "command": "/path/to/mcp-wrapper/.venv/bin/python",
        "args": ["/path/to/mcp-wrapper/server.py"]
      }
    ]
  }
}
```

### 使えるようになるツール

| ツール名 | 動作 |
|---|---|
| `my_crawl` | URL を渡すと crawl4ai がページを Markdown で返す |

### 確認方法

```bash
lunacode chat
> https://docs.anthropic.com/ja/api/getting-started の内容を要約して
```

エージェントが `my_crawl` ツールを呼び出して自律的に取得・要約すれば成功。

---

## Phase 2：web_search ツールを追加する

### やること

`mcp-wrapper/scripts/` に 2 ファイルを追加する。

#### `scripts/web_search.yaml`

```yaml
name: web_search
description: "キーワードで Web 検索し、関連する URL と概要の一覧を返す"
timeout: 30
packages:
  - ddgs

docker:
  network: bridge

parameters:
  type: object
  properties:
    query:
      type: string
      description: "検索キーワード（英語推奨）"
    count:
      type: integer
      description: "取得件数（デフォルト: 5、最大: 10）"
      default: 5
  required:
    - query
```

#### `scripts/web_search.py`

```python
import json
import sys
from ddgs import DDGS

def main(params):
    query = params["query"]
    count = min(int(params.get("count", 5)), 10)

    results = []
    with DDGS() as ddgs:
        for r in ddgs.text(query, max_results=count):
            results.append({
                "title": r.get("title", ""),
                "url": r.get("href", ""),
                "description": r.get("body", ""),
            })

    return {"results": results, "query": query}

if __name__ == "__main__":
    print(json.dumps(main(json.load(sys.stdin)), ensure_ascii=False))
```

### API キーについて

**不要。** `ddgs` は DuckDuckGo の公開エンドポイントを使うため、
API キーもアカウント登録も一切必要ない。

### 典型的なエージェントの動き（検索 → 取得 → 実装）

```
1. web_search("crawl4ai async crawler usage")
   → URL 一覧が返る

2. my_crawl("https://docs.crawl4ai.com/...")
   → ページ内容が Markdown で返る

3. コードを実装
```

---

## Phase 3：セキュリティ強化

my_crawl に SSRF 対策フィルターを追加する。
`docker: {network: bridge}` だけでは内部ネットワークへのアクセスを防げないため。

#### `scripts/my_crawl.py` に追加するフィルター

```python
import ipaddress
import urllib.parse

BLOCKED_SCHEMES = {"file", "ftp", "data", "javascript"}
PRIVATE_RANGES = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
]

def validate_url(url: str) -> None:
    parsed = urllib.parse.urlparse(url)

    if parsed.scheme in BLOCKED_SCHEMES:
        raise ValueError(f"Scheme not allowed: {parsed.scheme}")

    if parsed.username or parsed.password:
        raise ValueError("Credentials in URL are not allowed")

    hostname = parsed.hostname or ""
    if hostname.endswith((".internal", ".local", ".localhost")):
        raise ValueError(f"Internal hostname not allowed: {hostname}")

    try:
        ip = ipaddress.ip_address(hostname)
        for net in PRIVATE_RANGES:
            if ip in net:
                raise ValueError(f"Private IP not allowed: {ip}")
    except ValueError as e:
        if "not allowed" in str(e):
            raise
        # hostname（非IP）はそのまま通す

def main(params):
    url = params["url"]
    validate_url(url)          # ← ここで弾く
    # ... 以降は既存コード
```

---

## 実装スケジュール

| フェーズ | 内容 | 工数目安 | 依存 |
|---|---|---|---|
| Phase 1 | config.json に mcp-wrapper を追加して動作確認 | 10分 | mcp-wrapper セットアップ済み |
| Phase 2 | web_search.py + .yaml を追加 | 30分〜1時間 | DuckDuckGo: 依存なし / Brave: API キー取得 |
| Phase 3 | SSRF フィルターを my_crawl.py に追加 | 30分 | Phase 1 完了後 |

---

## 検索バックエンドの選択肢

| プロバイダー | APIキー | 無料枠 | 有料 | 特徴 |
|---|---|---|---|---|
| **DuckDuckGo**（デフォルト推奨） | 不要 | 無制限（レート制限あり） | なし | ゼロ設定・即使用可 |
| **Brave Search API** | 必要 | 月 2,000 クエリ | $3 / 1,000 クエリ〜 | 高品質・安定 |
| **Serper** | 必要 | 月 2,500 クエリ | $50 / 50,000 クエリ〜 | Google 結果・高精度 |
| **Tavily** | 必要 | 月 1,000 クエリ | $20 / 1,000 クエリ〜 | AI 特化・要約付き |

### 切り替え方法

`web_search.yaml` の `packages` と `web_search.py` の実装を差し替えるだけ。

#### Brave Search API を使う場合

```yaml
# web_search.yaml
packages:
  - requests
```

```python
# web_search.py (Brave 版)
import json, sys, os, requests

ENDPOINT = "https://api.search.brave.com/res/v1/web/search"

def main(params):
    query = params["query"]
    count = min(int(params.get("count", 5)), 10)
    headers = {
        "Accept": "application/json",
        "X-Subscription-Token": os.environ["BRAVE_API_KEY"],
    }
    data = requests.get(ENDPOINT, headers=headers,
                        params={"q": query, "count": count}, timeout=15).json()
    results = [
        {"title": r.get("title",""), "url": r.get("url",""), "description": r.get("description","")}
        for r in data.get("web", {}).get("results", [])
    ]
    return {"results": results, "query": query}

if __name__ == "__main__":
    print(json.dumps(main(json.load(sys.stdin)), ensure_ascii=False))
```

API キーは `mcp-wrapper/config.yaml` に設定する。

```yaml
# mcp-wrapper/config.yaml
env:
  BRAVE_API_KEY: "BSA..."
```

- 登録: https://brave.com/search/api/

---

## 将来の拡張

mcp-wrapper の `.py + .yaml` を追加するだけで以下も実現できる。

| ツール案 | 用途 |
|---|---|
| `github_search` | GitHub Code Search API でコード例を検索 |
| `npm_info` | npm パッケージの最新バージョン・依存関係を確認 |
| `stack_overflow` | Stack Overflow 検索（HTML スクレイピング） |
| `docs_fetch` | 特定ドキュメントサイト専用クローラー（MDN、Python docs 等） |
