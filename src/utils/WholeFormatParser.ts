/**
 * Aider の "whole" / "diff-fenced" 形式に相当するファイル抽出パーサー。
 *
 * モデルが tool calling を使わずにファイルをテキストで出力した場合でも
 * ファイルをディスクに書き込めるようにするフォールバック機構。
 *
 * サポートするパターン:
 *
 * パターン1 (aider whole): ファイルパスの直後にコードブロック
 *   src/app.ts
 *   ```typescript
 *   file content
 *   ```
 *
 * パターン2 (fenced path): コードブロックの opening fence にパスを埋め込む
 *   ```src/app.ts
 *   file content
 *   ```
 *
 * パターン3 (filename comment): コードブロック内の最初の行がコメントでパスを示す
 *   ```typescript
 *   // src/app.ts
 *   file content
 *   ```
 */

export interface ExtractedFile {
  /** ファイルパス */
  path: string;
  /** ファイルの内容 */
  content: string;
}

// ファイルパスらしい文字列かどうかを判定
// - 拡張子を持つ
// - スペースを含まない
// - 相対パスか絶対パスの形式
const FILE_PATH_RE =
  /^\.{0,2}[\w/\\][\w./\\-]*\.\w{1,10}$|^\/[\w./\\-]+\.\w{1,10}$/;

// 危険なパスをフィルタ
const DANGEROUS_PATH_RE = /\.\.|^\/etc\/|^\/usr\/|~\//;

function isValidPath(p: string): boolean {
  const trimmed = p.trim();
  if (!trimmed) return false;
  if (DANGEROUS_PATH_RE.test(trimmed)) return false;
  return FILE_PATH_RE.test(trimmed);
}

/**
 * LLM のテキスト応答からファイルブロックを抽出する
 */
export function extractFiles(text: string): ExtractedFile[] {
  const results: ExtractedFile[] = [];
  const seen = new Set<string>();

  // パターン2: ```filepath\ncontent\n```
  // opening fence の直後にパスが続く形式
  const fencedPathRe = /^```([\w./\\-]+\.\w{1,10})\n([\s\S]*?)^```/gm;
  for (const match of text.matchAll(fencedPathRe)) {
    const path = match[1].trim();
    const content = match[2];
    if (isValidPath(path) && !seen.has(path)) {
      seen.add(path);
      results.push({ path, content });
    }
  }

  // パターン1: filepath\n```lang\ncontent\n```
  // ファイルパスが単独の行として現れ、直後にコードブロックが続く形式
  const wholeRe =
    /^([\w./\\-]+\.\w{1,10})\s*\n```[\w]*\n([\s\S]*?)^```/gm;
  for (const match of text.matchAll(wholeRe)) {
    const path = match[1].trim();
    const content = match[2];
    if (isValidPath(path) && !seen.has(path)) {
      seen.add(path);
      results.push({ path, content });
    }
  }

  // パターン3: ```lang\n// filepath\ncontent\n```
  // 最初の行がコメントでファイルパスを示す形式
  const commentPathRe =
    /^```[\w]*\n(?:\/\/|#|<!--)\s*([\w./\\-]+\.\w{1,10})\s*(?:-->)?\n([\s\S]*?)^```/gm;
  for (const match of text.matchAll(commentPathRe)) {
    const path = match[1].trim();
    // コメント行自体は content から除く
    const content = match[2];
    if (isValidPath(path) && !seen.has(path)) {
      seen.add(path);
      results.push({ path, content });
    }
  }

  return results;
}
