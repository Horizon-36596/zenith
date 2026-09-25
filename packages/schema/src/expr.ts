/**
 * The `estimateS` expression grammar (site/docs/file-format.md, robot.json rules).
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := factor (('*' | '/') factor)*
 *   factor  := '-'? primary
 *   primary := number | name | 'max' '(' expr ',' expr ')' | 'min' '(' expr ',' expr ')'
 *            | '(' expr ')'
 *
 * Or the whole string is the literal `"unknown"`, which means the timeline shows a hatched block
 * and the total is a lower bound. Parsing and evaluation are pure: no clock, no randomness.
 */

/** The string that means "this command's duration cannot be predicted". */
export const UNKNOWN_ESTIMATE = "unknown";

export type EstimateExpr =
  | { kind: "unknown" }
  | { kind: "number"; value: number }
  | { kind: "name"; name: string }
  | { kind: "unary"; op: "-"; operand: EstimateExpr }
  | { kind: "binary"; op: "+" | "-" | "*" | "/"; left: EstimateExpr; right: EstimateExpr }
  | { kind: "call"; name: "max" | "min"; args: [EstimateExpr, EstimateExpr] };

export class EstimateExprError extends Error {
  constructor(
    message: string,
    readonly source: string,
    readonly position: number,
  ) {
    super(`${message} in ${JSON.stringify(source)} at ${String(position)}`);
    this.name = "EstimateExprError";
  }
}

type Token =
  | { kind: "number"; value: number; at: number }
  | { kind: "name"; value: string; at: number }
  | { kind: "punct"; value: "+" | "-" | "*" | "/" | "(" | ")" | ","; at: number };

const PUNCT = new Set(["+", "-", "*", "/", "(", ")", ","]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: "punct", value: ch as "+" | "-" | "*" | "/" | "(" | ")" | ",", at: i });
      i += 1;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      const start = i;
      while (i < source.length && source.charAt(i) >= "0" && source.charAt(i) <= "9") i += 1;
      if (source.charAt(i) === ".") {
        i += 1;
        while (i < source.length && source.charAt(i) >= "0" && source.charAt(i) <= "9") i += 1;
      }
      const text = source.slice(start, i);
      tokens.push({ kind: "number", value: Number(text), at: start });
      continue;
    }
    if (isNameStart(ch)) {
      const start = i;
      while (i < source.length && isNamePart(source.charAt(i))) i += 1;
      tokens.push({ kind: "name", value: source.slice(start, i), at: start });
      continue;
    }
    throw new EstimateExprError(`Unexpected character ${JSON.stringify(ch)}`, source, i);
  }
  return tokens;
}

const isNameStart = (ch: string) => (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
const isNamePart = (ch: string) => isNameStart(ch) || (ch >= "0" && ch <= "9");

/** Parses an `estimateS` string. Throws EstimateExprError on anything outside the grammar. */
export function parseEstimateExpression(source: string): EstimateExpr {
  if (source.trim() === UNKNOWN_ESTIMATE) return { kind: "unknown" };
  const tokens = tokenize(source);
  if (tokens.length === 0) throw new EstimateExprError("Empty expression", source, 0);
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const fail = (message: string): never => {
    const token = peek();
    throw new EstimateExprError(message, source, token === undefined ? source.length : token.at);
  };
  const eatPunct = (value: string): boolean => {
    const token = peek();
    if (token !== undefined && token.kind === "punct" && token.value === value) {
      pos += 1;
      return true;
    }
    return false;
  };
  const expectPunct = (value: string): void => {
    if (!eatPunct(value)) fail(`Expected ${JSON.stringify(value)}`);
  };

  const parseExpr = (): EstimateExpr => {
    let left = parseTerm();
    for (;;) {
      const token = peek();
      if (token === undefined || token.kind !== "punct") break;
      if (token.value !== "+" && token.value !== "-") break;
      pos += 1;
      left = { kind: "binary", op: token.value, left, right: parseTerm() };
    }
    return left;
  };

  const parseTerm = (): EstimateExpr => {
    let left = parseFactor();
    for (;;) {
      const token = peek();
      if (token === undefined || token.kind !== "punct") break;
      if (token.value !== "*" && token.value !== "/") break;
      pos += 1;
      left = { kind: "binary", op: token.value, left, right: parseFactor() };
    }
    return left;
  };

  const parseFactor = (): EstimateExpr => {
    if (eatPunct("-")) return { kind: "unary", op: "-", operand: parseFactor() };
    return parsePrimary();
  };

  const parsePrimary = (): EstimateExpr => {
    const token = peek();
    if (token === undefined) return fail("Expected a number, a parameter name or a parenthesis");
    if (token.kind === "number") {
      pos += 1;
      return { kind: "number", value: token.value };
    }
    if (token.kind === "name") {
      pos += 1;
      if (token.value === "max" || token.value === "min") {
        expectPunct("(");
        const first = parseExpr();
        expectPunct(",");
        const second = parseExpr();
        expectPunct(")");
        return { kind: "call", name: token.value, args: [first, second] };
      }
      const next = peek();
      if (next !== undefined && next.kind === "punct" && next.value === "(") {
        return fail(`Unknown function ${JSON.stringify(token.value)}; only max and min exist`);
      }
      return { kind: "name", name: token.value };
    }
    if (token.value === "(") {
      pos += 1;
      const inner = parseExpr();
      expectPunct(")");
      return inner;
    }
    return fail(`Unexpected ${JSON.stringify(token.value)}`);
  };

  const parsed = parseExpr();
  if (pos !== tokens.length) fail("Trailing input");
  return parsed;
}

/** True when the string is a legal `estimateS` value. Used by the robot schema. */
export function isEstimateExpression(source: string): boolean {
  try {
    parseEstimateExpression(source);
    return true;
  } catch {
    return false;
  }
}

/** The parameter names an expression reads, so the caller can check them against the registry. */
export function estimateExpressionNames(expr: EstimateExpr): string[] {
  const names: string[] = [];
  const walk = (node: EstimateExpr): void => {
    switch (node.kind) {
      case "name":
        if (!names.includes(node.name)) names.push(node.name);
        return;
      case "unary":
        walk(node.operand);
        return;
      case "binary":
        walk(node.left);
        walk(node.right);
        return;
      case "call":
        walk(node.args[0]);
        walk(node.args[1]);
        return;
      default:
        return;
    }
  };
  walk(expr);
  return names;
}

/**
 * Evaluates an expression against a scope of parameter values. Returns null for `"unknown"`, for a
 * name the scope does not define, and for division by zero: all three mean "no number here", which
 * the timeline draws as a hatched block rather than a wrong answer.
 */
export function evaluateEstimateExpression(
  expr: EstimateExpr,
  scope: Readonly<Record<string, number>> = {},
): number | null {
  switch (expr.kind) {
    case "unknown":
      return null;
    case "number":
      return expr.value;
    case "name": {
      const value = scope[expr.name];
      return value === undefined ? null : value;
    }
    case "unary": {
      const operand = evaluateEstimateExpression(expr.operand, scope);
      return operand === null ? null : -operand;
    }
    case "binary": {
      const left = evaluateEstimateExpression(expr.left, scope);
      const right = evaluateEstimateExpression(expr.right, scope);
      if (left === null || right === null) return null;
      switch (expr.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return right === 0 ? null : left / right;
      }
      return null;
    }
    case "call": {
      const first = evaluateEstimateExpression(expr.args[0], scope);
      const second = evaluateEstimateExpression(expr.args[1], scope);
      if (first === null || second === null) return null;
      return expr.name === "max" ? Math.max(first, second) : Math.min(first, second);
    }
  }
}

/** Parse and evaluate in one call. Throws on a syntax error, returns null on an unknown value. */
export function evaluateEstimate(
  source: string,
  scope: Readonly<Record<string, number>> = {},
): number | null {
  return evaluateEstimateExpression(parseEstimateExpression(source), scope);
}
