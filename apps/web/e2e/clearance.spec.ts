/**
 * The clearance from field elements (owner ruling D8, issue #289). It belongs to the robot, so
 * Settings, Robot shows Zenith's 1 in default while robot.json leaves it out and offers Set, which
 * writes `footprint.clearanceIn` SET BY HAND; the CLEARANCE warnings follow the file, and the only
 * per-person setting, the clearance outline, draws without changing them.
 */
import { expect, test, type Page } from "@playwright/test";
import { openServedFolder, readServed, serveFolder, starterFiles } from "./opfsProject";
import { findingRows } from "./qa/helpers";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
    window.localStorage.removeItem("zenith.cloudFake");
  });
});

const NEAR_THE_LEGS = "autos/near-the-legs.auto.json";

/**
 * The starter's toGarden as it was before issue #365, alone, from the scoring spot north of the hive
 * on x = -9 south under the hive, between the hive frame's legs: it passes 0.69 in from one west leg
 * and 0.47 in from the other. The starter itself now goes round the west of the frame.
 */
const NEAR_THE_LEGS_AUTO = `${JSON.stringify(
  {
    $schema: "https://libraries.horizon36596.org/zenith/schema/v1/auto.json",
    formatVersion: 4,
    name: "near-the-legs",
    robot: "autos/robot.json",
    field: "autos/field/biobuzz.field.json",
    alliance: "RED",
    start: { pose: { xIn: -9, yIn: 36, headingRad: -1.5708, provenance: "SET BY HAND: e2e fixture" } },
    steps: [
      {
        id: "toGarden",
        kind: "path",
        segments: [
          {
            kind: "bezier",
            from: "current",
            control: [
              { xIn: -5, yIn: -56, provenance: "SET BY HAND: e2e fixture" },
              { xIn: -16, yIn: -62, provenance: "SET BY HAND: e2e fixture" },
            ],
            to: { ref: "gardenSweepStart" },
          },
        ],
        heading: { mode: "tangent" },
      },
    ],
  },
  null,
  2,
)}\n`;

/** Opens the starter as a folder project, on the fixture whose toGarden passes two legs. */
async function openFolder(page: Page): Promise<void> {
  await serveFolder(page, { ...starterFiles(), [NEAR_THE_LEGS]: NEAR_THE_LEGS_AUTO });
  await page.goto("/");
  await openServedFolder(page);
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await page.getByTestId("toolbar-auto-name").click();
  await page.getByTestId("open-auto-near-the-legs.auto.json").click();
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("near-the-legs.auto.json");
}

const clearanceRows = (page: Page) => findingRows(page, "CLEARANCE");

async function openRobot(page: Page): Promise<void> {
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-robot").click();
  await expect(page.getByTestId("settings-section-robot")).toBeVisible();
}

test("Settings, Robot sets the clearance in robot.json, SET BY HAND, and the warnings follow it", async ({ page }) => {
  await openFolder(page);
  await expect(clearanceRows(page)).toHaveCount(2);
  await expect(clearanceRows(page).first()).toContainText("within 1 in (Zenith's default; set it in Settings, Robot)");

  await openRobot(page);
  await expect(page.getByTestId("settings-robot-clearance-default")).toHaveText("1 in (default)");
  await page.getByTestId("settings-robot-clearance-set").click();
  const field = page.getByTestId("settings-robot-clearance");
  await expect(field).toHaveValue("1.00");
  await field.fill("0.5");
  await field.press("Enter");
  await page.getByTestId("settings-robot-save").click();
  await expect(page.getByTestId("settings-robot-result")).toHaveText("Saved robot.json to autos/robot.json.");

  const before = starterFiles()["autos/robot.json"] ?? "";
  const after = await readServed(page, "autos/robot.json");
  const block = `,\n    "clearanceIn": {\n      "value": 0.5,\n      "provenance": "SET BY HAND: chosen in Settings, Robot"\n    }`;
  // The file gains the key, last in footprint, and nothing else in it moves.
  expect(after).toContain(block);
  expect(after.replace(block, "")).toBe(before);

  await page.keyboard.press("Escape");
  // 0.47 in from the south-west leg is inside 0.5 in; 0.69 in from the north-west one is not.
  await expect(clearanceRows(page)).toHaveCount(1);
  await expect(clearanceRows(page).first()).toContainText("within 0.5 in (robot.json, SET BY HAND)");
});

test("the clearance outline draws at the robot and leaves the warnings alone", async ({ page }) => {
  await openFolder(page);
  const canvas = page.getByTestId("field-canvas");
  await expect(canvas).toHaveAttribute("data-robot-pose", /,/);
  await expect(clearanceRows(page)).toHaveCount(2);
  await expect(canvas).not.toHaveAttribute("data-clearance-outline", /./);

  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-editor").click();
  await page.getByTestId("settings-clearance-outline-choice-on").click();
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-clearance-outline", "1");
  await expect(clearanceRows(page)).toHaveCount(2);
});
