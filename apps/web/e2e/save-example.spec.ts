/**
 * Saving the read-only example (issue #103). Save asks one question: the full project, for a team
 * with no robot repository yet, or just this auto, into a project they already have. With the File
 * System Access API both write into a picked folder (served from the origin-private file system by
 * `opfsProject.ts`), which then opens; without it the full project downloads as a zip that Open
 * files reads back, and the auto downloads on its own. Opening a lone auto says which files it
 * needs and offers the example's robot and field.
 *
 * Issue #158: Save from the unsaved-edits question, before another auto of the example opens, opens
 * the folder the full project went into, and that auto opens from it. Just this auto reads the picked
 * project's waypoints first and asks before writing when some it follows are missing or elsewhere.
 *
 * Screenshots of the two dialogs, in Night and Day, go to test-results/save-example/.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { canonicalize, loadAuto, loadLink, loadWaypoints } from "@horizon36596/zenith-core";
import { readServed, serveFolder, starterFiles } from "./opfsProject";
import { withoutFolderPicker } from "./saveExample";
import { unzipText } from "../src/project/fallback";

const STARTER = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const SHOTS = fileURLToPath(new URL("../test-results/save-example/", import.meta.url));
const read = (path: string): string => readFileSync(`${STARTER}${path}`, "utf8").replace(/\r\n/g, "\n");

/**
 * The zenith.json Save the full project writes (issue #159): the example's, without its sim command,
 * robot class and command library, which name a robot repository the new folder is not.
 */
const NEW_PROJECT_LINK = (() => {
  const link = JSON.parse(read("zenith.json")) as Record<string, unknown>;
  delete link["sim"];
  const deploy = { ...(link["deploy"] as Record<string, unknown>) };
  delete deploy["robotClass"];
  delete deploy["commandLibrary"];
  return canonicalize("link", loadLink({ ...link, deploy }));
})();

/** What Save the full project writes at `path`: the example's own file, but for zenith.json. */
const savedAs = (path: string): string => (path === "zenith.json" ? NEW_PROJECT_LINK : read(path));

/** Every file Save the full project writes for the example, which are the example's own but for zenith.json. */
const PROJECT_FILES = [
  "zenith.json",
  "autos/robot.json",
  "autos/field/biobuzz.field.json",
  "autos/waypoints.json",
  "autos/all-step-kinds.auto.json",
  "autos/collect-and-score.auto.json",
  "autos/cycle-and-park.auto.json",
  "autos/first-auto.auto.json",
];

async function start(page: Page, theme: "dark" | "light" = "dark"): Promise<void> {
  await page.addInitScript((given) => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ theme: given, tour: { seen: true, coreDone: true, fullDone: false } }));
    }
  }, theme);
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

/** Moves driveOut's end, so the open auto has an edit to save. */
async function edit(page: Page, yIn = -30): Promise<void> {
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id !== "driveOut" ? x : { ...x, segments: x.segments.map((seg) => ({ ...seg, to: { xIn: -12, yIn: ${String(yIn)}, headingRad: 1.5708, provenance: "SET BY HAND: e2e edit" } })) }) }); })`,
  );
  await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toBeVisible();
}

const savedCanonical = (page: Page): Promise<string> =>
  page.evaluate(`import("/src/state/store.ts").then((m) => m.getState().savedCanonical)`) as Promise<string>;

/** Runs one palette action by its id. */
async function runAction(page: Page, query: string, id: string): Promise<void> {
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill(query);
  await page.getByTestId(`palette-item-${id}`).click();
}

/** Opens another auto of the project from the auto picker (Ctrl O). */
async function openAuto(page: Page, fileName: string): Promise<void> {
  await page.getByTestId("field-canvas").focus();
  await page.keyboard.press("Control+o");
  await page.getByTestId(`open-auto-${fileName}`).click();
}

/** The names collect-and-score follows that TEAM_WAYPOINTS lacks, in the order it follows them. */
const MISSING = ["flowerNorthApproach", "flowerNorthPickup", "scoreNorth", "gardenSweepStart", "gardenSweepEnd"];

/**
 * A team's own waypoints.json (issue #158): its measured start, 48 in east of the example's, and
 * scoreSouth where the example has it, and nothing else.
 */
const TEAM_WAYPOINTS = (() => {
  const starter = JSON.parse(read("autos/waypoints.json")) as { waypoints: Record<string, unknown> };
  const ours = {
    ...starter,
    waypoints: {
      start: { xIn: 36, yIn: -63, headingRad: 1.5708, provenance: "MEASURED: our start tile, tape to wall" },
      scoreSouth: starter.waypoints["scoreSouth"],
    },
  };
  return canonicalize("waypoints", loadWaypoints(ours));
})();

test.describe("with a folder picker", () => {
  test("Save the full project writes a project that opens, and opens it", async ({ page }) => {
    await serveFolder(page, {});
    await start(page);
    await edit(page);
    await page.keyboard.press("Control+s");
    const dialog = page.getByTestId("save-choice");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("The example is read only.");
    await expect(page.getByTestId("save-choice-project")).toHaveText("Save project…");
    await page.getByTestId("save-choice-project").click();

    await expect(page.getByTestId("status")).toContainText("Saved the project to robot-repo and opened it.");
    await expect(dialog).toHaveCount(0);
    for (const path of PROJECT_FILES) {
      if (path === "autos/collect-and-score.auto.json") continue;
      expect(await readServed(page, path), path).toBe(savedAs(path));
    }
    const saved = await readServed(page, "autos/collect-and-score.auto.json");
    expect(saved).toBe(await savedCanonical(page));
    expect((JSON.parse(saved) as { steps: Array<{ id: string; segments?: Array<{ to: { yIn: number } }> }> }).steps[0]?.segments?.[0]?.to.yIn).toBe(-30);

    // The folder is now the open project, on the auto that was saved, and Save writes in place.
    await expect(page.getByTestId("toolbar-auto-name")).toContainText("collect-and-score.auto.json");
    await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toHaveCount(0);
    expect(await page.evaluate(`import("/src/state/store.ts").then((m) => m.getState().project.source.kind)`)).toBe("directory");
    await edit(page, -28);
    await page.keyboard.press("Control+s");
    await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toHaveCount(0);
    await expect(page.getByTestId("save-choice")).toHaveCount(0);
    expect(await readServed(page, "autos/collect-and-score.auto.json")).toBe(await savedCanonical(page));
  });

  test("Save the full project never writes over a project, and says what to do", async ({ page }) => {
    await serveFolder(page, starterFiles());
    await start(page);
    await page.keyboard.press("Control+s");
    await page.getByTestId("save-choice-project").click();
    await expect(page.getByTestId("status")).toContainText(
      "robot-repo already has a zenith.json, so nothing was written. Pick an empty folder, or use Save just this auto",
    );
    expect(await readServed(page, "zenith.json")).toBe(read("zenith.json"));
  });

  test("Save just this auto writes into the project's autos folder and opens that project", async ({ page }) => {
    await serveFolder(page, starterFiles());
    await start(page);
    await edit(page);
    await page.keyboard.press("Control+s");
    await page.getByTestId("save-choice-auto").click();

    await expect(page.getByTestId("status")).toContainText(
      "Saved robot-repo/autos/collect-and-score.auto.json and opened robot-repo.",
    );
    expect(await readServed(page, "autos/collect-and-score.auto.json")).toBe(await savedCanonical(page));
    await expect(page.getByTestId("toolbar-auto-name")).toContainText("collect-and-score.auto.json");
    await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toHaveCount(0);
  });

  test("Save just this auto refuses a folder that is not a project, and an auto already there", async ({ page }) => {
    await serveFolder(page, { "notes.txt": "not a project" });
    await start(page);
    await page.keyboard.press("Control+s");
    await page.getByTestId("save-choice-auto").click();
    await expect(page.getByTestId("status")).toContainText("robot-repo has no zenith.json, so it is not a project.");

    await serveFolder(page, { ...starterFiles(), "autos/collect-and-score.auto.json": "mine" });
    await page.reload();
    await page.getByTestId("canvas-load-example").click();
    await page.keyboard.press("Control+s");
    await page.getByTestId("save-choice-auto").click();
    await expect(page.getByTestId("status")).toContainText(
      "robot-repo already has autos/collect-and-score.auto.json, so nothing was written.",
    );
    expect(await readServed(page, "autos/collect-and-score.auto.json")).toBe("mine");
  });

  test("Save from the question before another auto opens writes the full project, opens it, and opens that auto from it", async ({ page }) => {
    await serveFolder(page, {});
    await start(page);
    // Duplicate a step, so the auto has an edit to look for once it is reopened.
    await page.getByTestId("step-row-waitForFull").click();
    await runAction(page, "Duplicate", "edit.duplicate");
    const copyId = (await page.evaluate(`import("/src/state/store.ts").then((m) => m.getState().selection.stepId)`)) as string;
    expect(copyId).not.toBe("waitForFull");
    await expect(page.getByTestId(`step-row-${copyId}`)).toBeVisible();

    await openAuto(page, "first-auto.auto.json");
    await page.getByTestId("unsaved-save").click();
    await expect(page.getByTestId("save-choice-project-row")).toContainText("A new folder with a copy of everything.");
    await expect(page.getByTestId("save-choice-project-row")).not.toContainText("Open it later");
    await page.getByTestId("save-choice-project").click();

    await expect(page.getByTestId("toolbar-auto-name")).toContainText("first-auto.auto.json");
    expect(await page.evaluate(`import("/src/state/store.ts").then((m) => m.getState().project.source.kind)`)).toBe("directory");
    expect(await page.evaluate(`import("/src/state/store.ts").then((m) => m.getState().project.name)`)).toBe("robot-repo");
    expect(await readServed(page, "autos/first-auto.auto.json")).toBe(read("autos/first-auto.auto.json"));
    expect(await readServed(page, "autos/collect-and-score.auto.json")).toContain(`"id": "${copyId}"`);

    // Reopening collect-and-score, now from the new folder, shows the duplicated step.
    await openAuto(page, "collect-and-score.auto.json");
    await expect(page.getByTestId("toolbar-auto-name")).toContainText("collect-and-score.auto.json");
    await expect(page.getByTestId(`step-row-${copyId}`)).toBeVisible();
    await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toHaveCount(0);
  });

  test("Just this auto lists the waypoints the project lacks or has elsewhere before writing, and own poses leave no SCHEMA finding", async ({ page }) => {
    await serveFolder(page, starterFiles({ "autos/waypoints.json": () => TEAM_WAYPOINTS }));
    await start(page);
    await page.keyboard.press("Control+s");
    // One line per choice: how many waypoints the auto follows is for the next step, which opens
    // only when the project picked does not match them (issue #414).
    await expect(page.getByTestId("save-choice-auto-detail")).toHaveText("Add it to a project you already have.");
    await expect(page.getByTestId("save-choice")).not.toContainText("waypoints");
    await page.getByTestId("save-choice-auto").click();

    const check = page.getByTestId("waypoint-check");
    await expect(check).toBeVisible();
    await expect(check).toContainText("collect-and-score.auto.json follows 7 waypoints");
    for (const name of MISSING) {
      await expect(page.getByTestId(`waypoint-check-row-${name}`)).toContainText("Not in robot-repo");
    }
    const startRow = page.getByTestId("waypoint-check-row-start");
    await expect(startRow).toContainText("x -13.00 in, y -63.00 in, 90.0°");
    await expect(startRow).toContainText("x 36.00 in, y -63.00 in, 90.0°");
    await expect(page.getByTestId("waypoint-check-row-scoreSouth")).toHaveCount(0);
    await expect(page.getByTestId("waypoint-check-add-row")).toContainText("Add the missing waypoints to robot-repo/autos/waypoints.json");
    await expect(page.getByTestId("waypoint-check-follow-row")).toContainText("Follow robot-repo's own");
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}waypoint-check-night.png` });
    // Nothing is written before an answer, and Cancel writes nothing.
    await expect(readServed(page, "autos/collect-and-score.auto.json")).rejects.toThrow();
    await page.getByTestId("waypoint-check-cancel").click();
    await expect(check).toHaveCount(0);
    await expect(page.getByTestId("status")).toContainText("Nothing was written to robot-repo.");
    await expect(readServed(page, "autos/collect-and-score.auto.json")).rejects.toThrow();

    await page.keyboard.press("Control+s");
    await page.getByTestId("save-choice-auto").click();
    await page.getByTestId("waypoint-check-own").click();
    await expect(page.getByTestId("status")).toContainText("Saved robot-repo/autos/collect-and-score.auto.json and opened robot-repo.");
    const saved = await readServed(page, "autos/collect-and-score.auto.json");
    expect([...saved.matchAll(/"ref": "([^"]+)"/g)].map((match) => match[1])).toEqual(["scoreSouth"]);
    expect(await readServed(page, "autos/waypoints.json")).toBe(TEAM_WAYPOINTS);
    expect(
      await page.evaluate(`import("/src/state/store.ts").then((m) => m.currentDerived().findings.filter((f) => f.code === "SCHEMA").length)`),
    ).toBe(0);
    await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toHaveCount(0);
  });

  test("Cancel saves nothing and keeps the edits", async ({ page }) => {
    await start(page);
    await edit(page);
    await page.keyboard.press("Control+s");
    await page.getByTestId("save-choice-cancel").click();
    await expect(page.getByTestId("save-choice")).toHaveCount(0);
    await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toBeVisible();
  });
});

test.describe("without a folder picker", () => {
  test("Save the full project downloads a zip that Open files opens", async ({ page }) => {
    await start(page);
    await withoutFolderPicker(page);
    await edit(page);
    await page.keyboard.press("Control+s");
    await expect(page.getByTestId("save-choice-project")).toHaveText("Download project");
    const downloading = page.waitForEvent("download");
    await page.getByTestId("save-choice-project").click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("zenith-starter.zip");
    await expect(page.getByTestId("status")).toContainText("Downloaded zenith-starter.zip. Unzip it, then open the folder with Open project.");
    await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toHaveCount(0);

    const bytes = readFileSync(await download.path());
    const files = await unzipText(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect([...files.keys()]).toEqual(PROJECT_FILES);
    for (const path of PROJECT_FILES) {
      if (path !== "autos/collect-and-score.auto.json") expect(files.get(path), path).toBe(savedAs(path));
    }
    expect(files.get("autos/collect-and-score.auto.json")).toBe(await savedCanonical(page));

    // The zip opens again with Open files, every auto in it.
    mkdirSync(SHOTS, { recursive: true });
    const zip = `${SHOTS}zenith-starter.zip`;
    writeFileSync(zip, bytes);
    await withoutFolderPicker(page);
    await page.getByTestId("toolbar-auto-name").click();
    await page.getByTestId("open-project-other").click();
    await page.getByTestId("open-project-files").setInputFiles(zip);
    await expect(page.getByTestId("status")).toContainText("Opened from files.");
    await expect(page.getByTestId("toolbar-auto-name")).toContainText("all-step-kinds.auto.json");
  });

  test("Save the full project of files opened on their own keeps their own zenith.json (issue #159)", async ({ page }) => {
    await start(page);
    await withoutFolderPicker(page);
    // A team's own project, opened one file at a time as getting-started.md says to in Firefox or
    // Safari: its zenith.json names its own robot class, command library and sim command.
    const link = JSON.parse(read("zenith.json")) as Record<string, unknown>;
    link["deploy"] = {
      ...(link["deploy"] as Record<string, unknown>),
      commandLibrary: "ivy",
      robotClass: "org.firstinspires.ftc.teamcode.OurRobot",
    };
    link["sim"] = {
      command: './gradlew :TeamCode:testDebugUnitTest --tests "*OurSimTest*" -Dzenith.auto={auto}',
      trace: "TeamCode/build/sim/{auto}.trace.json",
    };
    const teamLink = canonicalize("link", loadLink(link));
    const picked: Record<string, string> = {
      "zenith.json": teamLink,
      "robot.json": read("autos/robot.json"),
      "biobuzz.field.json": read("autos/field/biobuzz.field.json"),
      "waypoints.json": read("autos/waypoints.json"),
      "first-auto.auto.json": read("autos/first-auto.auto.json"),
    };
    await withoutFolderPicker(page);
    await page.getByTestId("toolbar-auto-name").click();
    await page.getByTestId("open-project-other").click();
    await page
      .getByTestId("open-project-files")
      .setInputFiles(Object.entries(picked).map(([name, text]) => ({ name, mimeType: "application/json", buffer: Buffer.from(text) })));
    await expect(page.getByTestId("status")).toContainText("Opened from files.");

    // A changed waypoint saves only with the full project, so this is the save the team makes.
    await page.evaluate(`import("/src/app/waypointEdits.ts").then((m) => m.moveWaypoint("start", { xIn: -36 }, "drag"))`);
    await page.keyboard.press("Control+s");
    await expect(page.getByTestId("save-choice-project-detail")).toHaveText("A .zip with a copy of everything. Unzip it, then open the folder.");
    const downloading = page.waitForEvent("download");
    await page.getByTestId("save-choice-project").click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("zenith-picked-files.zip");

    const bytes = readFileSync(await download.path());
    const files = await unzipText(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(files.get("zenith.json")).toBe(teamLink);
    expect(files.get("autos/waypoints.json")).toContain('"xIn": -36');
  });

  test("Save just this auto downloads the auto and says where it belongs", async ({ page }) => {
    await start(page);
    await withoutFolderPicker(page);
    await page.keyboard.press("Control+s");
    await expect(page.getByTestId("save-choice-auto-row")).toContainText(
      "Downloads collect-and-score.auto.json, for the autos folder of your project.",
    );
    const downloading = page.waitForEvent("download");
    await page.getByTestId("save-choice-auto").click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("collect-and-score.auto.json");
    expect(readFileSync(await download.path(), "utf8")).toBe(
      canonicalize("auto", loadAuto(JSON.parse(read("autos/collect-and-score.auto.json")))),
    );
    await expect(page.getByTestId("status")).toContainText(
      "Downloaded collect-and-score.auto.json. It belongs in the autos folder of your project.",
    );
  });
});

test("a lone auto says which files it needs and opens on the example robot and field", async ({ page }) => {
  await start(page);
  await withoutFolderPicker(page);
  await page.getByTestId("toolbar-auto-name").click();
  await page.getByTestId("open-project-other").click();
  await page.getByTestId("open-project-files").setInputFiles(`${STARTER}autos/first-auto.auto.json`);
  const dialog = page.getByTestId("lone-auto");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("lone-auto-message")).toHaveText(
    "first-auto.auto.json is only an auto. To open it, Zenith also needs the project it belongs to: zenith.json, robot.json and the season's field file (*.field.json).",
  );
  await expect(dialog).toContainText("Open the project folder it belongs to, or open it with the example robot and field.");
  await page.getByTestId("lone-auto-example").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("first-auto.auto.json");
  await expect(page.getByTestId("status")).toContainText(
    "Opened first-auto.auto.json on the example robot and field, read only. Its own project's robot and field may differ.",
  );
  // It is read only, so Save asks, as the example does.
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("save-choice")).toContainText("These files were opened read only.");
});

for (const theme of ["dark", "light"] as const) {
  const name = theme === "dark" ? "night" : "day";
  test(`the save question and the lone-auto message, in ${name}`, async ({ page }) => {
    await start(page, theme);
    await page.keyboard.press("Control+s");
    await expect(page.getByTestId("save-choice")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}save-choice-${name}.png` });
    await page.getByTestId("save-choice-cancel").click();

    await withoutFolderPicker(page);
    await page.getByTestId("toolbar-auto-name").click();
    await page.getByTestId("open-project-other").click();
    await page.getByTestId("open-project-files").setInputFiles(`${STARTER}autos/first-auto.auto.json`);
    // With no folder picker, which the single files need, there is no Open folder button to offer.
    await expect(page.getByTestId("lone-auto-example")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}lone-auto-${name}.png` });
    await page.getByTestId("lone-auto-cancel").click();

    await withoutFolderPicker(page);
    await page.keyboard.press("Control+s");
    await expect(page.getByTestId("save-choice-project")).toHaveText("Download project");
    await page.screenshot({ path: `${SHOTS}save-choice-download-${name}.png` });
  });
}
