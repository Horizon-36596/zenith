/**
 * The Optimize path worker loads in the desktop renderer under its Content-Security-Policy
 * (issue #306). The built app is served from `zenith://app/` with the strict policy of
 * `src/main/security.ts`; the web build's `optimizer` entry, the host, starts its module worker from
 * there, and a short run finishes in that worker, not in the page's slices, with no policy violation on
 * the way.
 *
 * Windowless, as every desktop test is (ZENITH_HEADLESS=1). Build first:
 * `pnpm --filter @horizon36596/zenith-web build`, then `pnpm --filter @horizon36596/zenith-desktop build`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const pkg = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const assets = join(pkg, "dist", "renderer", "assets");
const starter = join(pkg, "..", "..", "examples", "starter");
const require = createRequire(import.meta.url);
const read = (relative: string): unknown => JSON.parse(readFileSync(join(starter, relative), "utf8"));

let app: ElectronApplication;
let page: Page;
let profile = "";
let pid: number | undefined;

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), "zenith-e2e-optimizer-"));
  app = await electron.launch({
    executablePath: require("electron") as string,
    args: [pkg],
    env: { ...process.env, ZENITH_USER_DATA: profile, ZENITH_DEV_URL: "", ZENITH_HEADLESS: "1" },
  });
  pid = app.process().pid;
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  const child = app?.process();
  const exited = new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    setTimeout(resolve, 10_000);
  });
  await app?.evaluate(({ app: electronApp }) => {
    electronApp.exit(0);
  }).catch(() => undefined);
  await exited;
  if (pid !== undefined && process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      // Already gone, which is the usual case after exit().
    }
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("the optimizer's module worker runs in the desktop renderer under its CSP", async () => {
  test.setTimeout(120_000);
  const files = readdirSync(assets);
  const host = files.find((file) => /^optimizer-[\w-]+\.js$/.test(file));
  const workerChunk = files.find((file) => /^worker-[\w-]+\.js$/.test(file));
  expect(host, "the web build's optimizer entry").toBeDefined();
  expect(workerChunk, "the web build's worker chunk").toBeDefined();

  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });

  const link = loadLink(read("zenith.json"));
  const request = {
    auto: loadAuto(JSON.parse(readFileSync(join(pkg, "..", "..", "packages", "core", "test-fixtures", "corridor-collect-and-score.auto.json"), "utf8")) as unknown),
    robot: loadRobot(read(link.robot)),
    field: loadField(read(link.field)),
    waypoints: loadWaypoints(read(link.waypoints ?? "autos/waypoints.json")),
    stepId: "toOtherSide",
  };
  const outcome = await page.evaluate(
    async ({ hostUrl, input }) => {
      const blocked: string[] = [];
      // This tsconfig has no DOM types; the page's document is typed by hand for the one listener.
      type Violation = { violatedDirective: string; blockedURI: string };
      const page = globalThis as unknown as { document: { addEventListener(type: string, listener: (event: Violation) => void): void } };
      page.document.addEventListener("securitypolicyviolation", (event) => blocked.push(`${event.violatedDirective} ${event.blockedURI}`));
      type Run = { engine: string; continue(): void };
      type Host = {
        startOptimize(request: unknown, options: unknown, events: Record<string, (...args: never[]) => void>): Run;
      };
      const host = (await import(/* @vite-ignore */ hostUrl)) as Host;
      const result = await new Promise<{ engine: string; status?: string; error?: string }>((resolve) => {
        const run = host.startOptimize(input, { budget: 50 }, {
          stopped: () => run.continue(),
          done: (done: { status: string }) => resolve({ engine: run.engine, status: done.status }),
          failed: (message: string) => resolve({ engine: run.engine, error: message }),
        });
      });
      return { ...result, blocked };
    },
    { hostUrl: `zenith://app/assets/${host as string}`, input: request },
  );

  expect(outcome.error).toBeUndefined();
  expect(outcome.engine).toBe("worker");
  expect(["improved", "noBetter", "infeasible"]).toContain(outcome.status);
  expect(workers).toEqual([`zenith://app/assets/${workerChunk as string}`]);
  expect(outcome.blocked).toEqual([]);
  expect(violations).toEqual([]);
});
