/**
 * 最小限の js-yaml 型宣言。
 *
 * @types/js-yaml をフル依存させる代わりに、LunaCode で使う API だけを宣言する。
 * 他の用途で必要になった場合はここに追加すること。
 */
declare module "js-yaml" {
  export interface LoadOptions {
    /** 入力ファイル名（エラーメッセージに使われる） */
    filename?: string;
    /** 不明なタグを許可するかどうか */
    json?: boolean;
  }

  export interface DumpOptions {
    indent?: number;
    noArrayIndent?: boolean;
    skipInvalid?: boolean;
    flowLevel?: number;
    sortKeys?: boolean | ((a: string, b: string) => number);
    lineWidth?: number;
    noRefs?: boolean;
    noCompatMode?: boolean;
    condenseFlow?: boolean;
    quotingType?: "'" | '"';
    forceQuotes?: boolean;
  }

  /** YAML テキストを JavaScript 値に変換。空なら undefined を返す */
  export function load(input: string, options?: LoadOptions): unknown;

  /** JavaScript 値を YAML テキストに変換 */
  export function dump(obj: unknown, options?: DumpOptions): string;

  /** YAML 解析エラー */
  export class YAMLException extends Error {
    name: "YAMLException";
    reason: string;
    mark: {
      name: string | null;
      buffer: string;
      position: number;
      line: number;
      column: number;
    };
  }

  const _default: {
    load: typeof load;
    dump: typeof dump;
    YAMLException: typeof YAMLException;
  };
  export default _default;
}
