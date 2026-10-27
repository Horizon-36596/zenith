/**
 * Issue #157: saving a New auto in a folder project puts it on the project's list of autos, so the
 * next New auto takes a free name and its Save cannot write over the first. Before the fix, three
 * New autos were named new-auto, new-auto-2 and new-auto again, the third Save replaced the first
 * file, and neither saved auto showed in the Ctrl+O list or the palette.
 *
 * A first save is also checked against the folder itself: when a file of that name has appeared on
 * disk since the auto was started, Save refuses, says so, and leaves the file as it is.
 */
import { expect, test, type Page } from "@playwright/test";
import { openServedFolder, readServed, serveFolder, starterFiles } from "./opfsProject";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem(
        "zenith.ui",
        JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }),
      );
    }
  });
  await serveFolder(page, starterFiles());
  await page.goto("/");
  await openServedFolder(page);
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("first-auto.auto.json");
});

/** Runs one palette action by its id. */
async function runAction(page: Page, query: string, id: string): Promise<void> {
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill(query);
  await page.getByTestId(`palette-item-${id}`).click();
}

/** New auto, then Auto details to give it `title`. Resolves with the file name it started as. */
async function newAutoTitled(page: Page, title: string): Promise<string> {
  await runAction(page, "New auto", "project.newAuto");
  await expect(page.getByTestId("status")).toContainText("Started new-auto");
  const fileName = (await page.getByTestId("toolbar-auto-name").textContent()) ?? "";
  await runAction(page, "Auto details", "project.meta");
  await page.getByTestId("meta-title").fill(title);
  await page.getByTestId("auto-meta").getByRole("button", { name: "Done" }).click();
  return fileName;
}

const unsaved = (page: Page) => page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes");

test("three New autos saved in a folder are three files, and every list of autos shows them", async ({ page }) => {
  const titles = ["RedNear", "BlueNear", "RedFar"];
  const names: string[] = [];
  for (const title of titles) {
    const fileName = await newAutoTitled(page, title);
    await page.keyboard.press("Control+s");
    await expect(page.getByTestId("status")).toContainText("Saved.");
    await expect(unsaved(page)).toHaveCount(0);
    names.push(fileName);
  }

  expect(names).toEqual(["new-auto.auto.json", "new-auto-2.auto.json", "new-auto-3.auto.json"]);
  for (const [index, fileName] of names.entries()) {
    const saved = JSON.parse(await readServed(page, `autos/${fileName}`)) as { title?: string };
    expect(saved.title).toBe(titles[index]);
  }

  // Ctrl+O lists them beside the starter's own auto.
  await page.getByTestId("field-canvas").focus();
  await page.keyboard.press("Control+o");
  for (const fileName of ["first-auto.auto.json", ...names]) {
    await expect(page.getByTestId(`open-auto-${fileName}`)).toBeVisible();
  }
  await page.keyboard.press("Escape");

  // So does the palette's Open list.
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Open new-auto");
  for (const fileName of names) {
    await expect(page.getByTestId(`palette-item-auto:${fileName}`)).toBeVisible();
  }
  await page.keyboard.press("Escape");

  // And a saved one opens again with its own title.
  await page.keyboard.press("Control+o");
  await page.getByTestId("open-auto-new-auto.auto.json").click();
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("new-auto.auto.json");
  expect(await page.evaluate(`import("/src/state/store.ts").then((m) => m.getState().auto.title)`)).toBe("RedNear");
});

test("a first save whose file name already exists on disk is refused and the file is unchanged", async ({ page }) => {
  const fileName = await newAutoTitled(page, "Mine");
  expect(fileName).toBe("new-auto.auto.json");

  // Another program writes a file of that name into the autos folder while this auto is unsaved.
  const theirs = '{ "written": "by someone else" }\n';
  await page.evaluate(async (text) => {
    const repo = await (await navigator.storage.getDirectory()).getDirectoryHandle("robot-repo");
    const autos = await repo.getDirectoryHandle("autos");
    const writable = await (await autos.getFileHandle("new-auto.auto.json", { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  }, theirs);

  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("status")).toContainText(
    "robot-repo already has autos/new-auto.auto.json, so nothing was written",
  );
  expect(await readServed(page, "autos/new-auto.auto.json")).toBe(theirs);
  // The auto is still unsaved, with its edits, and the file that was there is now on the list.
  await expect(unsaved(page)).toHaveCount(1);
  expect(await page.evaluate(`import("/src/state/store.ts").then((m) => m.getState().auto.title)`)).toBe("Mine");
  await page.getByTestId("field-canvas").focus();
  await page.keyboard.press("Control+o");
  await expect(page.getByTestId("open-auto-new-auto.auto.json")).toBeVisible();
});
