/**
 * The desktop backend's first-save collision check (issue #380 finding 3): an auto is "not there"
 * only when the autos folder's listing lacks it. A failure to look is thrown, so Save never writes
 * over a file it could not see.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DesktopBackend } from "./desktop";
import type { ZenithDesktopBridge } from "./desktopBridge";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/starter/${path}`, import.meta.url)), "utf8");

const files: Record<string, string> = {
  "zenith.json": read("zenith.json"),
  "autos/robot.json": read("autos/robot.json"),
  "autos/field/biobuzz.field.json": read("autos/field/biobuzz.field.json"),
  "autos/waypoints.json": read("autos/waypoints.json"),
};

/** A bridge over the starter's files, whose auto listing is `list` and whose auto reads always fail. */
function bridgeOf(list: () => Promise<string[]>): ZenithDesktopBridge {
  return {
    project: {
      read: (_root: string, path: string) =>
        files[path] === undefined ? Promise.reject(new Error(`Could not read ${path} in this folder.`)) : Promise.resolve(files[path]),
      listAutos: list,
      watch: () => Promise.resolve(),
    },
  } as unknown as ZenithDesktopBridge;
}

const ref = { root: "C:/repo", name: "repo" };

describe("DesktopBackend.hasAuto", () => {
  it("asks the desktop app's own check when it has one, and passes on its failure", async () => {
    const asked: string[] = [];
    const bridge = bridgeOf(() => Promise.reject(new Error("listAutos must not be used")));
    (bridge.project as { listAutos: unknown }).listAutos = () => Promise.resolve([]);
    bridge.project.hasAuto = (_root, fileName) => {
      asked.push(fileName);
      return fileName === "broken.auto.json" ? Promise.reject(new Error("Could not list the autos folder autos.")) : Promise.resolve(true);
    };
    const backend = new DesktopBackend(bridge, ref);
    await backend.open();
    (bridge.project as { listAutos: unknown }).listAutos = () => Promise.reject(new Error("listAutos must not be used"));
    expect(await backend.hasAuto("first.auto.json")).toBe(true);
    await expect(backend.hasAuto("broken.auto.json")).rejects.toThrow(/Could not list the autos folder/);
    expect(asked).toEqual(["first.auto.json", "broken.auto.json"]);
  });

  it("ignores case on an older desktop app without its own check, as Windows and macOS disks do", async () => {
    const backend = new DesktopBackend(bridgeOf(() => Promise.resolve(["First-Auto.auto.json"])), ref);
    await backend.open();
    expect(await backend.hasAuto("first-auto.auto.json")).toBe(true);
  });

  it("is true for an auto in the listing even when it cannot be read, and false for one not listed", async () => {
    const backend = new DesktopBackend(bridgeOf(() => Promise.resolve(["first-auto.auto.json"])), ref);
    await backend.open();
    expect(await backend.hasAuto("first-auto.auto.json")).toBe(true);
    expect(await backend.hasAuto("new.auto.json")).toBe(false);
  });

  it("throws, rather than saying not there, when the autos folder cannot be listed", async () => {
    let calls = 0;
    const backend = new DesktopBackend(
      bridgeOf(() => (calls++ === 0 ? Promise.resolve([]) : Promise.reject(new Error("Permission denied.")))),
      ref,
    );
    await backend.open();
    await expect(backend.hasAuto("first-auto.auto.json")).rejects.toThrow(/Could not tell whether autos\/first-auto\.auto\.json is in this folder: Permission denied/);
  });
});
