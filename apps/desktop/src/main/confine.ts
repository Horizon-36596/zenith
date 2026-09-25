/**
 * The rules every path from the renderer passes before the main process touches the disk.
 *
 * The renderer is treated as untrusted: it names a project root and a path inside it, and the main
 * process accepts the root only if the user picked it in a native dialog (now or in an earlier
 * session, through the recent list), and the path only if it stays inside that root. The lexical
 * check is the CLI's own `confinePath` (packages/cli/src/project.ts), so the desktop app and the
 * CLI refuse exactly the same `zenith.json` values; on top of it the deepest existing ancestor is
 * resolved through symlinks and junctions, so a link inside the repository cannot lead a write out
 * of it either.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { confinePath } from "./cli.js";

/** An error whose message is written for the person using the app and is safe to show as is. */
export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

/** A bare auto file name such as `first-auto.auto.json`: the same alphabet `auto.name` is held to. */
export const AUTO_FILE_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.auto\.json$/;

export function assertAutoFileName(fileName: unknown): string {
  if (typeof fileName !== "string" || !AUTO_FILE_PATTERN.test(fileName)) {
    throw new BridgeError(`"${String(fileName)}" is not an auto file name; it must look like name.auto.json.`);
  }
  return fileName;
}

const outside = (rel: string): boolean =>
  rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel);

/** True when `path`, after following every link that exists on disk, is still inside `root`. */
function realInside(root: string, path: string): boolean {
  let probe = path;
  while (!existsSync(probe)) {
    const up = dirname(probe);
    if (up === probe) return false;
    probe = up;
  }
  const realRoot = realpathSync.native(root);
  const rel = relative(realRoot, realpathSync.native(probe));
  return !outside(rel);
}

/**
 * Turns a renderer-supplied project path (`autos/first-auto.auto.json`) into an absolute path inside
 * `root`, or throws. Absolute paths, drive letters, UNC paths, NUL bytes and `..` segments are
 * refused outright rather than normalised, because a legitimate caller never sends one.
 */
export function confineRelative(root: string, path: unknown): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024 || path.includes("\0")) {
    throw new BridgeError("That is not a path inside the project.");
  }
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.startsWith("\\\\") || path.startsWith("//")) {
    throw new BridgeError(`"${path}" is an absolute path; only paths inside the project are allowed.`);
  }
  if (path.split(/[\\/]/).includes("..")) {
    throw new BridgeError(`"${path}" climbs out of the project with "..", so it was refused.`);
  }
  let full: string;
  try {
    full = confinePath(root, path);
  } catch (error) {
    throw new BridgeError(error instanceof Error ? error.message : String(error));
  }
  if (!realInside(root, full)) {
    throw new BridgeError(`"${path}" leads outside the project through a link, so it was refused.`);
  }
  return full;
}

/** A root the user granted, compared the way the operating system compares paths. */
const rootKey = (root: string): string => {
  const full = resolve(root);
  return process.platform === "win32" ? full.toLowerCase() : full;
};

/**
 * The set of project roots the user has granted by picking them. The renderer may only ever name
 * one of these; anything else is refused before any filesystem call.
 */
export class RootRegistry {
  private readonly roots = new Map<string, string>();

  grant(root: string): string {
    const full = resolve(root);
    this.roots.set(rootKey(full), full);
    return full;
  }

  revoke(root: string): void {
    this.roots.delete(rootKey(root));
  }

  /** The granted root's own spelling, or throws. */
  assert(root: unknown): string {
    if (typeof root !== "string" || root.length === 0) throw new BridgeError("No project is open.");
    const granted = this.roots.get(rootKey(root));
    if (granted === undefined) {
      throw new BridgeError("That folder was not opened through Zenith's folder picker, so it was refused.");
    }
    return granted;
  }

  has(root: string): boolean {
    return this.roots.has(rootKey(root));
  }
}
