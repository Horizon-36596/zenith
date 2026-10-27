/**
 * The beta notice: on the first load of each version a small dialog says Zenith is in beta and where
 * to report a bug. Got it or Escape closes it, and it stays closed for that version; a new version
 * shows it once more. Blocked storage shows it on every load and the app still works. It comes first
 * and alone: the first run's preset card and tour, a cloud link's page, and a host's tour wait for it.
 *
 * Every other spec starts with the notice dismissed (`storageState` in playwright.config.ts, from
 * e2e/betaNotice.ts); this one starts from an empty profile.
 *
 * Screenshots go to test-results/beta-notice/, which git ignores, or to ZENITH_E2E_SHOTS when set.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { APP_VERSION, BETA_NOTICE_KEY } from "./betaNotice";
import { turnOnFeatures } from "./features";
import { choosePreset } from "./qa/helpers";

const SHOTS = process.env["ZENITH_E2E_SHOTS"] ?? fileURLToPath(new URL("../test-results/beta-notice/", import.meta.url));

// An empty profile: nothing seeded, so this is what a new visitor sees.
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async ({ page }) => {
  await turnOnFeatures(page);
});

const notice = (page: Page) => page.getByTestId("beta-notice");

test("a first load shows the notice alone, and Got it closes it for good, then the first run goes on", async ({ page }) => {
  await page.goto("/");
  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toContainText("Zenith is in beta");
  await expect(notice(page)).toContainText("Horizon (FTC 36596)");
  await expect(notice(page)).toContainText("Report a bug");
  await expect(notice(page).getByTestId("beta-notice-issues")).toHaveAttribute("href", "https://github.com/Horizon-36596/zenith/issues");
  await expect(notice(page).getByTestId("beta-notice-changelog")).toHaveAttribute("href", "https://libraries.horizon36596.org/zenith/changelog/");
  // A native modal dialog, with Got it, the one primary button, holding the focus.
  await expect(notice(page)).toHaveJSProperty("open", true);
  expect(await notice(page).evaluate((dialog) => dialog.matches(":modal"))).toBe(true);
  await expect(notice(page).getByTestId("beta-notice-ok")).toBeFocused();

  // The example loads behind it, but the preset card and the tour wait.
  await expect(page.getByTestId("step-row-driveOut")).toBeAttached();
  await expect(page.getByTestId("preset-card")).toHaveCount(0);
  await expect(page.getByTestId("tour")).toHaveCount(0);

  // The app's keys do nothing behind it: P does not pick Add path, Ctrl+K opens no palette, and
  // Ctrl+Z and Delete change nothing.
  const addPath = page.getByRole("toolbar", { name: "Toolbar" }).getByRole("button", { name: "Add path" });
  await expect(addPath).toBeEnabled();
  await expect(addPath).toHaveAttribute("aria-pressed", "false");
  for (const key of ["p", "Control+k", "Control+z", "Delete"]) await page.keyboard.press(key);
  await expect(addPath).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("palette-input")).toHaveCount(0);
  await expect(page.getByTestId("step-row-driveOut")).toBeAttached();
  await expect(notice(page)).toBeVisible();
  await expect(notice(page).getByTestId("beta-notice-ok")).toBeFocused();

  await page.getByTestId("beta-notice-ok").click();
  await expect(notice(page)).toHaveCount(0);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), BETA_NOTICE_KEY)).toBe("dismissed");
  // The preset card that waited for it opens and takes the focus.
  await expect(page.getByTestId("preset-card-essential")).toBeFocused();
  await choosePreset(page);
  await expect(page.getByTestId("tour")).toBeVisible();

  // Reloaded, the first visit is over, so the welcome screen shows, with no notice over it.
  await page.reload();
  await expect(page.getByTestId("canvas-load-example")).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
});

test("Escape closes the notice and counts as dismissed", async ({ page }) => {
  await page.goto("/");
  await expect(notice(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(notice(page)).toHaveCount(0);
  // The first run goes on: Escape on the notice was not taken as Skip on the preset card.
  await expect(page.getByTestId("preset-card")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("preset-card")).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
});

test("a new version shows the notice again, and Got it leaves the focus on the field", async ({ page }) => {
  // A returning visitor, whose dismissal is for an older version only.
  await page.addInitScript(() => {
    window.localStorage.setItem("zenith.betaNotice.0.0.1", "dismissed");
    window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
  });
  expect(APP_VERSION).not.toBe("0.0.1");
  await page.goto("/");
  await expect(notice(page)).toBeVisible();
  await page.getByTestId("beta-notice-ok").click();
  await expect(notice(page)).toHaveCount(0);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), BETA_NOTICE_KEY)).toBe("dismissed");
  // Nothing waited for the notice, so the focus goes to the field rather than the page's body.
  await expect(page.getByTestId("preset-card")).toHaveCount(0);
  await expect(page.locator('[data-region][aria-label="Field canvas"]')).toBeFocused();
});

test("with storage that throws, the notice shows on every load and the app still works", async ({ page }) => {
  await page.addInitScript(() => {
    const blocked = (): never => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    Storage.prototype.getItem = blocked;
    Storage.prototype.setItem = blocked;
    Storage.prototype.removeItem = blocked;
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(notice(page)).toBeVisible();
  await page.getByTestId("beta-notice-ok").click();
  await expect(notice(page)).toHaveCount(0);
  // The first run goes on, and the editor answers.
  await choosePreset(page);
  await expect(page.getByTestId("tour")).toBeVisible();
  await page.getByTestId("tour-skip").click();
  await page.getByTestId("step-row-shootPreloads").click();
  await expect(page.getByTestId("inspector-title")).toHaveText("shootPreloads");

  await page.reload();
  await expect(notice(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(notice(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a share link opened on a first load shows the notice first, then the link's page", async ({ page }) => {
  await page.goto("/#/s/AAAAAAAAAAAAAAAAAAAAAA");
  await expect(notice(page)).toBeVisible();
  await expect(page.getByTestId("cloud-off-link")).toHaveCount(0);
  await page.getByTestId("beta-notice-ok").click();
  await expect(page.getByTestId("cloud-off-link")).toBeVisible();
  await expect(page.getByTestId("cloud-off-link-close")).toBeVisible();
});

const STARTER = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const FAKE_HOST = fileURLToPath(new URL("./fixtures/fake-host.html", import.meta.url));
const read = (path: string): string => readFileSync(join(STARTER, path), "utf8");

test("in a host's window the notice shows once, the host's project still opens, and the tour waits", async ({ page }) => {
  await page.route("**/__fake-host.html", (route) =>
    route.fulfill({ contentType: "text/html", body: readFileSync(FAKE_HOST, "utf8") }),
  );
  await page.goto("/__fake-host.html");
  const popup = page.waitForEvent("popup");
  await page.evaluate(() => {
    (window as unknown as { openZenith: (path: string) => void }).openZenith("/?host=dsim");
  });
  const zenith = await popup;
  // The popup is this context's first load of the app, so its modules come cold: wait as goto does.
  await zenith.waitForLoadState("load");
  await expect(zenith.getByTestId("host-gate")).toHaveAttribute("data-phase", "waiting");
  await expect(notice(zenith)).toBeVisible();
  await page.evaluate(
    (data) => {
      (window as unknown as { sendToZenith: (message: unknown) => void }).sendToZenith(data);
    },
    {
      type: "open",
      protocol: "zenith-host/1",
      project: {
        name: "starter",
        robot: JSON.parse(read("autos/robot.json")) as unknown,
        field: read("autos/field/biobuzz.field.json"),
        waypoints: read("autos/waypoints.json"),
        autos: { "collect-and-score": read("autos/collect-and-score.auto.json") },
      },
      open: "collect-and-score",
    },
  );
  // The handshake finished under the notice: the host's auto is open behind it.
  await expect(zenith.getByTestId("step-row-driveOut")).toBeAttached();
  await expect(zenith.getByTestId("tour-card")).toHaveCount(0);
  await zenith.getByTestId("beta-notice-ok").click();
  await expect(notice(zenith)).toHaveCount(0);
  await expect(zenith.getByTestId("tour-card")).toBeVisible();
});

/** The look, for the review: the notice over the example at the sizes and themes people use. */
test("the notice at 1280x720 and phone width, dark and light", async ({ page }) => {
  // Four loads of the app, each about as long as one whole test's.
  test.setTimeout(180_000);
  for (const scheme of ["dark", "light"] as const) {
    for (const size of [
      { width: 1280, height: 720 },
      { width: 375, height: 720 },
    ]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(size);
      await page.goto("/");
      await expect(notice(page)).toBeVisible();
      await expect(page.getByTestId("step-row-driveOut")).toBeAttached();
      // The theme the Settings switch applies, set once the app has applied its own.
      await page.evaluate((theme) => {
        document.documentElement.dataset["theme"] = theme;
      }, scheme);
      const box = await notice(page).boundingBox();
      expect(box).not.toBeNull();
      if (box !== null) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      }
      await page.screenshot({ path: join(SHOTS, `beta-notice-${scheme}-${String(size.width)}.png`) });
    }
  }
});
