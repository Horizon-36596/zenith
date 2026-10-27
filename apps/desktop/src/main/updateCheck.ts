/**
 * Whether a newer Zenith is out. Once per launch the main process asks GitHub for the latest release
 * on the public repository's releases page, which is the only official source of the app
 * (site/docs/getting-started.md). It sends nothing about the person or their work: one anonymous
 * GET to api.github.com, with no token. When a newer version is there, the Help menu offers it and
 * the page says so once on its status line. Nothing is downloaded or installed by Zenith itself.
 *
 * Kept free of Electron so the comparison can be tested without a network.
 */
import type { DesktopUpdate } from "../../../web/src/project/desktopBridge.js";

export const LATEST_RELEASE_URL = "https://api.github.com/repos/Horizon-36596/zenith/releases/latest";
/** The releases page itself, the only place a link may point. */
export const RELEASES_PAGE = "https://github.com/Horizon-36596/zenith/releases";

/** How long the check may take before it is given up (SET BY HAND: it must never hold anything up). */
export const UPDATE_CHECK_TIMEOUT_MS = 10_000;

/** `0.1.2` from `v0.1.2` or `0.1.2`; null for anything that is not three numbers. */
export function parseVersion(text: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `latest` is a later version than `current`. A pre-release suffix on either is never newer. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
  }
  return false;
}

/**
 * The release GitHub calls latest, when it is newer than `current`; null otherwise, and null when
 * GitHub could not be reached or answered with something else. Never throws.
 */
export async function checkForUpdate(
  current: string,
  fetchImpl: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
    ok: boolean;
    json(): Promise<unknown>;
  }>,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
): Promise<DesktopUpdate | null> {
  try {
    const response = await fetchImpl(LATEST_RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
    if (typeof body.tag_name !== "string" || body.draft === true || body.prerelease === true) return null;
    if (!isNewer(body.tag_name, current)) return null;
    const version = body.tag_name.replace(/^v/, "");
    // Only a page on the releases page is ever opened, whatever the answer named.
    const url = typeof body.html_url === "string" && body.html_url.startsWith(`${RELEASES_PAGE}/`) ? body.html_url : RELEASES_PAGE;
    return { version, url };
  } catch {
    return null;
  }
}
