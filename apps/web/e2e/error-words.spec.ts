/**
 * Bad files and broken links, worded by their kind and said once (UI_GUIDE section 9.19; the 0.1.2
 * UX review, K5, K6, K12, F3, F4 and C14): a share file in the Partners panel, an import, a trace in
 * the Simulate dialog, and an invite or share link cut short. Each sentence names the file, says
 * what is wrong in plain words and what to do, and never carries the parser's own words.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

const SHOTS = process.env["ZENITH_E2E_SHOTS"] ?? fileURLToPath(new URL("../test-results/error-words/", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "zenith-error-words-"));

/** A file in a fresh temporary folder, for a file chooser. */
function fileOf(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
  });
  await turnOnFeatures(page);
});

async function loadExample(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

/** Night, then Day, of the page as it is. */
async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((given) => {
      document.documentElement.dataset["theme"] = given;
    }, theme);
    await page.screenshot({ path: `${SHOTS}${name}-${theme === "dark" ? "night" : "day"}.png` });
  }
}

const status = (page: Page) => page.getByTestId("status");

test("a share file with the right name and the wrong contents gets a true sentence (K5)", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("partners-panel-fold").click();
  await page.getByTestId("partners-file-input").setInputFiles(fileOf("wrong-schema.projection.json", '{"hello":"world"}'));
  await expect(status(page)).toHaveText(
    /^wrong-schema\.projection\.json is not a share file Zenith wrote\. Ask your partner for the file Download share file makes in their Zenith\./,
  );
  await expect(status(page)).not.toContainText("end in .projection.json");
  await shoot(page, "partners-wrong-schema");
});

test("an empty, cut off or picture share file says so, and several at once lead with how many (K6)", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("partners-panel-fold").click();
  const input = page.getByTestId("partners-file-input");
  await input.setInputFiles(fileOf("empty.projection.json", ""));
  await expect(status(page)).toHaveText(/^empty\.projection\.json is empty\. Ask your partner to download it again\./);
  await input.setInputFiles(fileOf("truncated.projection.json", '{"$schema": "x", "trajectory": {"poses": [[0, 1'));
  await expect(status(page)).toHaveText(/^truncated\.projection\.json is cut off: the JSON in it stops part way\. Ask your partner to download it again\./);
  await shoot(page, "partners-truncated");
  await input.setInputFiles([fileOf("a.projection.json", ""), fileOf("b.projection.json", "[")]);
  await expect(status(page)).toHaveText(/^None of the files you chose loaded\. a\.projection\.json is empty\./);
  await expect(status(page)).not.toContainText("JSON input");
});

test("an import shows a bad file once, in plain words, and names a Zenith auto for what it is (F3, F4)", async ({ page }) => {
  await loadExample(page);
  const importFile = async (path: string) => {
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("Import from another planner");
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("palette-item-project.import").click();
    await (await chooser).setFiles(path);
  };
  await importFile(fileOf("truncated.auto.json", '{"lines": [{"name": "abc'));
  const notice = page.getByTestId("import-notice");
  await expect(notice).toContainText(
    "truncated.auto.json is cut off: the JSON in it stops part way. Check that this is the file you meant, or export it again from that planner.",
  );
  await expect(notice).not.toContainText("position");
  // Said once: the notice has it, the status line does not.
  await expect(page.getByTestId("status").filter({ hasText: "truncated.auto.json" })).toHaveCount(0);
  await shoot(page, "import-truncated");

  await page.getByTestId("import-notice-dismiss").click();
  const auto = fileURLToPath(new URL("../../../examples/starter/autos/first-auto.auto.json", import.meta.url));
  await importFile(auto);
  await expect(notice).toContainText("first-auto.auto.json is a Zenith auto, not a file from another planner.");
  await expect(notice).not.toContainText("Pedro");
});

test("a trace that does not load is said inside the Simulate dialog, beside Load trace (K12)", async ({ page }) => {
  await loadExample(page);
  await page.keyboard.press("F5");
  const dialog = page.getByTestId("simulate");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("load-trace-button")).toHaveText("Load trace…");
  await expect(dialog).not.toContainText("No file chosen");
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByTestId("load-trace-button").click();
  await (await chooser).setFiles(fileOf("empty.trace.json", ""));
  await expect(dialog.getByTestId("load-trace-error")).toHaveText("empty.trace.json is empty. Run the sim again, then load the trace it writes.");
  await expect(dialog).not.toContainText("Unexpected end of JSON input");
  await shoot(page, "simulate-trace-empty");
});

for (const hash of ["#/join/garbage", "#/s/doesnotexist"]) {
  test(`an invite or share link cut short says so: ${hash} (C14)`, async ({ page }) => {
    await page.goto(`/?cloud=fake${hash}`);
    await expect(status(page)).toHaveText(/^That link is not complete\. Check it, or ask for a new one\./);
    await expect(page).not.toHaveURL(/#\//);
    if (hash.startsWith("#/s/")) await shoot(page, "broken-link");
  });
}
