/**
 * Every key the editor shows is read through `keyLabel(id)` or `useKeyLabel(id)`, so a rebound key
 * reaches every tooltip, hint and tour line at once. The default table, `SHORTCUTS`, is read only by
 * `shortcuts.ts` and `keymap.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { keyLabel } from "./keymap";
import { SHORTCUTS, type ShortcutId } from "./shortcuts";

/** The files that may read the table directly. */
const ALLOWED = new Set(["app/shortcuts.ts", "app/keymap.ts"]);

/**
 * `source` with its comments taken out. Quotes are skipped over whole, so a `//` or `/*` inside a
 * string does not hide the code after it. A quoted string ends at its line, so a stray quote (in a
 * regular expression, say) cannot swallow the rest of the file.
 */
function withoutComments(source: string): string {
  let out = "";
  let at = 0;
  while (at < source.length) {
    const char = source[at] ?? "";
    const pair = source.slice(at, at + 2);
    if (pair === "//") {
      const end = source.indexOf("\n", at);
      at = end < 0 ? source.length : end;
    } else if (pair === "/*") {
      const end = source.indexOf("*/", at + 2);
      at = end < 0 ? source.length : end + 2;
    } else if (char === '"' || char === "'" || char === "`") {
      let end = at + 1;
      while (end < source.length && source[end] !== char && (char === "`" || source[end] !== "\n")) {
        end += source[end] === "\\" ? 2 : 1;
      }
      out += source.slice(at, end + 1);
      at = end + 1;
    } else {
      out += char;
      at += 1;
    }
  }
  return out;
}

/**
 * Whether `source` reads `SHORTCUTS` as a value, in any form: `.x`, `[id]`, `?.x`, a spread, a
 * destructuring, `Object.entries(SHORTCUTS)`, an alias, or an import under another name. A mention
 * in a comment, a plain `import { SHORTCUTS }` and a type's `typeof SHORTCUTS` are not reads.
 */
function readsShortcuts(source: string): boolean {
  const code = withoutComments(source)
    .replace(/\btypeof\s+SHORTCUTS\b/g, "")
    .replace(/\bimport\s+(type\s+)?\{[^}]*\}\s*from\s*["'][^"']*["']/g, (statement) =>
      /\bSHORTCUTS\s+as\b/.test(statement) ? "SHORTCUTS" : "",
    );
  return /\bSHORTCUTS\b/.test(code);
}

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourcesUnder(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("who reads the default shortcut table", () => {
  it("is only shortcuts.ts and keymap.ts", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const names = sourcesUnder(root).map((path) => relative(root, path).replace(/\\/g, "/"));
    expect(names.length).toBeGreaterThan(100);
    const readers = names
      .filter((name) => !ALLOWED.has(name))
      .filter((name) => readsShortcuts(readFileSync(join(root, name), "utf8")));
    expect(readers).toEqual([]);
  });

  it("notices a read, by dot or by bracket, and leaves comments and other names alone", () => {
    expect(readsShortcuts("const k = SHORTCUTS.undo;")).toBe(true);
    expect(readsShortcuts("const k = SHORTCUTS[id];")).toBe(true);
    expect(readsShortcuts("`press ${SHORTCUTS.undo} to undo`")).toBe(true);
    expect(readsShortcuts("// the key, from SHORTCUTS.undo\nconst a = 1;")).toBe(false);
    expect(readsShortcuts("/** From `SHORTCUTS`, e.g. SHORTCUTS.undo. */ const a = 1;")).toBe(false);
    expect(readsShortcuts('const k = keyLabel("undo");')).toBe(false);
    expect(readsShortcuts("const k = MY_SHORTCUTS.undo;")).toBe(false);
  });

  it("notices the other ways to read it, and a read after a // inside a string", () => {
    expect(readsShortcuts("const k = SHORTCUTS?.undo;")).toBe(true);
    expect(readsShortcuts("for (const [id, key] of Object.entries(SHORTCUTS)) show(id, key);")).toBe(true);
    expect(readsShortcuts("const ids = Object.keys(SHORTCUTS);")).toBe(true);
    expect(readsShortcuts("const { undo } = SHORTCUTS;")).toBe(true);
    expect(readsShortcuts("const all = { ...SHORTCUTS };")).toBe(true);
    expect(readsShortcuts("const table = SHORTCUTS;\ntable.undo;")).toBe(true);
    expect(readsShortcuts('import { SHORTCUTS as KEYS } from "./shortcuts";\nKEYS.undo;')).toBe(true);
    expect(readsShortcuts('const url = "https://example.org"; const k = SHORTCUTS.undo;')).toBe(true);
    expect(readsShortcuts('const s = "/* not a comment"; const k = SHORTCUTS.undo; // */')).toBe(true);
    expect(readsShortcuts('import { SHORTCUTS } from "./shortcuts";\ntype Id = keyof typeof SHORTCUTS;')).toBe(false);
    expect(readsShortcuts("const k = 1; /* SHORTCUTS.undo */ // SHORTCUTS[id]")).toBe(false);
  });
});

describe("keyLabel", () => {
  it("returns the default key for every shortcut id", () => {
    for (const id of Object.keys(SHORTCUTS) as ShortcutId[]) {
      expect(keyLabel(id)).toBe(SHORTCUTS[id]);
    }
  });
});
