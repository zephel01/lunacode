import { describe, it, expect } from "bun:test";
import { extractFiles } from "../src/utils/WholeFormatParser.js";

describe("WholeFormatParser", () => {
  describe("パターン1: filename\\n```lang\\ncontent\\n```", () => {
    it("単一ファイルを抽出できる", () => {
      const text = `Here is the file:

index.html
\`\`\`html
<!DOCTYPE html>
<html><body>Hello</body></html>
\`\`\`
`;
      const files = extractFiles(text);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("index.html");
      expect(files[0].content).toContain("<!DOCTYPE html>");
    });

    it("複数ファイルを抽出できる", () => {
      const text = `
index.html
\`\`\`html
<html></html>
\`\`\`

tetris.js
\`\`\`javascript
const game = {};
\`\`\`
`;
      const files = extractFiles(text);
      expect(files.length).toBeGreaterThanOrEqual(2);
      const paths = files.map((f) => f.path);
      expect(paths).toContain("index.html");
      expect(paths).toContain("tetris.js");
    });

    it("サブディレクトリのパスを抽出できる", () => {
      const text = `
src/utils/helper.ts
\`\`\`typescript
export function add(a: number, b: number) { return a + b; }
\`\`\`
`;
      const files = extractFiles(text);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("src/utils/helper.ts");
    });
  });

  describe("パターン2: \`\`\`filepath\\ncontent\\n\`\`\`", () => {
    it("opening fence にパスが含まれる形式を抽出できる", () => {
      const text = `
\`\`\`app.py
def main():
    print("hello")
\`\`\`
`;
      const files = extractFiles(text);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("app.py");
      expect(files[0].content).toContain('print("hello")');
    });
  });

  describe("パターン3: コメント行にパスが含まれる形式", () => {
    it("// コメントからパスを抽出できる", () => {
      const text = `
\`\`\`typescript
// src/index.ts
export const version = "1.0.0";
\`\`\`
`;
      const files = extractFiles(text);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("src/index.ts");
      expect(files[0].content).toContain('version = "1.0.0"');
    });

    it("# コメントからパスを抽出できる", () => {
      const text = `
\`\`\`python
# main.py
def hello():
    pass
\`\`\`
`;
      const files = extractFiles(text);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("main.py");
    });
  });

  describe("セキュリティ", () => {
    it("パストラバーサルを無視する", () => {
      const text = `
../etc/passwd
\`\`\`
root:x:0:0
\`\`\`
`;
      const files = extractFiles(text);
      expect(files).toHaveLength(0);
    });

    it("/etc/ などシステムパスを無視する", () => {
      const text = `
\`\`\`/etc/hosts
127.0.0.1 localhost
\`\`\`
`;
      const files = extractFiles(text);
      expect(files).toHaveLength(0);
    });

    it("拡張子のないパスを無視する", () => {
      const text = `
Makefile
\`\`\`makefile
all: build
\`\`\`
`;
      // Makefile は拡張子なしなのでスキップされる（現在の実装)
      // 必要なら将来対応
      const files = extractFiles(text);
      expect(files).toHaveLength(0);
    });
  });

  describe("重複除去", () => {
    it("同じパスが複数回現れた場合は最初のものだけ返す", () => {
      const text = `
app.js
\`\`\`javascript
const a = 1;
\`\`\`

app.js
\`\`\`javascript
const a = 2;
\`\`\`
`;
      const files = extractFiles(text);
      const appFiles = files.filter((f) => f.path === "app.js");
      expect(appFiles).toHaveLength(1);
      expect(appFiles[0].content).toContain("const a = 1");
    });
  });

  describe("ファイルなしの場合", () => {
    it("コードブロックがない通常テキストは空配列を返す", () => {
      const text = "This is just a normal response without any file blocks.";
      const files = extractFiles(text);
      expect(files).toHaveLength(0);
    });

    it("ファイルパスのないコードブロックは無視する", () => {
      const text = `
Here is some code:
\`\`\`javascript
console.log("hello");
\`\`\`
`;
      const files = extractFiles(text);
      expect(files).toHaveLength(0);
    });
  });
});
