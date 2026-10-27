/**
 * The web apps that may open Zenith in host mode (site/docs/host-protocol.md), and the origins
 * each one is allowed to talk from. A host opens `<zenith>/?host=<id>`; the id picks a row here,
 * and a message is only ever accepted from an origin on that row's list.
 *
 * Pure on purpose: no `window`, no DOM, so the allowlist is unit-tested in node
 * (`hostOrigins.test.ts`). `hostSession.ts` is the only caller that touches the browser.
 */

export interface HostInfo {
  /** The short name in `?host=`, such as `dsim`. */
  id: string;
  /** What the editor calls the host in its own copy: "Save to DSIM". */
  displayName: string;
  /** Exact origins, scheme and host and port, with no trailing slash. */
  origins: readonly string[];
  /** Whether `http://localhost:<any port>` and `http://127.0.0.1:<any port>` count, for development. */
  allowLocalDev: boolean;
  /**
   * The lowest `hostBuild` this version of Zenith expects in the host's `open`. An `open` that
   * names an older build comes from a host that cannot take what this Zenith sends back (an auto in
   * a format it cannot read), or from a page loaded before the host's update was deployed. Either
   * way Zenith says the host needs an update and turns Save to and Simulate in off, leaving Save a
   * copy. Unset means Zenith expects no particular build and says nothing, which is also what
   * happens when the host sends no build.
   */
  minBuild?: number;
}

/**
 * The known hosts. A new host is a new row, reviewed like any other code change: the allowlist is
 * what stops an arbitrary page from opening Zenith and reading back the autos a person edits.
 */
export const HOSTS: Readonly<Record<string, HostInfo>> = {
  dsim: {
    id: "dsim",
    displayName: "DSIM",
    origins: [
      "https://www.playdsim.com",
      "https://playdsim.com",
      "https://alpha.playdsim.com",
      "https://beta.playdsim.com",
    ],
    allowLocalDev: true,
    // DSIM build 2 is the first that reads auto format 4, the format this Zenith writes. DSIM
    // build 1 vendors Zenith 0.1.1, whose schema refuses format 4, so a save or a run from here
    // would fail inside DSIM. The DSIM release that vendors this Zenith sends `HOST_BUILD = 2`
    // (DSIM's `src/ui/zenithOpen.ts`). Raise this whenever a Zenith change needs a newer DSIM, or
    // a DSIM deploy changes what it sends in a way this version of Zenith depends on.
    minBuild: 2,
  },
};

/** The host a `?host=` value names, or null when Zenith does not know it. */
export function hostById(id: string | null | undefined): HostInfo | null {
  if (id === null || id === undefined) return null;
  return Object.prototype.hasOwnProperty.call(HOSTS, id) ? (HOSTS[id] ?? null) : null;
}

/** The `?host=` value in a location's query string, or null when there is none. */
export function hostIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("host");
  return value === null || value.trim() === "" ? null : value.trim();
}

/**
 * An origin in the one form the allowlist compares: lower case, with no trailing slash, and only
 * the scheme, host and port. Anything that is not an http or https origin is null, and so is the
 * literal string `"null"` that a sandboxed frame or a `file:` page reports.
 */
export function normalizeOrigin(origin: string): string | null {
  const trimmed = origin.trim().replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "null") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // An origin has no path, query, fragment or credentials; a string that carries any is not one.
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  return url.origin.toLowerCase();
}

/**
 * The extra origins `VITE_ZENITH_HOST_ORIGINS` lists, comma separated, for preview deployments of
 * a host. Entries that are not origins are dropped rather than trusted.
 */
export function parseOriginList(text: string | undefined): string[] {
  if (text === undefined) return [];
  return text
    .split(",")
    .map((entry) => normalizeOrigin(entry))
    .filter((entry): entry is string => entry !== null);
}

/** True for `http://localhost[:port]` and `http://127.0.0.1[:port]`, the dev servers of a host. */
export function isLocalDevOrigin(origin: string): boolean {
  const normal = normalizeOrigin(origin);
  if (normal === null) return false;
  const url = new URL(normal);
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/**
 * Whether a message from `origin` may speak for `host`: it is on the host's own list, on the extra
 * list from the build's environment, or a local dev server when the host allows those.
 */
export function isAllowedOrigin(host: HostInfo, origin: string, extra: readonly string[] = []): boolean {
  const normal = normalizeOrigin(origin);
  if (normal === null) return false;
  if (host.origins.some((allowed) => normalizeOrigin(allowed) === normal)) return true;
  if (extra.some((allowed) => normalizeOrigin(allowed) === normal)) return true;
  return host.allowLocalDev && isLocalDevOrigin(normal);
}

/**
 * The sentence for a host whose `open` names a build older than this version of Zenith expects,
 * or null when it does not: the host sent no build, or this host has no minimum, or the build is
 * new enough. It is the badge's tooltip, the status line and the reason Save to and Simulate in
 * are off, so it says what is off and what still works before it gives the build numbers.
 */
export function outdatedHostLine(host: HostInfo, hostBuild: number | undefined): string | null {
  if (hostBuild === undefined || host.minBuild === undefined || hostBuild >= host.minBuild) return null;
  const name = host.displayName;
  return (
    `${name} needs an update before it can read autos from this Zenith, so Save to ${name} and Simulate in ${name} are off. ` +
    `Save a copy keeps your work. ` +
    `This ${name} page is build ${String(hostBuild)}, and this Zenith needs build ${String(host.minBuild)} or later; ` +
    `if ${name} has been updated, reload it and open Zenith from it again.`
  );
}

/**
 * The sentence for a save the host answered with `ok: false`. The host's reason is its own text and
 * often already ends its sentence ("... then save again."), so a full stop is added only when it
 * does not; `verb` is "did not save" for a save still waiting and "could not save" for a late answer.
 */
export function refusedSaveLine(hostName: string, autoName: string, error: string | undefined, verb: string): string {
  return `${hostName} ${verb} ${autoName}: ${endSentence(error)}`;
}

/** A host's reason as the end of a sentence: "no reason given" when empty, a full stop when it has none. */
function endSentence(text: string | undefined): string {
  const reason = (text ?? "").trim() || "no reason given";
  return /[.!?]$/.test(reason) ? reason : `${reason}.`;
}

/** The sentence for a `run` the host answered with `runFailed`, which gives the host's own reason. */
export function runFailedLine(hostName: string, fileName: string, reason: string): string {
  return `${hostName} could not simulate ${fileName}: ${endSentence(reason)}`;
}

/** The sentence for a `run` the host never answered. */
export function runTimeoutLine(hostName: string, seconds: number): string {
  return `${hostName} did not send a trace back within ${String(seconds)} s. Check ${hostName}'s window, then try again.`;
}
