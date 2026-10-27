/**
 * What to say when a project file does not load: which file, what is wrong with it, and what to do
 * (the 0.1.2 UX sweep, W3-4 and W3-5). Every project source reads its files through these, so a
 * folder, the desktop app, GitHub mode and picked files all name the file the same way.
 *
 * The sentences about a file that is not readable JSON at all (`unreadableJsonMessage`), one from a
 * newer Zenith (`newerFormatMessage`) and one too large to read (`tooLargeFileMessage`) are shared
 * by every reader of a file the person picked: a share file in the Partners panel, an import, a
 * trace. Each reader passes its own next step, so the sentence names the file, says what is wrong
 * in plain words, and ends with what to do (UI_GUIDE section 9.19).
 *
 * The schema package's own messages ("Invalid robot file: ...") stay as they are, because the CLI
 * prints them next to the path it was given; the path and the next step are added here.
 *
 * Pure: no DOM, so the desktop app's main process can import it like `projectFiles.ts`.
 */
import { FORMAT_VERSIONS, MigrationError, SchemaError, formatIssue, type Kind } from "@horizon36596/zenith-schema";
import { ProjectError } from "./errors";

/** A project file that could not be read or did not load, with the sentence that names it. */
export class ProjectFileError extends ProjectError {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectFileError";
  }
}

const NEXT_STEP = "Fix it, or restore it from git.";

/**
 * The offset into `text` a `JSON.parse` error's message points at, or null when it does not say.
 * Running out of input, in Chromium's words or Safari's, is the whole message, and its place is the
 * end of the text.
 */
function jsonErrorOffset(text: string, message: string): number | null {
  const position = /at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(message);
  if (position !== null) return Number(position[1]);
  if (/^(?:Unexpected end of JSON input|JSON Parse error: Unexpected EOF)$/.test(message)) return text.length;
  return null;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).trim();

/** The 1-based line and column a `JSON.parse` error points at, or null when it does not say. */
export function jsonErrorPlace(text: string, error: unknown): { line: number; column: number } | null {
  const message = errorText(error);
  // Only the end of the message names the place: Chromium quotes a snippet of the file earlier in
  // it ("Unexpected token 'o', "…" is not valid JSON"), which may hold any text at all.
  // Chromium ends with "(line N column M)", Firefox with "at line N column M of the JSON data".
  const named = /(?:\(line (\d+) column (\d+)\)|at line (\d+) column (\d+) of the JSON data)$/.exec(message);
  if (named !== null) return { line: Number(named[1] ?? named[3]), column: Number(named[2] ?? named[4]) };
  // Older Chromium ends with only the position.
  const at = jsonErrorOffset(text, message);
  if (at === null || at > text.length) return null;
  const before = text.slice(0, at).split("\n");
  return { line: before.length, column: (before[before.length - 1] ?? "").length + 1 };
}

/**
 * True when `JSON.parse` failed because the text stops before the JSON does: a file cut off part
 * way through a download or a copy. The parser then points at the end of the text, or past its last
 * character that is not white space; Firefox says so in words.
 */
function isCutOff(text: string, error: unknown): boolean {
  const message = errorText(error);
  if (/unexpected end of data/i.test(message)) return true;
  const end = text.trimEnd().length;
  const at = jsonErrorOffset(text, message);
  if (at !== null) return at >= end;
  const place = jsonErrorPlace(text, error);
  if (place === null) return false;
  const lines = text.split("\n");
  const offset = lines.slice(0, place.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + place.column - 1;
  return offset >= end;
}

/**
 * The first bytes of a picture, as `File.text()` decodes them: PNG, JPEG (three bytes that are not
 * UTF-8), GIF, WebP and BMP.
 */
const PICTURE_START = /^(?:�PNG|\u0089PNG|���|GIF8[79]a|RIFF[\s\S]{4}WEBP|BM[\s\S]{4}\0\0)/;

/**
 * Why `text`, read from the file `name`, is not JSON at all, as one sentence that ends with `next`,
 * the reader's own next step. An empty file says it is empty, a picture says it is a picture, any
 * other binary file says it is not a text file, and a file that stops part way says it is cut off;
 * only a text file with a real mistake in it gets the line and column. The parser's own words never
 * appear: they differ by browser and quote the file.
 */
export function unreadableJsonMessage(name: string, text: string, error: unknown, next: string): string {
  if (text.trim() === "") return `${name} is empty. ${next}`;
  if (PICTURE_START.test(text)) return `${name} is a picture, not a JSON file. ${next}`;
  // A text file holds no NUL, and binary bytes decoded as UTF-8 leave replacement characters.
  if (/[\0�]/.test(text.slice(0, 1024))) return `${name} is not a text file, so it is not JSON. ${next}`;
  if (isCutOff(text, error)) return `${name} is cut off: the JSON in it stops part way. ${next}`;
  const place = jsonErrorPlace(text, error);
  const where = place === null ? "" : ` (line ${String(place.line)}, column ${String(place.column)})`;
  return `${name} is not valid JSON${where}. ${next}`;
}

/** `autos/robot.json is not valid JSON (line 1, column 3). Fix it, or restore it from git.` */
export function notJsonMessage(path: string, text: string, error: unknown): string {
  return unreadableJsonMessage(path, text, error, NEXT_STEP);
}

/** A size in megabytes with one decimal, as the too-large sentences say it: "2.0 MB". */
export const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

/**
 * `big.json is 5.0 MB, larger than the 2.0 MB a share file may be, so it was not read.` and the
 * reader's next step. `what` names the kind of file with its article: "a share file".
 */
export function tooLargeFileMessage(name: string, bytes: number, limitBytes: number, what: string, next: string): string {
  return `${name} is ${megabytes(bytes)}, larger than the ${megabytes(limitBytes)} ${what} may be, so it was not read. ${next}`;
}

/** The format version a `kind` file says it is in, when that is newer than this Zenith reads; else null. */
export function newerFormatVersion(kind: Kind, json: unknown): number | null {
  const version = typeof json === "object" && json !== null ? (json as Record<string, unknown>)["formatVersion"] : undefined;
  return typeof version === "number" && Number.isInteger(version) && version > FORMAT_VERSIONS[kind] ? version : null;
}

/**
 * `name was made by a newer Zenith (auto format 9; this Zenith reads format 4). Update Zenith to
 * open it.` `format` is the kind as the person knows it ("share file" for a projection), and `verb`
 * what the reader does with the file.
 */
export function newerFormatMessage(name: string, kind: Kind, version: number, format: string = kind, verb = "open"): string {
  return `${name} was made by a newer Zenith (${format} format ${String(version)}; this Zenith reads format ${String(FORMAT_VERSIONS[kind])}). Update Zenith to ${verb} it.`;
}

/** The JSON in a project file's text, or a `ProjectFileError` naming the file and the place. */
export function parseProjectJson(path: string, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ProjectFileError(path, notJsonMessage(path, text, error));
  }
}

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** One schema problem as "at waypoints.scoreSouth.xIn (expected number, received string)". */
const issuePlace = (issue: SchemaError["issues"][number]): string => {
  const [where, ...rest] = formatIssue(issue).split(": ");
  const what = lowerFirst(rest.join(": "));
  return where === "(root)" ? `at the top of the file (${what})` : `at ${where ?? ""} (${what})`;
};

/**
 * Why `json`, read from `path` as a `kind` file, did not load, as one or two sentences. A file
 * written by a newer Zenith says to update Zenith; anything else says to fix the file.
 */
export function loadFailureMessage(kind: Kind, path: string, json: unknown, error: unknown): string {
  const version = newerFormatVersion(kind, json);
  if (version !== null) return newerFormatMessage(path, kind, version);
  if (error instanceof SchemaError && error.issues.length > 0) {
    const [first] = error.issues;
    const count = error.issues.length;
    if (count === 1) return `${path} has a value Zenith cannot read, ${issuePlace(first as SchemaError["issues"][number])}. ${NEXT_STEP}`;
    return `${path} has ${String(count)} values Zenith cannot read; the first is ${issuePlace(first as SchemaError["issues"][number])}. Fix them, or restore the file from git.`;
  }
  if (error instanceof MigrationError) return `${path} cannot be read: ${error.message} ${NEXT_STEP}`;
  return `${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`;
}

/** `load(json)`, or a `ProjectFileError` naming `path` when the file does not load as a `kind`. */
export function loadProjectJson<T>(kind: Kind, path: string, json: unknown, load: (json: unknown) => T): T {
  try {
    return load(json);
  } catch (error) {
    throw new ProjectFileError(path, loadFailureMessage(kind, path, json, error));
  }
}

/** Parses and loads one project file, naming it in whichever error comes first. */
export function loadProjectFile<T>(kind: Kind, path: string, text: string, load: (json: unknown) => T): T {
  return loadProjectJson(kind, path, parseProjectJson(path, text), load);
}

/** Which key of `zenith.json` names each file it points at. */
export type LinkKey = "robot" | "field" | "waypoints";

/** A file `zenith.json` names that is not in the folder: which key names it, and what to do. */
export function missingFileMessage(path: string, key: LinkKey): string {
  return `${path} is not in this folder, but zenith.json's "${key}" names it. Fix that path in zenith.json, or add the file.`;
}
