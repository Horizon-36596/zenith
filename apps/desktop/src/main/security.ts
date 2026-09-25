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
 */
import { readFile } from "node:fs/promises";
import { extname, join, normalize, relative, isAbsolute } from "node:path";

export const APP_SCHEME = "zenith";
export const APP_ORIGIN = `${APP_SCHEME}://app`;

/** api.github.com is the web build's own GitHub mode, which works unchanged inside the app. */
const CONNECT = "'self' https://api.github.com";

export const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://raw.githubusercontent.com https://avatars.githubusercontent.com",
  "font-src 'self' data:",
  `connect-src ${CONNECT}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
].join("; ");

export function devCsp(devOrigin: string): string {
  const ws = devOrigin.replace(/^http/, "ws");
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://raw.githubusercontent.com https://avatars.githubusercontent.com",
    "font-src 'self' data:",
    `connect-src ${CONNECT} ${ws}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
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

/** The `protocol.handle` callback for the app scheme. */
export function appProtocolHandler(rendererDir: string): (request: Request) => Promise<Response> {
  return async (request) => {
    const file = resolveAppFile(rendererDir, request.url);
    if (file === null) return new Response("Not found", { status: 404 });
    try {
      const body = await readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
          "content-security-policy": PRODUCTION_CSP,
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
