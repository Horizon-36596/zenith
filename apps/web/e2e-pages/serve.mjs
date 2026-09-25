// Builds the web app with the public site's base path and serves it the way GitHub Pages will: under
// /zenith/app/ and nowhere else. Anything outside that prefix is a 404, so an asset the build
// addresses from the site root (`/assets/...`, `/fields/...`, `/fonts/...`) fails the smoke instead
// of loading by accident.
//
//   node e2e-pages/serve.mjs [port]      (the Playwright config in playwright.pages.config.ts runs it)
//
// Needs the workspace packages built (`pnpm build` at the repository root), as `vite build` does.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE = "/zenith/app/";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const out = join(web, "test-results", "pages-build");
const port = Number(process.argv[2] ?? "4178");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const vite = join(web, "node_modules", "vite", "bin", "vite.js");
const built = spawnSync(process.execPath, [vite, "build", "--outDir", out, "--emptyOutDir", "--logLevel", "warn"], {
  cwd: web,
  stdio: "inherit",
  env: { ...process.env, ZENITH_BASE: BASE },
});
if (built.status !== 0) process.exit(built.status ?? 1);

createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  if (!path.startsWith(BASE)) {
    response.writeHead(404, { "content-type": "text/plain" }).end(`not under ${BASE}: ${path}`);
    return;
  }
  const rel = path.slice(BASE.length) === "" ? "index.html" : path.slice(BASE.length);
  const file = normalize(join(out, rel));
  const inside = relative(out, file);
  if (inside.startsWith("..") || isAbsolute(inside) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { "content-type": "text/plain" }).end(`missing: ${path}`);
    return;
  }
  response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  response.end(readFileSync(file));
}).listen(port, "127.0.0.1", () => {
  console.log(`pages build served at http://127.0.0.1:${String(port)}${BASE}`);
});
