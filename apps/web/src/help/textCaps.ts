/**
 * How long the second line of a tooltip may be (issue #247, UI_GUIDE section 9.13). An action's
 * `does` line is the second line of its toolbar, menu and palette tooltip, and a `hint=` on a
 * `Tooltip` is the same line for every other control. A paragraph there is a wall of text on a
 * 300 px bubble, so both are capped, and `textCaps.test.ts` fails when one runs over.
 *
 * SET BY HAND: 100 characters is one line and a half of the bubble at 13 px, and 160 is two lines.
 * 20 of the 78 action lines were over 100 when the cap came in, and nine literal hints over 160.
 */
export const ACTION_DOES_CAP = 100;
export const TOOLTIP_HINT_CAP = 160;

/**
 * What a `${…}` stands for when a template literal's length is counted. The host's name is the only
 * one an action line has, and a team's name is rarely longer than this.
 */
const SUBSTITUTION = "x".repeat(16);

/** A double-quoted string or a template literal, as the one capture group's contents. */
const LITERAL = String.raw`"((?:[^"\\\n]|\\.)*)"|` + "`((?:[^`\\\\]|\\\\.)*)`";

/** The length of a string literal's text, counting each `${…}` as a name of sixteen characters. */
function lengthOf(text: string): number {
  return text.replace(/\$\{[^}]*\}/g, SUBSTITUTION).length;
}

function literalsIn(source: string): string[] {
  return [...source.matchAll(new RegExp(LITERAL, "g"))].map((match) => match[1] ?? match[2] ?? "");
}

/**
 * The end of the expression that starts at `start`: the first comma or closing bracket outside any
 * string or bracket, or the end of the text.
 */
function expressionEnd(text: string, start: number): number {
  let depth = 0;
  for (let at = start; at < text.length; at += 1) {
    const char = text[at]!;
    if (char === '"' || char === "`") {
      at += 1;
      while (at < text.length && text[at] !== char) at += text[at] === "\\" ? 2 : 1;
    } else if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) return at;
      depth -= 1;
    } else if (char === "," && depth === 0) {
      return at;
    }
  }
  return text.length;
}

/**
 * The text of each `does:` property in a source that is a literal, and of each string literal in a
 * `doesFor:` function, which replaces `does` in the tooltip, with the file's path.
 */
export function actionDoesLiterals(path: string, text: string): Array<{ path: string; value: string }> {
  const found: Array<{ path: string; value: string }> = [];
  for (const match of text.matchAll(new RegExp(String.raw`\bdoes:\s*(?:${LITERAL})`, "g"))) {
    found.push({ path, value: match[1] ?? match[2] ?? "" });
  }
  for (const match of text.matchAll(/\bdoesFor:/g)) {
    const start = match.index + match[0].length;
    for (const value of literalsIn(text.slice(start, expressionEnd(text, start)))) found.push({ path, value });
  }
  return found;
}

/**
 * Every string a `hint=` attribute writes into the source, the pieces of a ternary or a template
 * included, as `{ path, value }`. A hint that is a variable or a call is not a literal and is left to
 * the module that owns the text.
 */
export function hintLiterals(path: string, text: string): Array<{ path: string; value: string }> {
  const found: Array<{ path: string; value: string }> = [];
  for (const match of text.matchAll(/\bhint=/g)) {
    const start = match.index + match[0].length;
    let expression = "";
    if (text[start] === '"') {
      expression = text.slice(start, text.indexOf('"', start + 1) + 1);
    } else if (text[start] === "{") {
      let depth = 0;
      let end = start;
      for (; end < text.length; end += 1) {
        if (text[end] === "{") depth += 1;
        else if (text[end] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      expression = text.slice(start, end + 1);
    }
    for (const value of literalsIn(expression)) found.push({ path, value });
  }
  return found;
}

/** What is over the cap, as readable lines for a failing test. */
export function overCap(found: ReadonlyArray<{ path: string; value: string }>, cap: number): string[] {
  return found
    .filter((entry) => lengthOf(entry.value) > cap)
    .map((entry) => `${entry.path}: ${String(lengthOf(entry.value))} characters, ${String(cap)} allowed: "${entry.value.slice(0, 60)}…"`);
}
