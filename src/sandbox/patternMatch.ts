/**
 * サンドボックス除外パターンの glob マッチング (Phase 27)。
 *
 * gitignore に近い簡易仕様:
 *   - パスセパレータは `/` に正規化。
 *   - `**` は任意深さのパスセグメントにマッチ (空もマッチ)。
 *   - `*`  は 1 セグメント内の任意文字列 (`/` を除く)。
 *   - `?`  は 1 セグメント内の任意 1 文字 (`/` を除く)。
 *   - 先頭 `/` はプロジェクト root からの anchored match。
 *   - 末尾 `/` は「ディレクトリにのみマッチ」を意味する。
 *     ファイルに対して評価した場合は親ディレクトリ名側でマッチするか判定する。
 *   - パターンに `/` を含まない単純名 (例 `node_modules`) は任意深さで basename に
 *     マッチする (gitignore と同じ挙動)。
 *   - `!pattern` は負の否定エントリ。呼び出し側の `matchAny()` は最後にマッチした
 *     パターンの極性を採用する (gitignore 互換)。
 *
 * **非ゴール**
 *   - `[abc]` 文字クラス、`[^a]` 否定クラス、brace expansion `{a,b}` はサポートしない。
 *   - gitignore の `core.excludesFile` 等外部ファイルは扱わない。
 */

export interface CompiledPattern {
  /** 元のパターン文字列 (デバッグ用) */
  source: string;
  /** ! で始まる否定パターンか */
  negated: boolean;
  /** 末尾 / でディレクトリのみ対象か */
  dirOnly: boolean;
  /** 先頭 / で root anchored か */
  anchored: boolean;
  /** パターンに `/` を含むか (basename だけでなくパス全体で評価) */
  pathy: boolean;
  /** 実際のマッチに使う正規表現 */
  regex: RegExp;
}

// ────────────────────────────────────────────────────────────────────────────
// コンパイル
// ────────────────────────────────────────────────────────────────────────────

/**
 * gitignore ライクなパターンを 1 本の正規表現に変換する。
 * 空文字列・コメント行 (`#`) は呼び出し側で除外しておくこと。
 */
export function compilePattern(pattern: string): CompiledPattern | null {
  let src = pattern.trim();
  if (!src || src.startsWith("#")) return null;

  let negated = false;
  if (src.startsWith("!")) {
    negated = true;
    src = src.slice(1);
  }

  let dirOnly = false;
  if (src.endsWith("/")) {
    dirOnly = true;
    src = src.slice(0, -1);
  }

  let anchored = false;
  if (src.startsWith("/")) {
    anchored = true;
    src = src.slice(1);
  }

  // `/` を含むかどうかで anchor 挙動が変わる (gitignore と同じ)
  const pathy = src.includes("/");

  const body = globToRegexBody(src);
  // anchored か pathy なら先頭アンカー、そうでなければ任意深さを許容
  const prefix = anchored || pathy ? "^" : "^(?:.*/)?";
  const regex = new RegExp(`${prefix}${body}$`);

  return {
    source: pattern,
    negated,
    dirOnly,
    anchored,
    pathy,
    regex,
  };
}

/**
 * glob 文字列を regex 本体に変換する (^ / $ アンカーはこの関数では付けない)。
 * 仕様:
 *   "/`**`/"  → 任意の中間パス (ゼロ or 複数ディレクトリ)
 *   "`**`"    → ".*"
 *   "*"       → "[^/]*"
 *   "?"       → "[^/]"
 *   他の meta 文字はエスケープ。
 */
function globToRegexBody(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    // `/**/` (両端スラッシュの globstar) → 空 or 中間パス
    if (src.startsWith("/**/", i)) {
      out += "(?:/|/.*/)";
      i += 4;
      continue;
    }
    // 先頭 `**/` → 任意深さのディレクトリ接頭辞 (または空)
    if (i === 0 && src.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
      continue;
    }
    // 末尾 `/**` → サブツリー全体
    if (src.slice(i) === "/**") {
      out += "(?:/.*)?";
      i += 3;
      continue;
    }
    // 単独 `**`
    if (src.startsWith("**", i)) {
      out += ".*";
      i += 2;
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    // regex meta 文字をエスケープ (スラッシュは素通し)
    if (/[.+^${}()|\\[\]]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
    i += 1;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// マッチング
// ────────────────────────────────────────────────────────────────────────────

export interface MatchInput {
  /** origin からの相対パス。`/` 正規化済み */
  relPath: string;
  /** 対象がディレクトリなら true */
  isDirectory: boolean;
}

/**
 * 単一パターンでマッチするか (gitignore と同じ "このパターンが除外するか" の意味)。
 * 否定パターンの場合も論理的マッチを返す (極性の合成は matchAny() で行う)。
 */
export function matchOne(
  compiled: CompiledPattern,
  input: MatchInput,
): boolean {
  const rel = input.relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (compiled.dirOnly && !input.isDirectory) {
    // ディレクトリ指定のパターンは、ファイル本体ではマッチしない。
    // (親ディレクトリで先にマッチしていれば呼び出し側で除外判定される想定)
    return false;
  }
  return compiled.regex.test(rel);
}

/**
 * 複数パターンを順に適用して最終的に除外されるかを判定する (gitignore 互換)。
 * - マッチが 1 つもなければ `false` (含める)。
 * - ポジティブ/否定を順に見て最後のマッチの極性を採用する。
 */
export function matchAny(
  compiledList: CompiledPattern[],
  input: MatchInput,
): boolean {
  let excluded = false;
  for (const pat of compiledList) {
    if (matchOne(pat, input)) {
      excluded = !pat.negated;
    }
  }
  return excluded;
}

/**
 * 文字列の配列を一括でコンパイルする (null は捨てる)。
 */
export function compileAll(patterns: string[]): CompiledPattern[] {
  const out: CompiledPattern[] = [];
  for (const p of patterns) {
    const c = compilePattern(p);
    if (c) out.push(c);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// .gitignore パース
// ────────────────────────────────────────────────────────────────────────────

/**
 * `.gitignore` 形式のテキストを行単位に分解してパターン配列を返す。
 * 空行 / `#` コメント行 / 行末空白を除去する。
 */
export function parseGitignore(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, ""); // 末尾空白除去
    if (!line || line.startsWith("#")) continue;
    out.push(line);
  }
  return out;
}
