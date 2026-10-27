import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * True when `entry`, the script Node was started with, is the module at `moduleUrl`.
 *
 * Both sides are resolved through symlinks first. npm installs a package's bin on Linux and macOS as
 * a symlink in `node_modules/.bin`, and Node reports that link's path in `process.argv[1]` while
 * `import.meta.url` is the real file, so a plain comparison is false there and the program would exit
 * without doing anything. On Windows npm writes a `.cmd` shim that passes the real path instead.
 * Shared by both bins: the CLI (`index.ts`) and the MCP server (`@horizon36596/zenith-mcp`).
 */
export function isEntryPoint(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === pathToFileURL(realpathSync(fileURLToPath(moduleUrl))).href;
  } catch {
    return false;
  }
}
