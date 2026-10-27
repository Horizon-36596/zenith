/**
 * A writable robot repository for e2e tests, without a real folder picker: the starter project is
 * copied into the browser's origin-private file system, and `window.showDirectoryPicker` hands back
 * that folder, so Open folder takes the same File System Access path a person's folder does and Save
 * (or Settings) writes real files the test can read back.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

const STARTER = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));

/** The starter's files a project needs, by their path in the repository. */
const FILES = [
  "zenith.json",
  "autos/robot.json",
  "autos/waypoints.json",
  "autos/field/biobuzz.field.json",
  "autos/first-auto.auto.json",
];

/** The starter's files, with `edit` applied to any of them by path. */
export function starterFiles(edit: Record<string, (text: string) => string> = {}): Record<string, string> {
  return Object.fromEntries(
    FILES.map((path) => {
      const text = readFileSync(`${STARTER}${path}`, "utf8").replace(/\r\n/g, "\n");
      return [path, edit[path]?.(text) ?? text];
    }),
  );
}

/** Makes the next folder pick on `page` return a fresh `robot-repo` folder holding `files`. */
export async function serveFolder(page: Page, files: Record<string, string>): Promise<void> {
  await page.addInitScript((given: Record<string, string>) => {
    const picker = async (): Promise<FileSystemDirectoryHandle> => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry("robot-repo", { recursive: true }).catch(() => undefined);
      const repo = await root.getDirectoryHandle("robot-repo", { create: true });
      for (const [path, text] of Object.entries(given)) {
        const parts = path.split("/");
        const name = parts.pop() as string;
        let dir = repo;
        for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await writable.write(text);
        await writable.close();
      }
      return repo;
    };
    Object.defineProperty(window, "showDirectoryPicker", { value: picker, configurable: true });
  }, files);
}

/**
 * Reads one file of the served folder back, as the app last wrote it. A save closes its writable by
 * swapping a new file into place, and a read in that moment finds no file, so a missing file is
 * tried again for up to a second before the error stands. `expect.poll` does not retry a callback
 * that throws, so this is where the wait has to be.
 */
export async function readServed(page: Page, path: string): Promise<string> {
  return page.evaluate(async (wanted) => {
    const read = async (): Promise<string> => {
      let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("robot-repo");
      const parts = wanted.split("/");
      const name = parts.pop() as string;
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
      return (await (await dir.getFileHandle(name)).getFile()).text();
    };
    for (let tries = 0; ; tries += 1) {
      try {
        return await read();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "NotFoundError") || tries >= 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }, path);
}

/** Opens the served folder through the palette's Open folder action. */
export async function openServedFolder(page: Page): Promise<void> {
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Open a folder");
  await page.keyboard.press("Enter");
}
