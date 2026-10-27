/**
 * Saving the read-only example as a download, for the tests that read the saved auto back. Save on
 * the example asks whether to save the full project or just this auto (issue #103); in Chromium
 * both write into a picked folder, so these helpers take the folder picker away first, and Save
 * just this auto then downloads the canonical file, as it does in Firefox and Safari.
 */
import { expect, type Download, type Page } from "@playwright/test";

/** Makes this page behave like a browser without the File System Access API, from now on. */
export async function withoutFolderPicker(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(window, "showDirectoryPicker", { value: undefined, configurable: true });
  });
}

/** The same, for a page that has not loaded yet: it holds for every page this one loads. */
export async function withoutFolderPickerFromTheStart(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "showDirectoryPicker", { value: undefined, configurable: true });
  });
}

/** Answers an open save question with Save just this auto, which downloads, and resolves with the download. */
export async function chooseJustThisAuto(page: Page, download: Promise<Download>): Promise<Download> {
  await expect(page.getByTestId("save-choice")).toBeVisible();
  await page.getByTestId("save-choice-auto").click();
  return download;
}

/** Ctrl S on the read-only example, answered with Save just this auto: the canonical auto, downloaded. */
export async function saveExampleAuto(page: Page): Promise<Download> {
  await withoutFolderPicker(page);
  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return chooseJustThisAuto(page, download);
}
