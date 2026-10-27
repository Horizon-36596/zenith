/**
 * `zenith open [dir] [--auto <name>]` and the MCP tool `zenith.app.open` start this app with two
 * switches, `--zenith-open=<folder>` and `--zenith-auto=<name>` (issue #213). This module reads them,
 * on a first launch from the app's own command line and on a later one from the data the second
 * launch hands the running app through the single-instance lock.
 *
 * Where a request can come from is the safety argument: only a process on this computer that starts
 * the app's executable. The app registers no URL scheme with the operating system and the page has
 * no call that reaches this module, so no link, web page or document can open a folder through it.
 * A switch whose value looks like a URL is refused anyway, and the folder must hold a `zenith.json`
 * before anything is granted.
 */
import { isAbsolute, resolve } from "node:path";
import type { DesktopOpenRequest } from "../../../web/src/project/desktopBridge.js";
import { AUTO_SWITCH, OPEN_SWITCH } from "./cli.js";
import { BridgeError, assertAutoFileName } from "./confine.js";
import { describeProject, listAutos } from "./project.js";

// The CLI that starts the app with these switches and the app that reads them share one spelling.
export { AUTO_SWITCH, OPEN_SWITCH };

/** What a launch asked for: an absolute folder, and an auto file name in it or none. */
export interface OpenArgs {
  dir: string;
  auto: string | null;
}

/** The key the second launch's data is sent under, so nothing else in that object is read. */
const DATA_KEY = "zenithOpen";

const looksLikeUrl = (value: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]+:\/\//.test(value) || value.includes("://");

/** `close-cycle`, `close-cycle.auto.json` or nothing, as the auto file name. */
function autoFileName(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  return assertAutoFileName(value.endsWith(".auto.json") ? value : `${value}.auto.json`);
}

/**
 * The open request in a command line, or null when it has none or it is malformed. Only the two
 * switches are read; every other argument (Chromium's own, a script path in a development run) is
 * left alone. A relative folder is resolved against `cwd`, the launching process's own directory.
 */
export function parseOpenArgs(argv: readonly string[], cwd: string): OpenArgs | null {
  const opens = argv.filter((arg) => arg.startsWith(OPEN_SWITCH));
  const autos = argv.filter((arg) => arg.startsWith(AUTO_SWITCH));
  if (opens.length !== 1 || autos.length > 1) return null;
  const dir = (opens[0] as string).slice(OPEN_SWITCH.length);
  if (dir === "" || dir.includes("\0") || looksLikeUrl(dir)) return null;
  try {
    return {
      dir: isAbsolute(dir) ? resolve(dir) : resolve(cwd, dir),
      auto: autoFileName(autos[0]?.slice(AUTO_SWITCH.length)),
    };
  } catch {
    return null;
  }
}

/** What the second launch passes to `app.requestSingleInstanceLock`. */
export const openData = (args: OpenArgs): Record<string, OpenArgs> => ({ [DATA_KEY]: args });

/** The open request in the data a second launch sent, checked again here: it crossed a process. */
export function openArgsFromData(data: unknown): OpenArgs | null {
  if (data === null || typeof data !== "object") return null;
  const value = (data as Record<string, unknown>)[DATA_KEY];
  if (value === null || typeof value !== "object") return null;
  const { dir, auto } = value as { dir?: unknown; auto?: unknown };
  if (typeof dir !== "string" || !isAbsolute(dir) || dir.includes("\0") || looksLikeUrl(dir)) return null;
  if (auto !== null && typeof auto !== "string") return null;
  try {
    return { dir: resolve(dir), auto: autoFileName(auto ?? undefined) };
  } catch {
    return null;
  }
}

/**
 * Checks a request against the disk: the folder must hold a `zenith.json` that loads, and the auto,
 * when one is named, must be in its autos folder. Returns what the page opens, or the sentence it
 * shows instead.
 */
export function resolveOpenRequest(args: OpenArgs): DesktopOpenRequest {
  try {
    const project = describeProject(args.dir);
    if (args.auto !== null && !listAutos(project.root).includes(args.auto)) {
      throw new BridgeError(`${project.name} has no auto called ${args.auto}.`);
    }
    return { project, auto: args.auto };
  } catch (error) {
    const reason = error instanceof Error && error.message !== "" ? error.message : "it could not be read";
    return { error: `Zenith could not open ${args.dir}: ${reason}` };
  }
}
