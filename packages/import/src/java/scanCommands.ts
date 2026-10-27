/**
 * Reads a robot's `NamedCommands` registrations out of its Java or Kotlin source, so `robot.json`
 * can be filled in and checked against what the robot really registers (Zenith's ADR 0014).
 *
 * The scanner is deliberately not a Java compiler. It lexes each file (`lex.ts`), finds the calls
 * to `NamedCommands.register` and `NamedCommands.registerCondition`, reads the name, and walks the
 * factory for the argument readers (`argInt`, `argDouble`, `argString`, `argEnum`). A name, key
 * or default it can read for certain is reported; anything it cannot read is an issue that says
 * where and why, never a guess.
 *
 * Pure: the caller reads the files and hands over their text.
 */
import { lex, type Token } from "./lex.js";

/** One source file: its path, as the caller wants it reported (repository-relative is best), and its text. */
export interface SourceFile {
  path: string;
  text: string;
}

export interface SourceLocation {
  path: string;
  /** 1-based. */
  line: number;
}

/** What `argInt`, `argDouble`, `argString` and `argEnum` read, as `robot.json` param types. */
export type ScannedParamType = "integer" | "number" | "string" | "enum";

/** One argument a command's factory reads through the argument helpers. */
export interface ScannedParam {
  key: string;
  type: ScannedParamType;
  /** True when the helper has no fallback, so a step that leaves the argument out fails at init. */
  required: boolean;
  /** The fallback the factory passes, when it is a literal or a constant the scanner could read. */
  default?: number | string;
  /** For an enum: its constants, in declaration order, when the enum is in the scanned sources. */
  values?: string[];
  /** For an enum: the class the factory names, as written (`Intake.Side`). */
  enumType?: string;
  /** Where the (first) read is. */
  at: SourceLocation;
}

export interface ScannedCommand {
  name: string;
  /** Every registration of the name, sorted by path and line. */
  at: SourceLocation[];
  /** In the order the factory first reads them. */
  params: ScannedParam[];
  /**
   * False when the factory hands its arguments to code the scanner cannot see into, reads them
   * directly, or could not be followed at all: then `params` may be missing some.
   */
  complete: boolean;
}

export interface ScannedCondition {
  name: string;
  at: SourceLocation[];
}

export type ScanIssueCode =
  /** A registration whose name is not a string the scanner can read. */
  | "NAME_UNRESOLVED"
  /** A factory the scanner cannot follow, such as a field set elsewhere or a method not in the sources. */
  | "FACTORY_UNRESOLVED"
  /** An argument helper whose key is not a string the scanner can read. */
  | "KEY_UNRESOLVED"
  /** An `argEnum` whose enum class is not declared in the scanned sources, or not uniquely. */
  | "ENUM_UNRESOLVED"
  /** A fallback that is not a literal or a readable constant; the param is kept without a default. */
  | "DEFAULT_UNRESOLVED"
  /** An argument helper told a different command name from the one the factory is registered as. */
  | "COMMAND_ARG_MISMATCH"
  /** The same key read with two different types or defaults. */
  | "PARAM_CONFLICT"
  /** The factory reads the argument map directly (`args.get("key")`), so the type is unknown. */
  | "RAW_ARG_READ"
  /** The factory hands the argument map to code that is not in the scanned sources. */
  | "ARGS_PASSED_ON";

export interface ScanIssue {
  code: ScanIssueCode;
  /** `warning` for something that may leave `robot.json` wrong or short; `info` for a remark. */
  severity: "warning" | "info";
  at: SourceLocation;
  /** The command the issue is about, when it is about one. */
  command?: string;
  message: string;
}

export interface CommandScan {
  commands: ScannedCommand[];
  conditions: ScannedCondition[];
  issues: ScanIssue[];
  /** How many files were read. */
  filesScanned: number;
  /** Registrations whose name could not be read; while this is not 0, a missing name may be one of them. */
  unresolvedRegistrations: number;
}

/** Whether a path is a source file the scanner reads: `.java` or `.kt`. */
export const isScannableSource = (path: string): boolean => /\.(java|kt)$/i.test(path);

/**
 * Directories a scan skips when it walks a tree: build output, tool caches and test sources. Test
 * sources are skipped because a robot's tests often register stand-in commands (a fake intake, a
 * scripted world) that the real robot never has.
 */
export function isSkippedSourcePath(path: string): boolean {
  const dirs = path.replace(/\\/g, "/").split("/").slice(0, -1);
  return dirs.some((part, i) => {
    if (part === "." || part === "..") return false;
    if (part === "node_modules" || part.startsWith(".")) return true;
    // A build or out directory is Gradle's or an IDE's output, but only outside a source set: a
    // package may be called build too, as in src/main/java/org/team/build/.
    if ((part === "build" || part === "out") && !dirs.slice(0, i).includes("src")) return true;
    return dirs[i - 1] === "src" && /^(test|androidTest)/.test(part);
  });
}

// ---------------------------------------------------------------------------------------------
// The index: every file lexed once, with its classes, constants, enums and methods.
// ---------------------------------------------------------------------------------------------

interface ClassSpan {
  /** Simple name. */
  name: string;
  /** `Outer.Inner`. */
  qualified: string;
  /** Index of the body's `{` and of its `}`. */
  open: number;
  close: number;
  /** Declared with `enum` (Java) or `enum class` (Kotlin). */
  isEnum: boolean;
}

interface FileIndex {
  path: string;
  kotlin: boolean;
  tokens: Token[];
  close: Map<number, number>;
  classes: ClassSpan[];
  /** For each token, the index of the innermost `{` around it, or -1. */
  brace: Int32Array;
  /** Whether the file statically imports `NamedCommands.register` (or all of `NamedCommands`). */
  importsRegister: boolean;
  /** Its imports, dotted, without `static`: `org.team.Names.PARK`, `org.team.Names.*`. */
  imports: string[];
  /** Its package, dotted, or empty. */
  pkg: string;
}

interface Decl {
  name: string;
  file: FileIndex;
  /** Index of the name token. */
  at: number;
  /** The initializer, as a token range. */
  start: number;
  end: number;
  /** A field or top-level constant, rather than a local inside a method. */
  member: boolean;
  /** The innermost class it is declared in, qualified, or null at the top level. */
  owner: ClassSpan | null;
}

interface MethodDecl {
  name: string;
  file: FileIndex;
  /** Index of the `(` of the parameter list. */
  paramsOpen: number;
  params: string[];
  /** The body, as a token range (a `{}` block's inside, or an `= expression`). */
  bodyStart: number;
  bodyEnd: number;
  owner: ClassSpan | null;
}

interface EnumDecl {
  name: string;
  qualified: string;
  constants: string[];
}

interface Index {
  files: FileIndex[];
  members: Map<string, Decl[]>;
  locals: Map<FileIndex, Decl[]>;
  methods: Map<string, MethodDecl[]>;
  methodsByFile: Map<FileIndex, MethodDecl[]>;
  enums: Map<string, EnumDecl[]>;
}

/** Words that precede a call or an expression, never a declared name. */
const NOT_A_TYPE = new Set([
  "return", "new", "throw", "else", "case", "yield", "in", "is", "as", "assert", "do", "when", "try",
  "if", "while", "for", "switch", "catch", "synchronized", "super", "this", "not", "instanceof", "and", "or",
  "default", "package", "import", "val", "var", "fun", "to", "throws", "extends", "implements", "break", "continue",
]);

/** Names followed by `(` that are statements, not calls. */
const NOT_A_CALL = new Set(["if", "while", "for", "switch", "catch", "synchronized", "return", "when", "try", "super", "this", "throw", "assert"]);

const HELPERS = new Set(["argInt", "argDouble", "argString", "argEnum"]);

const isPunct = (token: Token | undefined, text: string): boolean => token?.kind === "punct" && token.text === text;
const isIdent = (token: Token | undefined, text?: string): boolean =>
  token?.kind === "ident" && (text === undefined || token.text === text);

/**
 * The token before `k` names a type, so `tokens[k]` is being declared, not used. A `?` ends a
 * nullable type only in Kotlin; in Java it is the ternary, which a call may follow.
 */
function declaresAt(tokens: readonly Token[], k: number, kotlin: boolean): boolean {
  const prev = tokens[k - 1];
  if (prev === undefined) return false;
  if (prev.kind === "ident") return !NOT_A_TYPE.has(prev.text) || prev.text === "fun";
  return isPunct(prev, ">") || isPunct(prev, "]") || (kotlin && isPunct(prev, "?"));
}

function indexFile(source: SourceFile): FileIndex {
  const kotlin = /\.kt$/i.test(source.path);
  const { tokens, close } = lex(source.text, kotlin);

  const brace = new Int32Array(tokens.length).fill(-1);
  const stack: number[] = [];
  for (let t = 0; t < tokens.length; t += 1) {
    while (stack.length > 0 && (close.get(stack[stack.length - 1] as number) ?? tokens.length) < t) stack.pop();
    brace[t] = stack.length === 0 ? -1 : (stack[stack.length - 1] as number);
    if (isPunct(tokens[t], "{")) stack.push(t);
  }

  const classes: ClassSpan[] = [];
  for (let t = 0; t < tokens.length; t += 1) {
    const token = tokens[t] as Token;
    if (token.kind !== "ident" || !["class", "interface", "enum", "object", "record"].includes(token.text)) continue;
    const prev = tokens[t - 1];
    if (isPunct(prev, ".") || isPunct(prev, "::")) continue;
    // `enum class Gate` in Kotlin is read at `enum`; its `class` is not a second declaration.
    if (token.text === "class" && isIdent(prev, "enum")) continue;
    // `enum class Gate` in Kotlin: the name follows `class`.
    let nameAt = t + 1;
    if (token.text === "enum" && isIdent(tokens[nameAt], "class")) nameAt += 1;
    const nameToken = tokens[nameAt];
    // A Kotlin companion object has no name; its members are read as the outer class's.
    if (nameToken === undefined || nameToken.kind !== "ident") continue;
    let open = -1;
    for (let j = nameAt + 1; j < tokens.length; j += 1) {
      const at = tokens[j] as Token;
      if (isPunct(at, "{")) {
        open = j;
        break;
      }
      if (isPunct(at, ";") || isPunct(at, "}") || isPunct(at, "=")) break;
      if (isPunct(at, "(") || isPunct(at, "[")) j = close.get(j) ?? j;
    }
    if (open === -1) continue;
    const outer = classes.filter((span) => span.open < open && span.close > open).pop();
    classes.push({
      name: nameToken.text,
      qualified: outer === undefined ? nameToken.text : `${outer.qualified}.${nameToken.text}`,
      open,
      close: close.get(open) ?? tokens.length,
      isEnum: token.text === "enum",
    });
  }

  let importsRegister = false;
  const imports: string[] = [];
  let pkg = "";
  const lineText = (t: number): string => {
    let text = "";
    for (let j = t + 1; j < tokens.length; j += 1) {
      const at = tokens[j] as Token;
      if (at.line !== (tokens[t] as Token).line || isPunct(at, ";")) break;
      if (!isIdent(at, "static")) text += at.text;
    }
    return text;
  };
  for (let t = 0; t < tokens.length; t += 1) {
    // Only at the top of the file: an `import` or `package` word inside a class is something else.
    if (braceAround(brace, t) !== -1) continue;
    if (isIdent(tokens[t], "package") && pkg === "") pkg = lineText(t);
    if (!isIdent(tokens[t], "import")) continue;
    const text = lineText(t);
    imports.push(text);
    if (/NamedCommands\.(register|registerCondition|\*)$/.test(text)) importsRegister = true;
  }

  return { path: source.path, kotlin, tokens, close, classes, brace, importsRegister, imports, pkg };
}

/** The innermost `{` around token `t`, or -1 at the top level of the file. */
const braceAround = (brace: Int32Array, t: number): number => brace[t] ?? -1;

function ownerOf(file: FileIndex, t: number): ClassSpan | null {
  let best: ClassSpan | null = null;
  for (const span of file.classes) {
    if (span.open < t && span.close > t && (best === null || span.open > best.open)) best = span;
  }
  return best;
}

/**
 * Where an expression that starts at `start` ends: at a `;` or `,` at its own depth, at a closer
 * of an enclosing bracket, or, in Kotlin, at a line break that does not continue the expression.
 */
function expressionEnd(file: FileIndex, start: number): number {
  const { tokens, close } = file;
  const continues = new Set(["+", "-", "*", "/", "%", ".", "?.", "?:", ",", "(", "=", "->", "&&", "||", "::"]);
  let t = start;
  while (t < tokens.length) {
    const token = tokens[t] as Token;
    if (token.kind === "punct") {
      if (token.text === ";" || token.text === "," || token.text === ")" || token.text === "]" || token.text === "}") return t;
      if (token.text === "(" || token.text === "[" || token.text === "{") {
        t = (close.get(t) ?? tokens.length) + 1;
        if (file.kotlin && endsKotlinLine(tokens, t, continues)) return t;
        continue;
      }
    }
    t += 1;
    if (file.kotlin && endsKotlinLine(tokens, t, continues)) return t;
  }
  return tokens.length;
}

function endsKotlinLine(tokens: readonly Token[], t: number, continues: ReadonlySet<string>): boolean {
  const prev = tokens[t - 1];
  const next = tokens[t];
  if (prev === undefined || next === undefined || next.line === prev.line) return false;
  if (prev.kind === "punct" && continues.has(prev.text)) return false;
  if (next.kind === "punct" && [".", "?.", "?:", "+", "-", "*", "/", "&&", "||"].includes(next.text)) return false;
  return true;
}

/** Splits a bracketed list into its top-level comma-separated ranges. `angles` also nests `<...>`. */
function splitList(file: FileIndex, open: number, angles: boolean): Array<[number, number]> {
  const { tokens, close } = file;
  const end = close.get(open) ?? tokens.length;
  const parts: Array<[number, number]> = [];
  let start = open + 1;
  let angle = 0;
  for (let t = open + 1; t < end; t += 1) {
    const token = tokens[t] as Token;
    if (token.kind === "punct") {
      if (token.text === "(" || token.text === "[" || token.text === "{") {
        t = close.get(t) ?? end;
        continue;
      }
      if (angles && token.text === "<") angle += 1;
      else if (angles && token.text === ">" && angle > 0) angle -= 1;
      else if (token.text === "," && angle === 0) {
        parts.push([start, t]);
        start = t + 1;
      }
    }
  }
  if (end > start) parts.push([start, end]);
  return parts;
}

/** The names a parameter list declares: Java's last identifier of each part, Kotlin's name before `:`. */
function paramNames(file: FileIndex, open: number): string[] {
  return splitList(file, open, true).map(([start, end]) => {
    const tokens = file.tokens.slice(start, end);
    const colon = tokens.findIndex((token) => isPunct(token, ":"));
    if (file.kotlin && colon > 0) return (tokens[colon - 1] as Token).text;
    const idents = tokens.filter((token) => token.kind === "ident" && token.text !== "final");
    return idents.length === 0 ? "" : (idents[idents.length - 1] as Token).text;
  });
}

function collectDecls(file: FileIndex, members: Map<string, Decl[]>, locals: Decl[]): void {
  const { tokens } = file;
  const classOpens = new Set(file.classes.map((span) => span.open));
  for (let k = 1; k < tokens.length; k += 1) {
    if (!isPunct(tokens[k], "=")) continue;
    let nameAt = -1;
    if (file.kotlin) {
      for (let j = k - 1; j >= 0 && j >= k - 12; j -= 1) {
        const at = tokens[j] as Token;
        if (at.line !== (tokens[k] as Token).line) break;
        if (isIdent(at, "val") || isIdent(at, "var")) {
          if (isIdent(tokens[j + 1])) nameAt = j + 1;
          break;
        }
        if (at.kind === "punct" && ![".", "<", ">", "?", ":", ","].includes(at.text)) break;
      }
    } else if (isIdent(tokens[k - 1]) && declaresAt(tokens, k - 1, false)) {
      nameAt = k - 1;
    }
    if (nameAt === -1) continue;
    const start = k + 1;
    const end = expressionEnd(file, start);
    const enclosing = file.brace[nameAt] ?? -1;
    const member = enclosing === -1 || classOpens.has(enclosing);
    const decl: Decl = { name: (tokens[nameAt] as Token).text, file, at: nameAt, start, end, member, owner: ownerOf(file, nameAt) };
    if (member) {
      const list = members.get(decl.name) ?? [];
      list.push(decl);
      members.set(decl.name, list);
    } else {
      locals.push(decl);
    }
  }
}

function collectMethods(file: FileIndex): MethodDecl[] {
  const { tokens, close } = file;
  const out: MethodDecl[] = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k] as Token;
    if (token.kind !== "ident" || !isPunct(tokens[k + 1], "(") || NOT_A_CALL.has(token.text)) continue;
    let isDecl: boolean;
    if (file.kotlin) {
      // `fun name(`, `fun <T> name(` or `fun Receiver.name(`.
      isDecl = false;
      for (let j = k - 1; j >= 0 && j >= k - 8; j -= 1) {
        const at = tokens[j] as Token;
        if (isIdent(at, "fun")) {
          isDecl = true;
          break;
        }
        if (!(at.kind === "ident" || isPunct(at, ".") || isPunct(at, "<") || isPunct(at, ">") || isPunct(at, ","))) break;
      }
    } else {
      isDecl = declaresAt(tokens, k, false);
    }
    if (!isDecl) continue;
    const paramsOpen = k + 1;
    const paramsClose = close.get(paramsOpen) ?? tokens.length;
    let j = paramsClose + 1;
    if (!file.kotlin && isIdent(tokens[j], "throws")) {
      j += 1;
      while (j < tokens.length && (isIdent(tokens[j]) || isPunct(tokens[j], ".") || isPunct(tokens[j], ","))) j += 1;
    }
    if (file.kotlin && isPunct(tokens[j], ":")) {
      let angle = 0;
      while (j < tokens.length) {
        const at = tokens[j] as Token;
        if (isPunct(at, "<")) angle += 1;
        else if (isPunct(at, ">")) angle -= 1;
        else if (angle <= 0 && (isPunct(at, "{") || isPunct(at, "=") || isPunct(at, ";") || isPunct(at, "}"))) break;
        else if (isPunct(at, "(")) j = close.get(j) ?? j;
        j += 1;
      }
    }
    let bodyStart: number;
    let bodyEnd: number;
    if (isPunct(tokens[j], "{")) {
      bodyStart = j + 1;
      bodyEnd = close.get(j) ?? tokens.length;
    } else if (file.kotlin && isPunct(tokens[j], "=")) {
      bodyStart = j + 1;
      bodyEnd = expressionEnd(file, bodyStart);
    } else {
      continue;
    }
    out.push({
      name: token.text,
      file,
      paramsOpen,
      params: paramNames(file, paramsOpen),
      bodyStart,
      bodyEnd,
      owner: ownerOf(file, k),
    });
  }
  return out;
}

function collectEnums(file: FileIndex, enums: Map<string, EnumDecl[]>): void {
  const { tokens, close } = file;
  for (const span of file.classes) {
    if (!span.isEnum) continue;
    const constants: string[] = [];
    let k = span.open + 1;
    while (k < span.close) {
      const token = tokens[k] as Token;
      if (isPunct(token, ";") || isPunct(token, "}")) break;
      if (isPunct(token, "@")) {
        k += 2;
        if (isPunct(tokens[k], "(")) k = (close.get(k) ?? k) + 1;
        continue;
      }
      if (token.kind === "ident") {
        constants.push(token.text);
        k += 1;
        if (isPunct(tokens[k], "(")) k = (close.get(k) ?? k) + 1;
        if (isPunct(tokens[k], "{")) k = (close.get(k) ?? k) + 1;
        if (isPunct(tokens[k], ",")) k += 1;
        continue;
      }
      k += 1;
    }
    const list = enums.get(span.name) ?? [];
    list.push({ name: span.name, qualified: span.qualified, constants });
    enums.set(span.name, list);
  }
}

function buildIndex(sources: readonly SourceFile[]): Index {
  const files = [...sources]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(indexFile);
  const members = new Map<string, Decl[]>();
  const locals = new Map<FileIndex, Decl[]>();
  const methods = new Map<string, MethodDecl[]>();
  const methodsByFile = new Map<FileIndex, MethodDecl[]>();
  const enums = new Map<string, EnumDecl[]>();
  for (const file of files) {
    const fileLocals: Decl[] = [];
    collectDecls(file, members, fileLocals);
    locals.set(file, fileLocals);
    const fileMethods = collectMethods(file);
    methodsByFile.set(file, fileMethods);
    for (const method of fileMethods) {
      const list = methods.get(method.name) ?? [];
      list.push(method);
      methods.set(method.name, list);
    }
    collectEnums(file, enums);
  }
  return { files, members, locals, methods, methodsByFile, enums };
}

// ---------------------------------------------------------------------------------------------
// Reading constant expressions.
// ---------------------------------------------------------------------------------------------

/** What a name is known to stand for while a factory or a wrapper is followed. */
type Binding = { kind: "args" } | { kind: "string"; value: string } | { kind: "number"; value: number } | { kind: "opaque" };
type Env = ReadonlyMap<string, Binding>;

type Resolved<T> = { ok: true; value: T } | { ok: false; why: string };

const tokenText = (file: FileIndex, start: number, end: number): string => {
  let out = "";
  for (let t = start; t < end; t += 1) {
    const token = file.tokens[t] as Token;
    const prev = file.tokens[t - 1];
    const glue = t === start || token.kind === "punct" || (prev !== undefined && prev.kind === "punct" && prev.text !== ",");
    out += (glue ? "" : " ") + token.text;
  }
  return out.length > 60 ? `${out.slice(0, 57)}...` : out;
};

/** The method whose parameters or body contain token `t`. */
function enclosingMethod(index: Index, file: FileIndex, t: number): MethodDecl | null {
  let best: MethodDecl | null = null;
  for (const method of index.methodsByFile.get(file) ?? []) {
    if (method.paramsOpen <= t && t < method.bodyEnd && (best === null || method.paramsOpen > best.paramsOpen)) best = method;
  }
  return best;
}

/**
 * Whether `name` is declared without a value between `from` and `use`: a parameter, a loop
 * variable or a lambda parameter, whose value the scanner cannot know.
 */
function declaredWithoutValue(file: FileIndex, name: string, from: number, use: number): boolean {
  const { tokens, close } = file;
  for (let t = from; t < use; t += 1) {
    const token = tokens[t] as Token;
    if (token.kind !== "ident" || token.text !== name) continue;
    const next = tokens[t + 1];
    if (isPunct(next, "=")) continue;
    if (isPunct(next, "->")) return true;
    if (declaresAt(tokens, t, file.kotlin) && (isPunct(next, ":") || isPunct(next, ")") || isPunct(next, ",") || isPunct(next, ";") || isIdent(next, "in"))) return true;
    if (isPunct(tokens[t - 1], "(") && isIdent(next, "in")) return true;
    // Inside a `( ... ) ->` lambda parameter list.
    for (let o = t - 1; o >= from && o >= t - 16; o -= 1) {
      if (isPunct(tokens[o], "(")) {
        const c = close.get(o) ?? -1;
        if (c > t && isPunct(tokens[c + 1], "->")) return true;
        break;
      }
    }
  }
  return false;
}

/** A dotted name, `A.B.C`, spanning exactly `[start, end)`; null otherwise. */
function dottedName(file: FileIndex, start: number, end: number): string[] | null {
  const parts: string[] = [];
  for (let t = start; t < end; t += 1) {
    const token = file.tokens[t] as Token;
    if ((t - start) % 2 === 0) {
      if (token.kind !== "ident") return null;
      parts.push(token.text);
    } else if (!isPunct(token, ".")) {
      return null;
    }
  }
  return parts.length === 0 || (end - start) % 2 === 0 ? null : parts;
}

interface Resolver {
  index: Index;
  /** Decls being evaluated, so `A = B; B = A` cannot loop. */
  active: Set<Decl>;
}

/** The candidates a name used at `use` in `file` can refer to, nearest scope first. */
function lookup(r: Resolver, file: FileIndex, use: number, parts: readonly string[]): Decl[] | "shadowed" {
  const name = parts[parts.length - 1] as string;
  const qualifier = parts.slice(0, -1);
  if (qualifier.length === 0 || (qualifier.length === 1 && qualifier[0] === "this")) {
    if (qualifier.length === 0) {
      const method = enclosingMethod(r.index, file, use);
      const from = method?.paramsOpen ?? Math.max(0, file.brace[use] ?? 0);
      // A local is in scope when the block it is declared in holds the use, and it comes first.
      const localHits = (r.index.locals.get(file) ?? []).filter((decl) => {
        if (decl.name !== name || decl.at >= use) return false;
        const block = file.brace[decl.at] ?? -1;
        return block === -1 || (block < use && (file.close.get(block) ?? file.tokens.length) > use);
      });
      if (localHits.length > 0) return [localHits[localHits.length - 1] as Decl];
      if (declaredWithoutValue(file, name, from, use)) return "shadowed";
    }
    const all = r.index.members.get(name) ?? [];
    // Fields of the classes around the use, innermost first; then constants in the same file;
    // then a constant the file imports by name or by `*`, or a Kotlin top-level constant of the
    // same package. Nothing else: a field set in a constructor must not be read as a same-named
    // constant of some other class.
    const around = file.classes.filter((span) => span.open < use && span.close > use).sort((a, b) => b.open - a.open);
    for (const span of around) {
      const hits = all.filter((decl) => decl.file === file && decl.owner === span);
      if (hits.length > 0) return hits;
    }
    const sameFile = all.filter((decl) => decl.file === file);
    if (sameFile.length > 0 || qualifier.length > 0) return sameFile;
    return all.filter((decl) => isImportedInto(file, decl));
  }
  const wanted = qualifier.join(".");
  return (r.index.members.get(name) ?? []).filter((decl) => {
    const owner = decl.owner?.qualified ?? "";
    return owner === wanted || owner.endsWith(`.${wanted}`) || wanted.endsWith(`.${owner}`) || decl.owner?.name === qualifier[qualifier.length - 1];
  });
}

/** Whether `file` can name `decl` without a qualifier: a static import of it or of its class's `*`, or Kotlin's same package. */
function isImportedInto(file: FileIndex, decl: Decl): boolean {
  const owner = decl.owner;
  if (owner === null) {
    // A Kotlin top-level constant: visible in its own package, or imported as `pkg.NAME`.
    return decl.file.pkg === file.pkg || file.imports.some((text) => text === `${decl.file.pkg}.${decl.name}` || text === `${decl.file.pkg}.*`);
  }
  const ownerPath = owner.qualified;
  const endsWith = (text: string, tail: string): boolean => text === tail || text.endsWith(`.${tail}`);
  return file.imports.some((text) => endsWith(text, `${ownerPath}.${decl.name}`) || endsWith(text, `${ownerPath}.*`));
}

function resolveDecls<T>(r: Resolver, decls: readonly Decl[], read: (decl: Decl) => Resolved<T>, label: string): Resolved<T> {
  const values: T[] = [];
  let why = "";
  for (const decl of decls) {
    if (r.active.has(decl)) continue;
    r.active.add(decl);
    const got = read(decl);
    r.active.delete(decl);
    if (got.ok) {
      if (!values.includes(got.value)) values.push(got.value);
    } else {
      why = got.why;
    }
  }
  if (values.length === 1) return { ok: true, value: values[0] as T };
  if (values.length > 1) return { ok: false, why: `${label} has more than one value in the scanned sources (${values.map((v) => JSON.stringify(v)).join(", ")})` };
  return { ok: false, why: why || `${label} is not a constant in the scanned sources` };
}

/** A string constant expression: literals, constants and `+` between them. */
function resolveString(r: Resolver, file: FileIndex, start: number, end: number, env: Env): Resolved<string> {
  const { tokens, close } = file;
  if (start >= end) return { ok: false, why: "nothing to read" };
  // Split at top-level `+`.
  const terms: Array<[number, number]> = [];
  let termStart = start;
  for (let t = start; t < end; t += 1) {
    const token = tokens[t] as Token;
    if (isPunct(token, "(") || isPunct(token, "[") || isPunct(token, "{")) {
      t = close.get(t) ?? end;
      continue;
    }
    if (isPunct(token, "+")) {
      terms.push([termStart, t]);
      termStart = t + 1;
    }
  }
  terms.push([termStart, end]);
  let out = "";
  for (const [s, e] of terms) {
    const got = resolveStringTerm(r, file, s, e, env);
    if (!got.ok) return got;
    out += got.value;
  }
  return { ok: true, value: out };
}

function resolveStringTerm(r: Resolver, file: FileIndex, start: number, end: number, env: Env): Resolved<string> {
  const { tokens, close } = file;
  const first = tokens[start];
  if (first === undefined || start >= end) return { ok: false, why: "nothing to read" };
  if (end - start === 1 && first.kind === "string") {
    return first.value === null || first.value === undefined
      ? { ok: false, why: `${first.text} is a string template, whose value is only known when it runs` }
      : { ok: true, value: first.value };
  }
  if (isPunct(first, "(") && close.get(start) === end - 1) return resolveString(r, file, start + 1, end - 1, env);
  const parts = dottedName(file, start, end);
  if (parts === null) return { ok: false, why: `${tokenText(file, start, end)} is not a string literal or a constant` };
  if (parts.length === 1) {
    const bound = env.get(parts[0] as string);
    if (bound !== undefined) {
      return bound.kind === "string" ? { ok: true, value: bound.value } : { ok: false, why: `${parts[0] as string} is only known when the code runs` };
    }
  }
  const decls = lookup(r, file, start, parts);
  if (decls === "shadowed") return { ok: false, why: `${parts.join(".")} is a parameter or a loop variable, only known when the code runs` };
  return resolveDecls(r, decls, (decl) => resolveString(r, decl.file, decl.start, decl.end, new Map()), parts.join("."));
}

function parseNumber(text: string): number | null {
  const clean = text.replace(/_/g, "").replace(/[lLfFdDuU]+$/, "");
  if (/^0[xX][0-9a-fA-F]+$/.test(clean)) return parseInt(clean.slice(2), 16);
  if (/^0[bB][01]+$/.test(clean)) return parseInt(clean.slice(2), 2);
  const value = Number(clean);
  return Number.isFinite(value) ? value : null;
}

/** A numeric constant: a literal, an optional sign, or a constant that is one. */
function resolveNumber(r: Resolver, file: FileIndex, start: number, end: number, env: Env): Resolved<number> {
  const { tokens, close } = file;
  const first = tokens[start];
  if (first === undefined || start >= end) return { ok: false, why: "nothing to read" };
  if (isPunct(first, "-") || isPunct(first, "+")) {
    const got = resolveNumber(r, file, start + 1, end, env);
    return got.ok && isPunct(first, "-") ? { ok: true, value: -got.value } : got;
  }
  if (isPunct(first, "(") && close.get(start) === end - 1) {
    // A cast, `(double) 4`, or parentheses.
    const inner = resolveNumber(r, file, start + 1, end - 1, env);
    if (inner.ok) return inner;
    const after = (close.get(start) ?? end) + 1;
    return after < end ? resolveNumber(r, file, after, end, env) : inner;
  }
  if (isPunct(first, "(")) {
    const after = (close.get(start) ?? end) + 1;
    if (after < end && dottedName(file, start + 1, after - 1) !== null) return resolveNumber(r, file, after, end, env);
  }
  if (end - start === 1 && first.kind === "number") {
    const value = parseNumber(first.text);
    return value === null ? { ok: false, why: `${first.text} is not a number the scanner reads` } : { ok: true, value };
  }
  const parts = dottedName(file, start, end);
  if (parts === null) return { ok: false, why: `${tokenText(file, start, end)} is not a number literal or a constant` };
  if (parts.length === 1) {
    const bound = env.get(parts[0] as string);
    if (bound !== undefined) {
      return bound.kind === "number" ? { ok: true, value: bound.value } : { ok: false, why: `${parts[0] as string} is only known when the code runs` };
    }
  }
  const decls = lookup(r, file, start, parts);
  if (decls === "shadowed") return { ok: false, why: `${parts.join(".")} is a parameter or a loop variable, only known when the code runs` };
  return resolveDecls(r, decls, (decl) => resolveNumber(r, decl.file, decl.start, decl.end, new Map()), parts.join("."));
}

/** Binds a followed method's parameters to what the call site passes. */
function bindCall(r: Resolver, file: FileIndex, args: ReadonlyArray<[number, number]>, env: Env, params: readonly string[]): Map<string, Binding> {
  const out = new Map<string, Binding>();
  params.forEach((param, i) => {
    const range = args[i];
    if (param === "" || param === "_" || range === undefined) return;
    const [s, e] = range;
    if (e - s === 1 && isIdent(file.tokens[s]) && env.get((file.tokens[s] as Token).text)?.kind === "args") {
      out.set(param, { kind: "args" });
      return;
    }
    const text = resolveString(r, file, s, e, env);
    if (text.ok) {
      out.set(param, { kind: "string", value: text.value });
      return;
    }
    const number = resolveNumber(r, file, s, e, env);
    out.set(param, number.ok ? { kind: "number", value: number.value } : { kind: "opaque" });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Following factories.
// ---------------------------------------------------------------------------------------------

interface Read {
  key: string;
  type: ScannedParamType;
  required: boolean;
  default?: number | string;
  values?: string[];
  enumType?: string;
  at: SourceLocation;
}

interface FactoryResult {
  reads: Read[];
  complete: boolean;
}

interface Ctx {
  r: Resolver;
  issues: ScanIssue[];
  /** The name the factory is registered as. */
  command: string;
  /** Methods already followed for this factory. */
  visited: Set<MethodDecl>;
}

const MAX_DEPTH = 6;

const locate = (file: FileIndex, t: number): SourceLocation => ({
  path: file.path,
  line: (file.tokens[Math.min(t, file.tokens.length - 1)] as Token | undefined)?.line ?? 1,
});

function issue(ctx: Ctx, code: ScanIssueCode, file: FileIndex, t: number, message: string, severity: "warning" | "info" = "warning"): void {
  ctx.issues.push({ code, severity, at: locate(file, t), command: ctx.command, message });
}

/** The methods a name used at `use` in `file` may call: the same file's first, then a unique one elsewhere. */
function methodsNamed(index: Index, file: FileIndex, name: string, qualifier: string | null): MethodDecl[] {
  const all = index.methods.get(name) ?? [];
  if (qualifier !== null && qualifier !== "this") {
    const owned = all.filter((method) => method.owner?.name === qualifier || method.owner?.qualified === qualifier);
    if (owned.length > 0) return owned;
  }
  const sameFile = all.filter((method) => method.file === file);
  if (sameFile.length > 0 || qualifier === "this") return sameFile;
  return all;
}

function analyzeFactory(ctx: Ctx, file: FileIndex, start: number, end: number, env: Env, depth: number): FactoryResult {
  const { tokens, close } = file;
  const first = tokens[start];
  if (first === undefined || start >= end) return { reads: [], complete: false };

  // A Java lambda: `(args, ctx) -> body` or `args -> body`.
  if (isPunct(first, "(") && isPunct(tokens[(close.get(start) ?? end) + 1], "->")) {
    const params = paramNames(file, start);
    const bodyStart = (close.get(start) ?? end) + 2;
    return scanBody(ctx, file, bodyStart, end, withArgs(env, params[0]), depth);
  }
  if (isIdent(first) && isPunct(tokens[start + 1], "->")) {
    return scanBody(ctx, file, start + 2, end, withArgs(env, first.text), depth);
  }

  // A Kotlin lambda: `{ args, ctx -> body }`.
  if (isPunct(first, "{") && close.get(start) === end - 1) {
    const inner = end - 1;
    let arrow = -1;
    for (let t = start + 1; t < inner; t += 1) {
      if (isPunct(tokens[t], "->")) {
        arrow = t;
        break;
      }
      if (isPunct(tokens[t], "(") || isPunct(tokens[t], "{") || isPunct(tokens[t], "[")) break;
    }
    const params = arrow === -1 ? ["it"] : tokenRangeIdents(file, start + 1, arrow);
    return scanBody(ctx, file, arrow === -1 ? start + 1 : arrow + 1, inner, withArgs(env, params[0]), depth);
  }

  // A method reference: `this::build`, `Commands::shoot`.
  const refAt = findTopLevel(file, start, end, "::");
  if (refAt !== -1 && refAt === end - 2 && isIdent(tokens[end - 1])) {
    const name = (tokens[end - 1] as Token).text;
    const qualifier = refAt > start ? tokenText(file, start, refAt) : null;
    const methods = methodsNamed(ctx.r.index, file, name, qualifier);
    if (methods.length === 0) {
      issue(ctx, "FACTORY_UNRESOLVED", file, start, `The factory ${tokenText(file, start, end)} names a method that is not in the scanned sources, so the arguments it reads are not listed.`);
      return { reads: [], complete: false };
    }
    return mergeResults(methods.map((method) => followMethod(ctx, method, new Map([[method.params[0] ?? "", { kind: "args" } as Binding]]), depth + 1)));
  }

  // An anonymous class: `new NamedCommands.Factory() { ... build(...) { ... } }`.
  if (isIdent(first, "new")) {
    const brace = findTopLevel(file, start, end, "{", true);
    if (brace !== -1) {
      const bodyEnd = close.get(brace) ?? end;
      const build = (ctx.r.index.methodsByFile.get(file) ?? []).find((method) => method.name === "build" && method.paramsOpen > brace && method.bodyEnd <= bodyEnd);
      if (build !== undefined) return followMethod(ctx, build, new Map([[build.params[0] ?? "", { kind: "args" } as Binding]]), depth + 1);
      return scanBody(ctx, file, brace + 1, bodyEnd, env, depth);
    }
  }

  // A name for a factory held elsewhere: a field or a local set to a lambda.
  const parts = dottedName(file, start, end);
  if (parts !== null) {
    const decls = lookup(ctx.r, file, start, parts);
    if (decls !== "shadowed" && decls.length > 0) {
      return mergeResults(decls.filter((decl) => !ctx.r.active.has(decl)).map((decl) => {
        ctx.r.active.add(decl);
        const got = analyzeFactory(ctx, decl.file, decl.start, decl.end, new Map(), depth + 1);
        ctx.r.active.delete(decl);
        return got;
      }));
    }
    issue(ctx, "FACTORY_UNRESOLVED", file, start, `The factory ${parts.join(".")} is not set to a lambda or a method reference in the scanned sources, so the arguments it reads are not listed.`);
    return { reads: [], complete: false };
  }

  // A call that builds the factory: `shooter(3)` or `Factories.shoot()`.
  const callOpen = end - 1 >= start && isPunct(tokens[end - 1], ")") ? findOpener(file, start, end - 1) : -1;
  if (callOpen > start && isIdent(tokens[callOpen - 1])) {
    const name = (tokens[callOpen - 1] as Token).text;
    const qualifier = callOpen - 2 > start ? tokenText(file, start, callOpen - 2) : null;
    const methods = methodsNamed(ctx.r.index, file, name, qualifier);
    if (methods.length > 0) {
      const args = splitList(file, callOpen, false);
      return mergeResults(methods.map((method) => followMethod(ctx, method, bindCall(ctx.r, file, args, env, method.params), depth + 1)));
    }
  }

  issue(ctx, "FACTORY_UNRESOLVED", file, start, `The factory ${tokenText(file, start, end)} is not a lambda, a method reference or a method in the scanned sources, so the arguments it reads are not listed.`);
  return { reads: [], complete: false };
}

function withArgs(env: Env, name: string | undefined): Env {
  const out = new Map(env);
  if (name !== undefined && name !== "" && name !== "_") out.set(name, { kind: "args" });
  return out;
}

function tokenRangeIdents(file: FileIndex, start: number, end: number): string[] {
  const names: string[] = [];
  let current = "";
  for (let t = start; t < end; t += 1) {
    const token = file.tokens[t] as Token;
    if (isPunct(token, ",")) {
      names.push(current);
      current = "";
    } else if (token.kind === "ident" && current === "") {
      current = token.text;
    }
  }
  names.push(current);
  return names;
}

/** The index of `text` at the top level of `[start, end)`, or -1. `inclusive` also matches an opener. */
function findTopLevel(file: FileIndex, start: number, end: number, text: string, inclusive = false): number {
  const { tokens, close } = file;
  for (let t = start; t < end; t += 1) {
    const token = tokens[t] as Token;
    if (token.kind === "punct" && token.text === text) return t;
    if (!inclusive || token.text !== text) {
      if (isPunct(token, "(") || isPunct(token, "[") || isPunct(token, "{")) t = close.get(t) ?? end;
    }
  }
  return -1;
}

/** The opener whose closer is `closer`, searching from `start`. */
function findOpener(file: FileIndex, start: number, closer: number): number {
  for (let t = start; t < closer; t += 1) if (file.close.get(t) === closer) return t;
  return -1;
}

function followMethod(ctx: Ctx, method: MethodDecl, env: Env, depth: number): FactoryResult {
  // A method already being followed is a recursion whose reads are counted once; one past the
  // depth limit is code the scanner did not read, so the factory may read more than it lists.
  if (ctx.visited.has(method)) return { reads: [], complete: true };
  if (depth > MAX_DEPTH) return { reads: [], complete: false };
  ctx.visited.add(method);
  const got = scanBody(ctx, method.file, method.bodyStart, method.bodyEnd, env, depth);
  ctx.visited.delete(method);
  return got;
}

function mergeResults(results: readonly FactoryResult[]): FactoryResult {
  return {
    reads: results.flatMap((result) => result.reads),
    complete: results.length > 0 && results.every((result) => result.complete),
  };
}

const MAP_READS = new Set(["get", "getOrDefault", "containsKey", "keySet", "entrySet", "values", "forEach", "size", "isEmpty"]);

/** Walks a factory body for argument reads, following calls that hand the argument map on. */
function scanBody(ctx: Ctx, file: FileIndex, start: number, end: number, inherited: Env, depth: number): FactoryResult {
  const { tokens, close } = file;
  const env = new Map(inherited);
  const reads: Read[] = [];
  let complete = true;
  const isArgs = (t: number): boolean => isIdent(tokens[t]) && env.get((tokens[t] as Token).text)?.kind === "args" && !isPunct(tokens[t - 1], ".");

  for (let k = start; k < end; k += 1) {
    const token = tokens[k] as Token;

    // A nested two-parameter lambda names its own argument map: `return (a, c) -> ...`.
    if (isPunct(token, "(") && isPunct(tokens[(close.get(k) ?? end) + 1], "->")) {
      const params = paramNames(file, k);
      if (params.length === 2 && params[0] !== undefined && params[0] !== "") env.set(params[0], { kind: "args" });
      continue;
    }
    if (file.kotlin && isPunct(token, "{")) {
      const names: string[] = [];
      let t = k + 1;
      while (isIdent(tokens[t]) && (isPunct(tokens[t + 1], ",") || isPunct(tokens[t + 1], "->"))) {
        names.push((tokens[t] as Token).text);
        if (isPunct(tokens[t + 1], "->")) break;
        t += 2;
      }
      if (names.length === 2 && names[0] !== "_") env.set(names[0] as string, { kind: "args" });
      continue;
    }

    if (token.kind !== "ident") continue;

    if (isArgs(k)) {
      const next = tokens[k + 1];
      if ((isPunct(next, ".") || isPunct(next, "?.")) && isIdent(tokens[k + 2]) && MAP_READS.has((tokens[k + 2] as Token).text)) {
        const open = k + 3;
        const keyRange = isPunct(tokens[open], "(") ? splitList(file, open, false)[0] : undefined;
        const key = keyRange === undefined ? null : resolveString(ctx.r, file, keyRange[0], keyRange[1], env);
        issue(ctx, "RAW_ARG_READ", file, k,
          key !== null && key.ok
            ? `The factory reads the argument "${key.value}" straight from the map, so its type is not known; declare it in robot.json by hand, or read it with an arg helper.`
            : "The factory reads its argument map directly, so what it reads is not listed; read arguments with the arg helpers.");
        complete = false;
        continue;
      }
      if (isPunct(next, "[")) {
        issue(ctx, "RAW_ARG_READ", file, k, "The factory reads its argument map directly, so what it reads is not listed; read arguments with the arg helpers.");
        complete = false;
      }
      continue;
    }

    if (!isPunct(tokens[k + 1], "(") || NOT_A_CALL.has(token.text)) continue;
    const prev = tokens[k - 1];
    const open = k + 1;
    const args = splitList(file, open, false);

    if (HELPERS.has(token.text) && !declaresAt(tokens, k, file.kotlin)) {
      const receiver = isPunct(prev, ".") ? tokens[k - 2] : undefined;
      if (receiver === undefined || isIdent(receiver, "NamedCommands") || isIdent(receiver, "Args")) {
        const read = readHelper(ctx, file, k, token.text, args, env);
        if (read === "incomplete") complete = false;
        else if (read !== null) reads.push(read);
        continue;
      }
    }

    const passed = args.findIndex(([s, e]) => e - s === 1 && isArgs(s));
    if (passed === -1) continue;
    const isNew = isIdent(prev, "new") || (isPunct(prev, ".") && tokens.slice(Math.max(start, k - 8), k).some((t) => isIdent(t, "new")) && !tokens.slice(Math.max(start, k - 8), k).some((t) => isPunct(t, "(")));
    const qualifier = isPunct(prev, ".") && isIdent(tokens[k - 2]) ? (tokens[k - 2] as Token).text : null;
    const methods = isNew ? [] : methodsNamed(ctx.r.index, file, token.text, qualifier);
    if (methods.length === 0 || depth >= MAX_DEPTH) {
      issue(ctx, "ARGS_PASSED_ON", file, k, `The factory hands its arguments to ${isNew ? "new " : ""}${token.text}(...), which is not in the scanned sources, so any argument read there is not listed.`, "info");
      complete = false;
      continue;
    }
    const followed = mergeResults(methods.map((method) => followMethod(ctx, method, bindCall(ctx.r, file, args, env, method.params), depth + 1)));
    reads.push(...followed.reads);
    if (!followed.complete) complete = false;
  }
  return { reads, complete };
}

/** One `argInt`/`argDouble`/`argString`/`argEnum` call. */
function readHelper(ctx: Ctx, file: FileIndex, k: number, helper: string, args: ReadonlyArray<[number, number]>, env: Env): Read | null | "incomplete" {
  const [, commandRange, keyRange, ...rest] = args;
  if (commandRange === undefined || keyRange === undefined) return null;
  const key = resolveString(ctx.r, file, keyRange[0], keyRange[1], env);
  if (!key.ok) {
    issue(ctx, "KEY_UNRESOLVED", file, k, `${helper} reads an argument whose key cannot be read: ${key.why}. Declare it in robot.json by hand.`);
    return "incomplete";
  }
  const commandName = resolveString(ctx.r, file, commandRange[0], commandRange[1], env);
  if (commandName.ok && commandName.value !== ctx.command) {
    issue(ctx, "COMMAND_ARG_MISMATCH", file, k, `${helper} is told the command is "${commandName.value}", but the factory is registered as "${ctx.command}", so the robot's error message for "${key.value}" would name the wrong command.`);
  }
  const at = locate(file, k);
  if (helper === "argInt") return { key: key.value, type: "integer", required: true, at };
  if (helper === "argDouble" || helper === "argString") {
    const type: ScannedParamType = helper === "argDouble" ? "number" : "string";
    const fallback = rest[0];
    if (fallback === undefined) return { key: key.value, type, required: true, at };
    const read: Read = { key: key.value, type, required: false, at };
    const [s, e] = fallback;
    if (e - s === 1 && isIdent(file.tokens[s], "null")) return read;
    const value = helper === "argDouble" ? resolveNumber(ctx.r, file, s, e, env) : resolveString(ctx.r, file, s, e, env);
    if (value.ok) read.default = value.value;
    else issue(ctx, "DEFAULT_UNRESOLVED", file, k, `The fallback for "${key.value}" cannot be read (${value.why}), so robot.json gets no default for it.`, "info");
    return read;
  }
  // argEnum(args, command, key, Type.class, fallback)
  const typeRange = rest[0];
  const fallback = rest[1];
  const read: Read = { key: key.value, type: "enum", required: false, at };
  if (typeRange !== undefined) {
    const enumName = enumClassName(file, typeRange[0], typeRange[1]);
    if (enumName === null) {
      issue(ctx, "ENUM_UNRESOLVED", file, k, `The enum type for "${key.value}" is ${tokenText(file, typeRange[0], typeRange[1])}, which is not a class literal the scanner reads.`);
    } else {
      read.enumType = enumName;
      const values = enumConstants(ctx.r.index, enumName);
      if (typeof values === "string") issue(ctx, "ENUM_UNRESOLVED", file, k, `The values of "${key.value}" come from the enum ${enumName}, ${values}; list them in robot.json by hand.`);
      else read.values = values;
    }
  }
  if (fallback !== undefined) {
    const [s, e] = fallback;
    const parts = dottedName(file, s, e);
    if (parts !== null && !(parts.length === 1 && parts[0] === "null")) {
      const constant = parts[parts.length - 1] as string;
      if (read.values === undefined || read.values.includes(constant)) read.default = constant;
      else issue(ctx, "DEFAULT_UNRESOLVED", file, k, `The fallback for "${key.value}" is ${parts.join(".")}, which is not one of ${read.enumType ?? "the enum"}'s constants the scanner found.`, "info");
    } else if (parts === null) {
      issue(ctx, "DEFAULT_UNRESOLVED", file, k, `The fallback for "${key.value}" cannot be read (${tokenText(file, s, e)}), so robot.json gets no default for it.`, "info");
    }
  }
  return read;
}

/** `Intake.Side.class` or Kotlin's `Intake.Side::class.java` to `Intake.Side`. */
function enumClassName(file: FileIndex, start: number, end: number): string | null {
  const tokens = file.tokens;
  if (end - start >= 3 && isPunct(tokens[end - 2], ".") && isIdent(tokens[end - 1], "class")) {
    return dottedName(file, start, end - 2)?.join(".") ?? null;
  }
  const colons = findTopLevel(file, start, end, "::");
  if (colons !== -1 && isIdent(tokens[colons + 1], "class")) return dottedName(file, start, colons)?.join(".") ?? null;
  return null;
}

function enumConstants(index: Index, name: string): string[] | string {
  const simple = name.split(".").pop() as string;
  const all = index.enums.get(simple) ?? [];
  const exact = all.filter((decl) => decl.qualified === name || decl.qualified.endsWith(`.${name}`) || name.endsWith(`.${decl.qualified}`));
  const pick = exact.length > 0 ? exact : all;
  const distinct = [...new Set(pick.map((decl) => decl.constants.join(",")))];
  if (pick.length === 0) return "which is not declared in the scanned sources";
  if (distinct.length > 1) return "which is declared more than once with different constants";
  return [...(pick[0] as EnumDecl).constants];
}

// ---------------------------------------------------------------------------------------------
// Registrations.
// ---------------------------------------------------------------------------------------------

interface Registration {
  kind: "command" | "condition";
  file: FileIndex;
  /** The `register` token. */
  at: number;
  nameRange: [number, number];
  factoryRange: [number, number] | null;
}

function findRegistrations(file: FileIndex): Registration[] {
  const { tokens, close } = file;
  const out: Registration[] = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k] as Token;
    if (token.kind !== "ident" || (token.text !== "register" && token.text !== "registerCondition")) continue;
    if (!isPunct(tokens[k + 1], "(")) continue;
    const prev = tokens[k - 1];
    const qualified = isPunct(prev, ".") && isIdent(tokens[k - 2], "NamedCommands");
    const bare = !isPunct(prev, ".") && !isPunct(prev, "::") && !declaresAt(tokens, k, file.kotlin) && !isIdent(prev, "fun") && file.importsRegister;
    if (!qualified && !bare) continue;
    const open = k + 1;
    const args = splitList(file, open, false);
    const closer = close.get(open) ?? tokens.length;
    if (file.kotlin && isPunct(tokens[closer + 1], "{")) args.push([closer + 1, (close.get(closer + 1) ?? tokens.length) + 1]);
    const nameRange = args[0];
    if (nameRange === undefined) continue;
    out.push({
      kind: token.text === "register" ? "command" : "condition",
      file,
      at: k,
      nameRange,
      factoryRange: args[1] ?? null,
    });
  }
  return out;
}

/**
 * A registration whose name is a parameter of the method around it, `void reg(String name, ...)
 * { NamedCommands.register(name, ...); }`: each call of that method is a registration, with the
 * parameters bound to what the call passes.
 */
function wrapperCalls(index: Index, reg: Registration): Array<{ file: FileIndex; at: number; env: Map<string, Binding>; factory: { file: FileIndex; range: [number, number] } | null }> | null {
  const { file } = reg;
  const [s, e] = reg.nameRange;
  if (e - s !== 1 || !isIdent(file.tokens[s])) return null;
  const method = enclosingMethod(index, file, reg.at);
  if (method === null || method.bodyStart > reg.at) return null;
  const name = (file.tokens[s] as Token).text;
  if (!method.params.includes(name)) return null;
  const factoryParam = reg.factoryRange !== null && reg.factoryRange[1] - reg.factoryRange[0] === 1 ? method.params.indexOf((file.tokens[reg.factoryRange[0]] as Token).text) : -1;
  const r: Resolver = { index, active: new Set() };
  const calls: Array<{ file: FileIndex; at: number; env: Map<string, Binding>; factory: { file: FileIndex; range: [number, number] } | null }> = [];
  for (const caller of index.files) {
    const { tokens } = caller;
    for (let k = 0; k < tokens.length; k += 1) {
      if (!isIdent(tokens[k], method.name) || !isPunct(tokens[k + 1], "(")) continue;
      if (caller === method.file && k + 1 === method.paramsOpen) continue;
      if (declaresAt(tokens, k, caller.kotlin)) continue;
      const prev = tokens[k - 1];
      if (isPunct(prev, ".") && !isIdent(tokens[k - 2], "this") && !isIdent(tokens[k - 2], method.owner?.name ?? "")) continue;
      const args = splitList(caller, k + 1, false);
      if (args.length !== method.params.length) continue;
      const env = bindCall(r, caller, args, new Map(), method.params);
      const factoryArg = factoryParam === -1 ? undefined : args[factoryParam];
      calls.push({ file: caller, at: k, env, factory: factoryArg === undefined ? null : { file: caller, range: factoryArg } });
    }
  }
  return calls;
}

interface Found {
  name: string;
  kind: "command" | "condition";
  at: SourceLocation;
  result: FactoryResult | null;
}

/**
 * Scans a robot's sources for its `NamedCommands` registrations and what each factory reads.
 * Deterministic: the same files give the same result whatever order they are passed in.
 */
export function scanCommands(sources: readonly SourceFile[]): CommandScan {
  const index = buildIndex(sources.filter((source) => isScannableSource(source.path)));
  const issues: ScanIssue[] = [];
  const found: Found[] = [];
  let unresolvedRegistrations = 0;

  const analyze = (kind: "command" | "condition", name: string, factory: { file: FileIndex; range: [number, number] } | null, env: Env, where: SourceLocation): void => {
    if (kind === "condition") {
      found.push({ name, kind, at: where, result: null });
      return;
    }
    const ctx: Ctx = { r: { index, active: new Set() }, issues, command: name, visited: new Set() };
    const result = factory === null
      ? { reads: [], complete: false }
      : analyzeFactory(ctx, factory.file, factory.range[0], factory.range[1], env, 0);
    found.push({ name, kind, at: where, result });
  };

  for (const file of index.files) {
    for (const reg of findRegistrations(file)) {
      const r: Resolver = { index, active: new Set() };
      const name = resolveString(r, file, reg.nameRange[0], reg.nameRange[1], new Map());
      const where = locate(file, reg.at);
      if (name.ok) {
        analyze(reg.kind, name.value, reg.factoryRange === null ? null : { file, range: reg.factoryRange }, new Map(), where);
        continue;
      }
      const calls = wrapperCalls(index, reg);
      if (calls !== null && calls.length > 0) {
        for (const call of calls) {
          const bound = resolveString(r, file, reg.nameRange[0], reg.nameRange[1], call.env);
          const callAt = locate(call.file, call.at);
          if (!bound.ok) {
            unresolvedRegistrations += 1;
            issues.push({ code: "NAME_UNRESOLVED", severity: "warning", at: callAt, message: `This call registers a ${reg.kind} whose name cannot be read: ${bound.why}. robot.json must list it by hand.` });
            continue;
          }
          const factory = call.factory ?? (reg.factoryRange === null ? null : { file, range: reg.factoryRange });
          analyze(reg.kind, bound.value, factory, call.factory === null ? call.env : new Map(), callAt);
        }
        continue;
      }
      unresolvedRegistrations += 1;
      issues.push({
        code: "NAME_UNRESOLVED",
        severity: "warning",
        at: where,
        message: `This registers a ${reg.kind} whose name cannot be read: ${name.why}. robot.json must list it by hand, and a robot.json ${reg.kind} that is not found may be this one.`,
      });
    }
  }

  const byName = <T extends { name: string }>(a: T, b: T): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const byLocation = (a: SourceLocation, b: SourceLocation): number =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line;

  const commands = new Map<string, ScannedCommand>();
  const conditions = new Map<string, ScannedCondition>();
  for (const item of found) {
    if (item.kind === "condition") {
      const entry = conditions.get(item.name) ?? { name: item.name, at: [] };
      entry.at.push(item.at);
      conditions.set(item.name, entry);
      continue;
    }
    const entry = commands.get(item.name) ?? { name: item.name, at: [], params: [], complete: true };
    entry.at.push(item.at);
    const result = item.result as FactoryResult;
    if (!result.complete) entry.complete = false;
    mergeReads(entry, result.reads, issues);
    commands.set(item.name, entry);
  }
  for (const entry of commands.values()) entry.at.sort(byLocation);
  for (const entry of conditions.values()) entry.at.sort(byLocation);

  const severityRank = (s: "warning" | "info"): number => (s === "warning" ? 0 : 1);
  const unique = new Map<string, ScanIssue>();
  for (const item of issues) unique.set(`${item.at.path}:${String(item.at.line)}:${item.code}:${item.command ?? ""}:${item.message}`, item);

  return {
    commands: [...commands.values()].sort(byName),
    conditions: [...conditions.values()].sort(byName),
    issues: [...unique.values()].sort(
      (a, b) => byLocation(a.at, b.at) || severityRank(a.severity) - severityRank(b.severity) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
    ),
    filesScanned: index.files.length,
    unresolvedRegistrations,
  };
}

/** Folds reads of the same key together; two reads that disagree are an issue, and the first one stands. */
function mergeReads(entry: ScannedCommand, reads: readonly Read[], issues: ScanIssue[]): void {
  for (const read of reads) {
    const existing = entry.params.find((param) => param.key === read.key);
    if (existing === undefined) {
      const param: ScannedParam = { key: read.key, type: read.type, required: read.required, at: read.at };
      if (read.default !== undefined) param.default = read.default;
      if (read.values !== undefined) param.values = [...read.values];
      if (read.enumType !== undefined) param.enumType = read.enumType;
      entry.params.push(param);
      continue;
    }
    const sameType = existing.type === read.type || (isNumeric(existing.type) && isNumeric(read.type));
    if (!sameType) {
      issues.push({
        code: "PARAM_CONFLICT",
        severity: "warning",
        at: read.at,
        command: entry.name,
        message: `"${read.key}" is read as ${read.type} here but as ${existing.type} at ${existing.at.path}:${String(existing.at.line)}; robot.json keeps ${existing.type}.`,
      });
      continue;
    }
    // A key read as a whole number anywhere must be one.
    if (read.type === "integer") existing.type = "integer";
    // Required only when every read requires it; a fallback anywhere means some path does without.
    if (!read.required) existing.required = false;
    if (read.default !== undefined) {
      if (existing.default === undefined) existing.default = read.default;
      else if (existing.default !== read.default) {
        issues.push({
          code: "PARAM_CONFLICT",
          severity: "warning",
          at: read.at,
          command: entry.name,
          message: `"${read.key}" falls back to ${JSON.stringify(read.default)} here but to ${JSON.stringify(existing.default)} at ${existing.at.path}:${String(existing.at.line)}; robot.json keeps ${JSON.stringify(existing.default)}.`,
        });
      }
    }
  }
}

const isNumeric = (type: ScannedParamType): boolean => type === "integer" || type === "number";
