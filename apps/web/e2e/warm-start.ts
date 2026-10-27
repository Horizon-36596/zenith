/**
 * Loads the editor once before any test runs. The dev server counts as ready as soon as it serves
 * index.html, but Vite compiles the app's modules only when a page first asks for them, and on a busy
 * machine that cold compile takes longer than one test's 45 s. Without this, the first test of a run
 * (and of each spec `pnpm ship` re-runs alone) failed at `page.goto` before it checked anything.
 *
 * Best effort: a page that never renders is reported and the tests run anyway, so the warm-up can only
 * help. A fresh install also optimises Vite's dependencies on the first request, which can leave that
 * first page blank, so a blank page is reloaded.
 */
import { chromium, type FullConfig } from "@playwright/test";

/** The whole warm-up's limit: well past one test's timeout, short of hiding a hung server. */
const WARM_START_TIMEOUT_MS = 240_000;
/** How long one load may stay blank before it is reloaded. */
const BLANK_RELOAD_MS = 60_000;

export default async function warmStart(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (baseURL === undefined) return;
  const started = Date.now();
  const left = (): number => Math.max(1_000, WARM_START_TIMEOUT_MS - (Date.now() - started));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`page error: ${String(error)}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console error: ${message.text()}`);
  });
  try {
    await page.goto(baseURL, { timeout: left() });
    while (Date.now() - started < WARM_START_TIMEOUT_MS) {
      try {
        await page.waitForFunction(() => (document.querySelector("#root")?.childElementCount ?? 0) > 0, undefined, {
          timeout: Math.min(BLANK_RELOAD_MS, left()),
        });
        console.log(`warm-start: the editor rendered after ${String(Math.round((Date.now() - started) / 1000))} s`);
        return;
      } catch {
        if (Date.now() - started >= WARM_START_TIMEOUT_MS) break;
        await page.reload({ timeout: left() });
      }
    }
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 300);
    console.warn(`warm-start: the editor did not render at ${baseURL} in ${String(WARM_START_TIMEOUT_MS / 1000)} s; running the tests anyway. Page text: "${body}"`);
  } catch (error) {
    console.warn(`warm-start: could not load ${baseURL}; running the tests anyway. ${String(error)}`);
  } finally {
    for (const problem of problems.slice(0, 10)) console.warn(`warm-start: ${problem}`);
    await browser.close();
  }
}
