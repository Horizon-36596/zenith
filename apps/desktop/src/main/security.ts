/**
 * How the renderer is served and fenced in.
 *
 * In production the built web app is served from a privileged custom scheme, `zenith://app/`,
 * rather than from `file://`. Two reasons: the web build addresses its assets and fonts from the
 * site root (`/assets/...`, `/fonts/...`), which under `file://` would point at the root of the
 * drive; and Electron's security checklist advises against `file://`, whose pages can read any
 * other local file. The handler serves only files inside the renderer folder, with a strict
 * Content-Security-Policy on every response.
 *
 * In development the renderer is the Vite dev server, whose React refresh preamble is an inline
 * script and whose HMR is a websocket, so its policy allows exactly those two things more.
 *
 * A build given a Firebase config also lets the optional cloud's REST and streaming hosts through
 * (cloud.ts), and a build without one serves the same strict policy as before the cloud existed. A
 * build given an App Check site key as well lets reCAPTCHA Enterprise's script, frame and calls and
 * App Check's token exchange through, each limited to its path (cloud.ts says which, and why the
 * built app still gets no App Check token).
 */
import { readFile } from "node:fs/promises";
import { extname, join, normalize, relative, isAbsolute } from "node:path";
import { cloudCspSources, type CloudHosts } from "./cloud.js";

export const APP_SCHEME = "zenith";
export const APP_ORIGIN = `${APP_SCHEME}://app`;

/** api.github.com is the web build's own GitHub mode, which works unchanged inside the app. */
const CONNECT = ["'self'", "https://api.github.com"];
const IMAGES = ["'self'", "data:", "blob:", "https://raw.githubusercontent.com", "https://avatars.githubusercontent.com"];

export interface CspOptions {
  /** The Vite dev server's origin in a development run, or null in a built app. */
  devOrigin: string | null;
  /** The optional cloud's hosts when the build has a Firebase config (cloud.ts), or null. */
  cloud: CloudHosts | null;
}

/**
 * The page's Content-Security-Policy. The built app allows scripts from itself only; a development
 * run adds the dev server's inline refresh preamble and its HMR websocket. With a Firebase config,
 * and only then, it adds the cloud's REST and streaming hosts from cloud.ts to connect-src. A
 * development run, which signs in with Firebase's popup, also adds Google's script loader to
 * script-src and the auth domain to frame-src for Firebase Auth's hidden frame, when the config names
 * an auth domain; the built app signs in through the system browser and needs neither. With an App
 * Check site key, both add reCAPTCHA Enterprise's and App Check's sources. Everything else stays
 * denied.
 */
export function buildCsp(options: CspOptions): string {
  const dev = options.devOrigin;
  const cloud = cloudCspSources(options.cloud, { popup: dev !== null });
  const script = ["'self'", ...(dev === null ? [] : ["'unsafe-inline'"]), ...cloud.script];
  const connect = [...CONNECT, ...cloud.connect, ...(dev === null ? [] : [dev.replace(/^http/, "ws")])];
  const frame = cloud.frame.length === 0 ? ["'none'"] : cloud.frame;
  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${IMAGES.join(" ")}`,
    "font-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    `frame-src ${frame.join(" ")}`,
  ].join("; ");
}

/** The built app's policy with the cloud off: no remote script, no frames. */
export const PRODUCTION_CSP = buildCsp({ devOrigin: null, cloud: null });

export function devCsp(devOrigin: string, cloud: CloudHosts | null = null): string {
  return buildCsp({ devOrigin, cloud });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * Maps a `zenith://app/<path>` URL onto a file inside `rendererDir`, or null when it would leave it.
 * A path with no extension is an in-app route and gets `index.html`.
 */
export function resolveAppFile(rendererDir: string, url: string): string | null {
  let pathname: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== "app") return null;
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  const rel = pathname === "/" || extname(pathname) === "" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = normalize(join(rendererDir, rel));
  const back = relative(rendererDir, full);
  if (back === "" || back.startsWith("..") || isAbsolute(back)) return null;
  return full;
}

/** The `protocol.handle` callback for the app scheme, which sends `csp` with every file. */
export function appProtocolHandler(rendererDir: string, csp: string = PRODUCTION_CSP): (request: Request) => Promise<Response> {
  return async (request) => {
    const file = resolveAppFile(rendererDir, request.url);
    if (file === null) return new Response("Not found", { status: 404 });
    try {
      const body = await readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
          "content-security-policy": csp,
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  };
}

/** True for a URL the app window may navigate to: its own origin only. */
export function isAppUrl(url: string, devOrigin: string | null): boolean {
  try {
    const parsed = new URL(url);
    if (devOrigin !== null) return parsed.origin === new URL(devOrigin).origin;
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === "app";
  } catch {
    return false;
  }
}

/** True for a link the system browser may open: http and https only, never file: or a custom scheme. */
export function isExternalWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
