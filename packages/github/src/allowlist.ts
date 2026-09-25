import type { Link } from "@horizon36596/zenith-schema";
import { PathNotAllowedError } from "./errors.js";

/** Strips a leading `./`, converts `\` to `/`, and drops a leading `/`. */
function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function withinDir(path: string, dir: string): boolean {
  const normalizedDir = normalize(dir).replace(/\/+$/, "");
  return path === normalizedDir || path.startsWith(`${normalizedDir}/`);
}

/**
 * The write allowlist of site/docs/github.md: only `autosDir`,
 * `deploy.dir` and `codegen.dir` from `zenith.json` (and, redundantly but explicitly per the
 * spec, `autosDir/.renders/`, which is already inside `autosDir`).
 */
export function isPathAllowed(link: Link, path: string): boolean {
  const normalized = normalize(path);
  if (normalized.length === 0) return false;
  if (normalized.split("/").includes("..")) return false;
  if (withinDir(normalized, link.autosDir)) return true;
  if (link.deploy && withinDir(normalized, link.deploy.dir)) return true;
  if (link.codegen && withinDir(normalized, link.codegen.dir)) return true;
  return false;
}

/** Throws `PathNotAllowedError` unless `isPathAllowed` is true. */
export function assertPathAllowed(link: Link, path: string): void {
  if (!isPathAllowed(link, path)) throw new PathNotAllowedError(path);
}

/** `autosDir/.renders/<name>.svg`, the fixed location `propose` commits the render SVG to. */
export function renderPath(link: Link, autoName: string): string {
  return `${normalize(link.autosDir).replace(/\/+$/, "")}/.renders/${autoName}.svg`;
}

/** `autosDir/<name>.auto.json`, the fixed location an auto file lives at. */
export function autoPath(link: Link, autoName: string): string {
  return `${normalize(link.autosDir).replace(/\/+$/, "")}/${autoName}.auto.json`;
}
