/**
 * A small lexer for Java and Kotlin source, just enough to find `NamedCommands` registrations
 * (`scanCommands.ts`). It is not a parser: it turns text into identifiers, literals and
 * punctuation, drops comments, and matches brackets, so the scanner can walk calls and their
 * arguments without being fooled by a comment or a string that mentions a registration.
 *
 * Pure, like the rest of the package: text in, tokens out.
 */

export type TokenKind = "ident" | "string" | "char" | "number" | "punct";

export interface Token {
  kind: TokenKind;
  /** The source text of the token, as written. */
  text: string;
  /**
   * For a string literal, its value with escapes decoded; `null` for a Kotlin string template
   * (`"a$b"`), whose value is only known at run time.
   */
  value?: string | null;
  /** The 1-based line the token starts on. */
  line: number;
}

export interface Lexed {
  tokens: Token[];
  /**
   * For each opening bracket (`(`, `[` or `{`), the index of the token that closes it. An
   * unclosed bracket maps to `tokens.length`, so a walk that uses it stops at the end of the file.
   */
  close: Map<number, number>;
}

const isIdentStart = (c: string): boolean => /[A-Za-z_$À-￿]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_$À-￿]/.test(c);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  s: " ",
  "0": "\0",
  "\\": "\\",
  '"': '"',
  "'": "'",
  $: "$",
};

/** Decodes the escapes of a Java or Kotlin string body. Unknown escapes keep their character. */
function decodeEscapes(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i] as string;
    if (c !== "\\" || i + 1 >= body.length) {
      out += c;
      continue;
    }
    const next = body[i + 1] as string;
    if (next === "u") {
      let j = i + 1;
      while (body[j] === "u") j += 1;
      const hex = body.slice(j, j + 4);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i = j + 3;
        continue;
      }
    }
    out += SIMPLE_ESCAPES[next] ?? next;
    i += 1;
  }
  return out;
}

/** Whether a Kotlin string body holds a template (`$name` or `${...}`) outside an escape. */
function hasTemplate(body: string): boolean {
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (c === "$") {
      const next = body[i + 1] ?? "";
      if (next === "{" || isIdentStart(next)) return true;
    }
  }
  return false;
}

/**
 * The text of a Java text block (`"""` then a line break) with its incidental indentation removed,
 * the way `String.stripIndent` does it for the common case. Only used to give the block a value;
 * a registration name in a text block would be unusual.
 */
function textBlockValue(raw: string): string {
  const lines = raw.replace(/^[ \t]*\r?\n/, "").split(/\r?\n/);
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => (/^[ \t]*/.exec(line)?.[0].length ?? 0));
  const cut = indents.length === 0 ? 0 : Math.min(...indents);
  return decodeEscapes(lines.map((line) => line.slice(cut).replace(/[ \t]+$/, "")).join("\n"));
}

const PUNCT_PAIRS = ["->", "::", "?.", "!!", "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "?:"];

/**
 * Lexes one file. `kotlin` switches on Kotlin's nested block comments, raw strings and string
 * templates; Java's text blocks are recognised either way.
 */
export function lex(text: string, kotlin: boolean): Lexed {
  const tokens: Token[] = [];
  let line = 1;
  let i = 0;
  const n = text.length;

  const advanceTo = (end: number): void => {
    for (let k = i; k < end && k < n; k += 1) if (text[k] === "\n") line += 1;
    i = end;
  };

  while (i < n) {
    const c = text[i] as string;
    const next = text[i + 1] ?? "";

    if (c === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f") {
      i += 1;
      continue;
    }

    // Comments.
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      let k = i + 2;
      while (k < n && depth > 0) {
        if (text[k] === "*" && text[k + 1] === "/") {
          depth -= 1;
          k += 2;
        } else if (kotlin && text[k] === "/" && text[k + 1] === "*") {
          depth += 1;
          k += 2;
        } else {
          k += 1;
        }
      }
      advanceTo(k);
      continue;
    }

    const startLine = line;

    // Triple-quoted strings: a Java text block or a Kotlin raw string.
    if (c === '"' && next === '"' && text[i + 2] === '"') {
      const end = text.indexOf('"""', i + 3);
      let stop = end === -1 ? n : end + 3;
      // A raw string may end in more than three quotes; the extra ones belong to the value.
      while (stop < n && text[stop] === '"') stop += 1;
      const raw = text.slice(i, stop);
      const body = raw.slice(3, Math.max(3, raw.length - 3));
      const value = kotlin ? (hasTemplate(body) ? null : body) : textBlockValue(body);
      tokens.push({ kind: "string", text: raw, value, line: startLine });
      advanceTo(stop);
      continue;
    }

    if (c === '"' || c === "'") {
      let k = i + 1;
      let braceDepth = 0;
      while (k < n) {
        const ch = text[k];
        if (ch === "\\") {
          k += 2;
          continue;
        }
        if (kotlin && c === '"' && ch === "$" && text[k + 1] === "{") {
          braceDepth += 1;
          k += 2;
          continue;
        }
        if (braceDepth > 0) {
          if (ch === "{") braceDepth += 1;
          else if (ch === "}") braceDepth -= 1;
          k += 1;
          continue;
        }
        if (ch === c || ch === "\n") break;
        k += 1;
      }
      const stop = Math.min(n, k + 1);
      const raw = text.slice(i, stop);
      const body = raw.slice(1, raw.endsWith(c) && raw.length > 1 ? -1 : raw.length);
      if (c === "'") {
        tokens.push({ kind: "char", text: raw, line: startLine });
      } else {
        const value = kotlin && hasTemplate(body) ? null : decodeEscapes(body);
        tokens.push({ kind: "string", text: raw, value, line: startLine });
      }
      advanceTo(stop);
      continue;
    }

    // Kotlin backtick identifiers.
    if (kotlin && c === "`") {
      const end = text.indexOf("`", i + 1);
      const stop = end === -1 ? n : end + 1;
      tokens.push({ kind: "ident", text: text.slice(i + 1, stop - 1), line: startLine });
      advanceTo(stop);
      continue;
    }

    if (isDigit(c) || (c === "." && isDigit(next))) {
      let k = i;
      if (c === "0" && (next === "x" || next === "X" || next === "b" || next === "B")) {
        k += 2;
        while (k < n && /[0-9a-fA-F_]/.test(text[k] as string)) k += 1;
      } else {
        while (k < n && /[0-9_]/.test(text[k] as string)) k += 1;
        if (text[k] === "." && isDigit(text[k + 1] ?? "")) {
          k += 1;
          while (k < n && /[0-9_]/.test(text[k] as string)) k += 1;
        } else if (text[k] === "." && !isIdentStart(text[k + 1] ?? "") && text[k + 1] !== ".") {
          // `1.` is a double in Java.
          k += 1;
        }
        if (text[k] === "e" || text[k] === "E") {
          let e = k + 1;
          if (text[e] === "+" || text[e] === "-") e += 1;
          if (isDigit(text[e] ?? "")) {
            k = e;
            while (k < n && /[0-9_]/.test(text[k] as string)) k += 1;
          }
        }
      }
      while (k < n && /[lLfFdDuU]/.test(text[k] as string)) k += 1;
      tokens.push({ kind: "number", text: text.slice(i, k), line: startLine });
      i = k;
      continue;
    }

    if (isIdentStart(c)) {
      let k = i + 1;
      while (k < n && isIdentPart(text[k] as string)) k += 1;
      tokens.push({ kind: "ident", text: text.slice(i, k), line: startLine });
      i = k;
      continue;
    }

    const pair = c + next;
    if (PUNCT_PAIRS.includes(pair)) {
      tokens.push({ kind: "punct", text: pair, line: startLine });
      i += 2;
      continue;
    }
    tokens.push({ kind: "punct", text: c, line: startLine });
    i += 1;
  }

  return { tokens, close: matchBrackets(tokens) };
}

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/**
 * Pairs every opening bracket with its closer. A closer that does not match the innermost opener
 * closes everything up to the opener it does match, so one stray bracket in odd code cannot
 * shift every pairing after it.
 */
function matchBrackets(tokens: readonly Token[]): Map<number, number> {
  const close = new Map<number, number>();
  const stack: number[] = [];
  tokens.forEach((token, index) => {
    if (token.kind !== "punct") return;
    if (OPENERS[token.text] !== undefined) {
      stack.push(index);
      return;
    }
    if (token.text !== ")" && token.text !== "]" && token.text !== "}") return;
    for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
      const opener = stack[depth] as number;
      if (OPENERS[(tokens[opener] as Token).text] === token.text) {
        while (stack.length > depth) close.set(stack.pop() as number, index);
        return;
      }
    }
  });
  for (const opener of stack) close.set(opener, tokens.length);
  return close;
}
