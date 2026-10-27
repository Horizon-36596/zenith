/**
 * A small Java tokenizer for the Code tab's colours: keywords, strings, comments and numbers, and
 * everything else as plain text. It reads only what `zenith codegen` writes, so it does not try to
 * be a Java lexer; text it does not recognise stays plain, which is always a safe reading.
 */

export type JavaTokenKind = "keyword" | "string" | "comment" | "number" | "plain";

export interface JavaToken {
  kind: JavaTokenKind;
  text: string;
}

/** The Java keywords and literals, coloured as keywords. */
const KEYWORDS = new Set([
  "abstract", "boolean", "break", "byte", "case", "catch", "char", "class", "continue", "default",
  "do", "double", "else", "enum", "extends", "final", "finally", "float", "for", "if", "implements",
  "import", "instanceof", "int", "interface", "long", "new", "package", "private", "protected",
  "public", "return", "short", "static", "super", "switch", "this", "throw", "throws", "try", "var",
  "void", "while", "true", "false", "null",
]);

/**
 * One token at a time, tried in this order. A block comment may span lines; every other token
 * ends at the end of its line. An annotation such as `@Override` reads as a keyword.
 */
const TOKEN = new RegExp(
  [
    String.raw`(?<comment>\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*)`,
    String.raw`(?<string>"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)`,
    String.raw`(?<number>\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFdDlL]?\b)`,
    String.raw`(?<word>@?[A-Za-z_$][\w$]*)`,
    String.raw`(?<other>[^"'\/\w@$]+|[\s\S])`,
  ].join("|"),
  "y",
);

/**
 * Splits `text` into lines of tokens. There is one line per `\n`-separated line of `text`, so a
 * trailing newline gives a last, empty line, as an editor shows it; adjacent plain text is merged.
 */
export function tokenizeJava(text: string): JavaToken[][] {
  const lines: JavaToken[][] = [[]];
  const push = (kind: JavaTokenKind, piece: string): void => {
    const parts = piece.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part.length === 0) return;
      const line = lines[lines.length - 1] as JavaToken[];
      const last = line[line.length - 1];
      if (last !== undefined && last.kind === kind && kind === "plain") last.text += part;
      else line.push({ kind, text: part });
    });
  };
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const match = TOKEN.exec(text);
    if (match === null) break;
    const groups = match.groups ?? {};
    if (groups["comment"] !== undefined) push("comment", groups["comment"]);
    else if (groups["string"] !== undefined) push("string", groups["string"]);
    else if (groups["number"] !== undefined) push("number", groups["number"]);
    else if (groups["word"] !== undefined) {
      const word = groups["word"];
      push(word.startsWith("@") || KEYWORDS.has(word) ? "keyword" : "plain", word);
    } else push("plain", match[0]);
  }
  return lines;
}
