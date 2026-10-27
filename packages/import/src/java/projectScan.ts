/**
 * What a robot repository's own Java says about how to set Zenith up in it (issue #159): which
 * classes implement `ZenithRobot`, and which command library its imports name. `zenith init` and
 * the editor's Set up both read these, so they agree; neither ever picks a library or a robot class
 * the code does not name.
 *
 * Pure: source text in, names out.
 */
import { RUNTIME_PACKAGE, type CommandLibrary } from "@horizon36596/zenith-core";
import type { SourceFile, SourceLocation } from "./scanCommands.js";

const PACKAGE_LINE = /^[ \t]*package[ \t]+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)[ \t]*;/m;
/**
 * A top-level `public class` (or `public final class`) that implements `ZenithRobot`. An abstract
 * class, an interface and a `static` nested class do not match, and neither does a line inside a
 * comment, because the declaration has to start its line.
 */
const ZENITH_ROBOT_CLASS = /^[ \t]*public[ \t]+(?:final[ \t]+)?class[ \t]+([A-Za-z_$][\w$]*)\b[^{;]*\bimplements\b[^{;]*\bZenithRobot\b/gm;

/** A file's name without its folders or its `.java`. */
const className = (path: string): string => (path.split("/").pop() ?? path).replace(/\.java$/, "");

/**
 * The fully qualified names of the Java classes in `sources` that a generated OpMode could construct
 * as `deploy.robotClass`: a public, non-abstract, top-level class in a named package, implementing
 * `ZenithRobot`, in the file named after it. Sorted, with no repeats.
 */
export function zenithRobotClasses(sources: readonly SourceFile[]): string[] {
  const found = new Set<string>();
  for (const source of sources) {
    if (!source.path.endsWith(".java")) continue;
    const packageName = PACKAGE_LINE.exec(source.text)?.[1];
    if (packageName === undefined) continue;
    const fileClass = className(source.path);
    for (const match of source.text.matchAll(ZENITH_ROBOT_CLASS)) {
      if (match[1] === fileClass) found.add(`${packageName}.${fileClass}`);
    }
  }
  return [...found].sort();
}

/**
 * The packages whose import names a command library: Zenith's own runtime for it, and the library
 * itself (SolversLib's `com.seattlesolvers.solverslib`, and Ivy's `com.pedropathing.ivy`, as the
 * runtimes in `robot/` import them).
 */
const LIBRARY_PACKAGES: ReadonlyArray<{ library: CommandLibrary; prefix: string }> = [
  { library: "solverslib", prefix: RUNTIME_PACKAGE.solverslib },
  { library: "solverslib", prefix: "com.seattlesolvers.solverslib" },
  { library: "ivy", prefix: RUNTIME_PACKAGE.ivy },
  { library: "ivy", prefix: "com.pedropathing.ivy" },
];

/** A Java or Kotlin import at the start of its line, `static` or not, with or without `;`. */
const IMPORT_LINE = /^[ \t]*import[ \t]+(?:static[ \t]+)?([A-Za-z_$][\w$]*(?:\.(?:[A-Za-z_$][\w$]*|\*))*)/gm;

export interface LibraryImport {
  library: CommandLibrary;
  /** The import as written, dotted: `org.horizon36596.zenith.ivy.ZenithRobot`. */
  name: string;
  at: SourceLocation;
}

/** Every import in `sources` that names a command library, in the order of the files and their lines. */
export function commandLibraryImports(sources: readonly SourceFile[]): LibraryImport[] {
  const out: LibraryImport[] = [];
  for (const source of sources) {
    for (const match of source.text.matchAll(IMPORT_LINE)) {
      const name = match[1] ?? "";
      const known = LIBRARY_PACKAGES.find(({ prefix }) => name === prefix || name.startsWith(`${prefix}.`));
      if (known === undefined) continue;
      const line = source.text.slice(0, match.index).split("\n").length;
      out.push({ library: known.library, name, at: { path: source.path, line } });
    }
  }
  return out;
}

/**
 * The command library the code's imports name, with the imports that name one. `library` is null
 * when no import names either library, or when they name both: Zenith never chooses for a team
 * (site/docs/command-libraries.md).
 */
export function importedCommandLibrary(sources: readonly SourceFile[]): { library: CommandLibrary | null; found: LibraryImport[] } {
  const found = commandLibraryImports(sources);
  const libraries = new Set(found.map((entry) => entry.library));
  const only = libraries.size === 1 ? [...libraries][0] : undefined;
  return { library: only ?? null, found };
}
