/**
 * The ledger's count chips on the field (issue #118): each count split into pollen and nectar, a
 * chip that rides with the robot outline and says what it carries at the playhead, and the same
 * chips for the same playhead time however it got there. The canvas publishes the chips it drew on
 * `data-ledger-counts` as `id=kind:count,...@where:x,y`.
 *
 * `ZENITH_COUNT_SHOTS` names a folder to save the night, day and 390 px screenshots to.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
  });
  await turnOnFeatures(page, { ledger: true });
});

/** The floor count once the preloads have tipped the hive: what the up cell held, dumped on its side. */
const TIPPED = "floorRedGardenSide=pollen:4,nectarRed:3@";

async function loadExample(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

const setPlayback = (page: Page, timeS: number): Promise<unknown> =>
  page.evaluate(`import("/src/state/store.ts").then((m) => m.setPlayback(${String(timeS)}))`);

const counts = (page: Page): Promise<string> =>
  page.getByTestId("field-canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).dataset["ledgerCounts"] ?? "");

/** One chip from the published summary: its parts and centre. */
function chip(summary: string, id: string): { parts: string; at: string; xPx: number; yPx: number } | null {
  const entry = summary.split(";").find((item) => item.startsWith(`${id}=`));
  if (entry === undefined) return null;
  const match = /^[^=]+=([^@]*)@(\w+):(-?[\d.]+),(-?[\d.]+)$/.exec(entry);
  if (match === null) return null;
  return { parts: match[1] ?? "", at: match[2] ?? "", xPx: Number(match[3]), yPx: Number(match[4]) };
}

/** Waits until the canvas has drawn a frame since now. */
const nextFrame = (page: Page): Promise<unknown> =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

/**
 * The first playhead time from `fromS`, on a quarter-second grid, at which the counts contain
 * `text`: where the preview sim finished the step that made them so.
 */
async function firstTimeWith(page: Page, text: string, fromS = 0): Promise<number> {
  // The preview sim runs a tick after load, and the counts read its step ends: wait until it has
  // finished the first scoring, which the counts at the end of the period show.
  await setPlayback(page, 30);
  await expect.poll(() => counts(page), { timeout: 30_000 }).not.toContain("robot=pollen:4@");
  for (let timeS = fromS; timeS <= 30; timeS += 0.25) {
    await setPlayback(page, timeS);
    await nextFrame(page);
    if ((await counts(page)).includes(text)) return timeS;
  }
  throw new Error(`the counts never contain ${text}; at the end they are ${await counts(page)}`);
}

/** The robot outline's centre on screen, from the pose and view the canvas publishes. */
const robotScreen = (page: Page): Promise<{ xPx: number; yPx: number }> =>
  page.getByTestId("field-canvas").evaluate((canvas) => {
    const data = (canvas as HTMLCanvasElement).dataset;
    const [xIn, yIn] = (data["robotPose"] ?? "0,0").split(",").map(Number);
    const pxPerIn = Number(data["pxPerIn"]);
    // The default orientation: x right, y up.
    return { xPx: Number(data["originXPx"]) + pxPerIn * (xIn ?? 0), yPx: Number(data["originYPx"]) - pxPerIn * (yIn ?? 0) };
  });

test("the field's counts split pollen from nectar, and the robot's chip rides with it", async ({ page }) => {
  await loadExample(page);
  await expect.poll(() => counts(page)).toContain("robot=pollen:4@robot:");
  const start = await counts(page);
  // Our hive starts with 3 of our nectar, the flowers with 4 pollen each; empty places have no chip.
  expect(chip(start, "hiveRedUpCell")?.parts).toBe("nectarRed:3");
  expect(chip(start, "flower0")?.parts).toBe("pollen:4");
  expect(chip(start, "floorRedGardenSide")).toBeNull();

  // All four preloads go in one volley, which tips the hive: the robot is empty, the north cell
  // comes up empty, and the south cell's 4 pollen and 3 nectar lie on the floor on its side.
  const scored = await firstTimeWith(page, TIPPED);
  await setPlayback(page, scored + 0.05);
  await expect.poll(() => counts(page)).toContain(TIPPED);
  const after = await counts(page);
  expect(chip(after, "robot")?.parts).toBe("");
  expect(chip(after, "hiveRedUpCell")?.parts).toBe("");

  // Full again from the north flower: the robot's chip is beside the outline wherever the robot is.
  const refilled = await firstTimeWith(page, "robot=pollen:4@", scored);
  for (const timeS of [refilled + 0.05, refilled + 2, refilled + 4]) {
    await setPlayback(page, timeS);
    await expect.poll(async () => chip(await counts(page), "robot")?.at).toBe("robot");
    const robotChip = chip(await counts(page), "robot");
    const centre = await robotScreen(page);
    if (robotChip === null) throw new Error("no robot chip");
    expect(Math.hypot(robotChip.xPx - centre.xPx, robotChip.yPx - centre.yPx), `at ${String(timeS)} s`).toBeLessThan(90);
  }
});

test("the counts are the same for the same playhead time, however it got there", async ({ page }) => {
  await loadExample(page);
  const at = (await firstTimeWith(page, TIPPED)) + 1;
  await setPlayback(page, at);
  await expect.poll(() => counts(page)).toContain(TIPPED);
  const first = await counts(page);
  await setPlayback(page, 0);
  await expect.poll(() => counts(page)).toContain("robot=pollen:4");
  await setPlayback(page, at);
  await expect.poll(() => counts(page)).toBe(first);
});

test("the counts and their screenshots in night, day and at 390 px", async ({ page }) => {
  const dir = process.env["ZENITH_COUNT_SHOTS"];
  await loadExample(page);
  // After the tip, with the robot full again from the north flower.
  await setPlayback(page, (await firstTimeWith(page, "robot=pollen:4@", await firstTimeWith(page, TIPPED))) + 1.5);
  await expect.poll(() => counts(page)).toContain(TIPPED);
  await expect.poll(() => counts(page)).toContain("robot=pollen:4@robot:");
  const canvas = page.getByTestId("field-canvas");
  if (dir !== undefined) {
    mkdirSync(dir, { recursive: true });
    await canvas.screenshot({ path: join(dir, "field-counts-night.png") });
  }

  await page.evaluate(() => {
    document.documentElement.dataset["theme"] = "light";
  });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  // The well stays dark in the day theme, so the chips keep their dark fill and their counts.
  await expect.poll(() => counts(page)).toContain(TIPPED);
  if (dir !== undefined) await page.screenshot({ path: join(dir, "field-counts-day.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => counts(page)).toContain("robot=pollen:4");
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  if (dir !== undefined) await page.screenshot({ path: join(dir, "field-counts-390.png") });
});

test("the Ledger switch off draws no counts", async ({ page }) => {
  await turnOnFeatures(page, { ledger: false });
  await page.addInitScript(() => {
    const prefs = JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}") as Record<string, unknown>;
    prefs["features"] = { partners: false, ledger: false, commands: false };
    window.localStorage.setItem("zenith.ui", JSON.stringify(prefs));
  });
  await loadExample(page);
  await expect(page.getByTestId("field-canvas")).toHaveAttribute("data-robot-pose", /,/);
  expect(await counts(page)).toBe("");
});
