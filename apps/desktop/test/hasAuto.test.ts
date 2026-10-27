/**
 * The first-save collision check (issue #380): whether an auto of a name is already in the autos
 * folder. It ignores case, because Windows and macOS disks do, so a save of `first.auto.json` would
 * replace `First.auto.json`. It reads only `zenith.json` and the folder listing, so a robot or field
 * that does not load cannot refuse it, and only a missing folder counts as "no autos".
 */
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasAutoFile } from "../src/main/project.js";
import { exampleProject, patchLink } from "./support.js";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function project(): string {
  const made = exampleProject();
  cleanup = made.cleanup;
  return made.root;
}

describe("hasAutoFile", () => {
  it("finds an auto that is there and not one that is not", () => {
    const root = project();
    expect(hasAutoFile(root, "first-auto.auto.json")).toBe(true);
    expect(hasAutoFile(root, "new-auto.auto.json")).toBe(false);
  });

  it("ignores case, as the disk does on Windows and macOS", () => {
    const root = project();
    renameSync(join(root, "autos", "first-auto.auto.json"), join(root, "autos", "First-Auto.auto.json"));
    expect(hasAutoFile(root, "first-auto.auto.json")).toBe(true);
  });

  it("answers when the robot and field files do not load", () => {
    const root = project();
    writeFileSync(join(root, "autos", "robot.json"), "{ not json", "utf8");
    rmSync(join(root, "autos", "field"), { recursive: true, force: true });
    expect(hasAutoFile(root, "first-auto.auto.json")).toBe(true);
    expect(hasAutoFile(root, "new-auto.auto.json")).toBe(false);
  });

  it("is false when the autos folder does not exist yet", () => {
    const root = project();
    patchLink(root, (link) => {
      link["autosDir"] = "not-made-yet";
    });
    expect(hasAutoFile(root, "first-auto.auto.json")).toBe(false);
  });

  it("refuses a name that is not a bare auto file name, and an autos folder outside the root", () => {
    const root = project();
    expect(() => hasAutoFile(root, "../zenith.json")).toThrow(/not an auto file name/);
    patchLink(root, (link) => {
      link["autosDir"] = "../elsewhere";
    });
    expect(() => hasAutoFile(root, "first-auto.auto.json")).toThrow();
  });

  it("throws, rather than answering false, when the autos path cannot be listed", () => {
    const root = project();
    // A file where the folder should be: the listing fails with something other than "missing".
    patchLink(root, (link) => {
      link["autosDir"] = "zenith.json";
    });
    expect(() => hasAutoFile(root, "first-auto.auto.json")).toThrow(/Could not list/);
  });
});
