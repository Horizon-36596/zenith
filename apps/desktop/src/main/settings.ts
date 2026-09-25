/**
 * The desktop app's own small settings file, `settings.json` in Electron's per-user data folder:
 * the window's last bounds, the recent projects, and the encrypted GitHub token. UI preferences stay
 * in the web build's `localStorage` as they do in a browser.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { RecentProject } from "../../../web/src/project/desktopBridge.js";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface Settings {
  bounds: WindowBounds | null;
  recent: RecentProject[];
  /** Base64 of the `safeStorage` ciphertext; never the token itself. */
  githubToken: string | null;
}

const EMPTY: Settings = { bounds: null, recent: [], githubToken: null };
export const RECENT_LIMIT = 8;

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function sanitize(raw: unknown): Settings {
  if (raw === null || typeof raw !== "object") return { ...EMPTY };
  const value = raw as Record<string, unknown>;
  const b = value["bounds"] as Record<string, unknown> | undefined;
  const bounds =
    b !== undefined && b !== null && isNumber(b["x"]) && isNumber(b["y"]) && isNumber(b["width"]) && isNumber(b["height"])
      ? { x: b["x"], y: b["y"], width: b["width"], height: b["height"], maximized: b["maximized"] === true }
      : null;
  const recent = Array.isArray(value["recent"])
    ? (value["recent"] as unknown[])
        .filter(
          (entry): entry is RecentProject =>
            entry !== null &&
            typeof entry === "object" &&
            typeof (entry as RecentProject).root === "string" &&
            typeof (entry as RecentProject).name === "string" &&
            isNumber((entry as RecentProject).openedAt),
        )
        .slice(0, RECENT_LIMIT)
    : [];
  const githubToken = typeof value["githubToken"] === "string" ? value["githubToken"] : null;
  return { bounds, recent, githubToken };
}

/** Adds `root` to the front of the list, dropping an older entry for the same folder. */
export function pushRecent(recent: readonly RecentProject[], root: string, now: number): RecentProject[] {
  const key = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
  return [{ root, name: basename(root), openedAt: now }, ...recent.filter((entry) => key(entry.root) !== key(root))].slice(
    0,
    RECENT_LIMIT,
  );
}

export class SettingsStore {
  private value: Settings;

  constructor(private readonly file: string) {
    this.value = SettingsStore.read(file);
  }

  private static read(file: string): Settings {
    if (!existsSync(file)) return { ...EMPTY };
    try {
      return sanitize(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return { ...EMPTY };
    }
  }

  get(): Settings {
    return this.value;
  }

  update(patch: Partial<Settings>): void {
    this.value = { ...this.value, ...patch };
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.value, null, 2)}\n`, "utf8");
    renameSync(temp, this.file);
  }
}
