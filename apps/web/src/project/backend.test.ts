/**
 * The local backend reads what the shell asks for and refuses what it cannot do, so that the shell
 * itself never has to know which of the three local sources it is talking to. The writing paths
 * (a folder handle, a download) belong to the browser and are covered by the Playwright smoke.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize, loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { LocalBackend } from "./backend";
import type { Project } from "./types";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/starter/${path}`, import.meta.url)), "utf8");

/** The bundled example, assembled the way `example.ts` assembles it from Vite's `?raw` imports. */
function exampleProject(): Project {
  const collectText = read("autos/collect-and-score.auto.json");
  const firstText = read("autos/first-auto.auto.json");
  return {
    source: { kind: "files" },
    name: "examples/starter",
    link: loadLink(JSON.parse(read("zenith.json"))),
    robot: loadRobot(JSON.parse(read("autos/robot.json"))),
    field: loadField(JSON.parse(read("autos/field/biobuzz.field.json"))),
    waypoints: loadWaypoints(JSON.parse(read("autos/waypoints.json"))),
    autoFiles: ["collect-and-score.auto.json", "first-auto.auto.json"],
    autoTexts: { "collect-and-score.auto.json": collectText, "first-auto.auto.json": firstText },
  };
}

describe("LocalBackend", () => {
  it("opens a project and lists the autos beside it", async () => {
    const backend = LocalBackend.of(exampleProject());
    const project = await backend.open();

    expect(backend.kind).toBe("local");
    expect(project.link.autosDir).toBe("autos");
    expect(await backend.listAutos()).toEqual(["collect-and-score.auto.json", "first-auto.auto.json"]);
  });

  it("reads an auto as the canonical text the editor compares against", async () => {
    const backend = LocalBackend.of(exampleProject());
    await backend.open();

    const loaded = await backend.readAuto("first-auto.auto.json");
    expect(loaded.fileName).toBe("first-auto.auto.json");
    expect(loaded.auto.name).toBe("first-auto");
    expect(loaded.canonical).toBe(canonicalize("auto", loaded.auto));
  });

  it("cannot propose, which is GitHub mode's alone", () => {
    expect(LocalBackend.of(exampleProject()).canPropose).toBe(false);
  });

  it("refuses to read before it has been opened, rather than returning half a project", async () => {
    const backend = LocalBackend.of(exampleProject());
    await expect(backend.listAutos()).rejects.toThrow(/not been opened/);
  });

  it("says which auto it does not have rather than failing on undefined", async () => {
    const backend = LocalBackend.of(exampleProject());
    await backend.open();
    await expect(backend.readAuto("nope.auto.json")).rejects.toThrow(/nope\.auto\.json/);
  });

  it("refuses an arbitrary path when the source is picked files, which have no folder", async () => {
    const backend = LocalBackend.of(exampleProject());
    await backend.open();
    await expect(backend.readText("autos/robot.json")).rejects.toThrow(/only has the files/);
  });
});
