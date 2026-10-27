/**
 * The Documentation action (issue #225): one action, help.docs, that opens the live docs in a new
 * tab, reached from a toolbar button, the first item of the Help menu and the command palette.
 * window.open is stubbed, so nothing here touches the network.
 */
import { expect, test, type Page } from "@playwright/test";
import { LARGE_VIEWPORT, VIEWPORT } from "./viewports";
import { loadExample, shot, skipTour, waitForFonts } from "./qa/helpers";

const DOCS = "https://libraries.horizon36596.org/zenith/";

declare global {
  interface Window {
    __opened: { url: string | undefined; target: string | undefined; features: string | undefined }[];
  }
}

/** Replaces window.open before the app loads, and records what it was asked to open. */
async function stubOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__opened = [];
    window.open = ((url?: string | URL, target?: string, features?: string) => {
      window.__opened.push({ url: url === undefined ? undefined : String(url), target, features });
      return null;
    }) as typeof window.open;
  });
}

const opened = (page: Page) => page.evaluate(() => window.__opened);

test.beforeEach(async ({ page }) => {
  await stubOpen(page);
  await skipTour(page);
  await loadExample(page);
  await waitForFonts(page);
});

test("the toolbar's book button opens the docs in a new tab", async ({ page }) => {
  await page.getByTestId("toolbar-docs").click();
  expect(await opened(page)).toEqual([{ url: DOCS, target: "_blank", features: "noopener" }]);
});

test("the book button sits between Settings and Help and has a tooltip", async ({ page }) => {
  const [settings, docs, help] = await Promise.all(
    ["toolbar-settings", "toolbar-docs", "toolbar-help"].map((id) => page.getByTestId(id).boundingBox()),
  );
  expect(settings && docs && help).toBeTruthy();
  expect(docs!.x).toBeGreaterThan(settings!.x + settings!.width - 1);
  expect(docs!.x + docs!.width).toBeLessThan(help!.x + 1);
  await page.getByTestId("toolbar-docs").hover();
  await expect(page.getByRole("tooltip")).toContainText("Documentation");
});

test("searching for docs finds Documentation first, and Enter opens it", async ({ page }) => {
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("docs");
  const first = page.getByTestId("palette-results").locator('[role="option"]').first();
  await expect(first).toContainText("Documentation");
  await expect(page.getByTestId("palette-item-help.docs")).toBeVisible();
  await page.keyboard.press("Enter");
  expect(await opened(page)).toEqual([{ url: DOCS, target: "_blank", features: "noopener" }]);
});

test("the Help menu starts with Documentation, marked external, and keeps its others in order", async ({ page }) => {
  await page.getByTestId("toolbar-help").click();
  const items = page.getByTestId("help-menu").getByRole("menuitem");
  // Search actions has its own button beside Help, so the menu does not repeat it (issue #412).
  await expect(items).toHaveCount(7);
  await expect(items.nth(0)).toContainText("Documentation");
  await expect(items.nth(0).getByTestId("external-mark")).toBeVisible();
  const rest = ["Take the tour", "Take the full tour", "Choose a preset", "Keyboard shortcuts", "What's this", "Report a bug"];
  for (const [at, label] of rest.entries()) await expect(items.nth(at + 1)).toContainText(label);
  await expect(page.getByTestId("help-menu").getByTestId("external-mark")).toHaveCount(1);

  await page.getByTestId("menu-help.docs").click();
  expect(await opened(page)).toEqual([{ url: DOCS, target: "_blank", features: "noopener" }]);
});

test("the shortcut sheet links to the full guide and lists no new key", async ({ page }) => {
  await page.keyboard.press("?");
  const link = page.getByTestId("shortcuts-guide-link");
  await expect(link).toHaveAttribute("href", `${DOCS}editor/#keyboard-reference`);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(page.getByTestId("shortcuts-overlay").locator("dt kbd", { hasText: /docs/i })).toHaveCount(0);
});

for (const [name, size, scale] of [
  ["1280x720", VIEWPORT, 1],
  ["1440x900 at 1.95x", LARGE_VIEWPORT, 1.95],
] as const) {
  test.describe(name, () => {
    test.use({ viewport: size, deviceScaleFactor: scale });

    test("the toolbar neither overflows nor wraps with the book button in it", async ({ page }) => {
      const fit = await page.getByTestId("toolbar").evaluate((bar) => {
        const buttons = [...bar.querySelectorAll<HTMLElement>("button")].filter((b) => b.getBoundingClientRect().width > 0);
        const tops = buttons.map((b) => Math.round(b.getBoundingClientRect().top));
        const right = Math.max(...buttons.map((b) => b.getBoundingClientRect().right));
        return {
          overflows: bar.scrollWidth > bar.clientWidth + 1,
          rows: new Set(tops.map((top) => Math.round(top / 8))).size,
          inside: right <= window.innerWidth,
        };
      });
      expect(fit).toEqual({ overflows: false, rows: 1, inside: true });
      await expect(page.getByTestId("toolbar-docs")).toBeVisible();
      await shot(page, `docs-link-toolbar-${String(size.width)}x${String(size.height)}`);
    });
  });
}
