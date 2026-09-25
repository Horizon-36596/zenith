// `pnpm --filter @horizon36596/zenith-desktop dev`: starts the apps/web Vite dev server on its own port (so it
// never collides with a browser dev server on 5173), bundles the main process and preload, and
// launches Electron pointed at the dev server. Closing the window stops everything.
//
// The web app imports @horizon36596/zenith-core by its built entry, so run `pnpm build` once before the first
// dev session, as for `pnpm --filter @horizon36596/zenith-web dev`.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { bundle } from "./build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const webRoot = join(pkg, "..", "web");
const require = createRequire(import.meta.url);

const server = await createServer({
  root: webRoot,
  configFile: join(webRoot, "vite.config.ts"),
  server: { port: 5190, strictPort: false },
  clearScreen: false,
});
await server.listen();
const url = server.resolvedUrls?.local[0]?.replace(/\/$/, "") ?? "http://localhost:5190";
console.log(`desktop: renderer from ${url}`);

await bundle({ dev: true });

const electron = require("electron");
const child = spawn(electron, [pkg], {
  stdio: "inherit",
  env: { ...process.env, ZENITH_DEV_URL: url, ELECTRON_ENABLE_LOGGING: "1" },
});

const stop = async (code) => {
  await server.close();
  process.exit(code ?? 0);
};
child.on("close", (code) => void stop(code));
process.on("SIGINT", () => {
  child.kill();
});
