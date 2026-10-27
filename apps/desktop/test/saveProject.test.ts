/**
 * Saving the read-only example in the desktop app (issue #103). The folder comes from the picker,
 * never the renderer; the full project's zenith.json is the bundled example's, whatever the
 * renderer sends; every file it does send must load; and nothing is ever written over a file that
 * is already there.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, loadLink, loadWaypoints } from "@horizon36596/zenith-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_LIMIT, fullProjectFiles, pickAutoTarget, saveAutoInto, saveFullProject, writeAutoInto } from "../src/main/saveProject.js";

const STARTER = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const read = (path: string): string => readFileSync(join(STARTER, path), "utf8").replace(/\r\n/g, "\n");

/**
 * The zenith.json Save the full project writes: the example's, without its sim command, robot class
 * and command library, which name a robot repository the new folder is not (issue #159).
 */
const newProjectLinkText = (): string => {
  const link = JSON.parse(read("zenith.json")) as Record<string, unknown>;
  delete link["sim"];
  const deploy = { ...(link["deploy"] as Record<string, unknown>) };
  delete deploy["robotClass"];
  delete deploy["commandLibrary"];
  return canonicalize("link", loadLink({ ...link, deploy }));
};

const payload = () => ({
  robot: read("autos/robot.json"),
  field: read("autos/field/biobuzz.field.json"),
  waypoints: read("autos/waypoints.json"),
  autos: [
    { fileName: "first-auto.auto.json", text: read("autos/first-auto.auto.json") },
    { fileName: "collect-and-score.auto.json", text: read("autos/collect-and-score.auto.json") },
  ],
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zenith-save-project-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const picks = (folder: string | null) => ({ pick: vi.fn(async () => folder) });

describe("Save the full project", () => {
  it("writes the example's files, canonical, into the folder picked", async () => {
    const root = join(dir, "new-robot");
    mkdirSync(root);
    expect(await saveFullProject(picks(root), payload())).toBe(root);
    expect(readFileSync(join(root, "zenith.json"), "utf8")).toBe(newProjectLinkText());
    for (const path of [
      "autos/robot.json",
      "autos/field/biobuzz.field.json",
      "autos/waypoints.json",
      "autos/first-auto.auto.json",
      "autos/collect-and-score.auto.json",
    ]) {
      expect(readFileSync(join(root, path), "utf8"), path).toBe(read(path));
    }
  });

  it("writes the bundled zenith.json, never one the renderer sends", () => {
    const sneaky = {
      ...payload(),
      link: '{"sim":{"command":"calc.exe"}}',
      "zenith.json": '{"sim":{"command":"calc.exe"}}',
    };
    const files = fullProjectFiles(sneaky);
    expect(files.map((file) => file.path)).not.toContain("link");
    const link = files.find((file) => file.path === "zenith.json")?.text ?? "";
    expect(link).toBe(newProjectLinkText());
    expect(link).not.toContain("calc.exe");
  });

  it("names the field file after the field's season, and drops waypoints when there are none", () => {
    const field = JSON.parse(read("autos/field/biobuzz.field.json")) as Record<string, unknown>;
    const files = fullProjectFiles({ ...payload(), field: JSON.stringify({ ...field, season: "into-the-deep" }), waypoints: null });
    const link = JSON.parse(files[0]?.text ?? "{}") as Record<string, unknown>;
    expect(link["field"]).toBe("autos/field/into-the-deep.field.json");
    expect(link["waypoints"]).toBeUndefined();
    expect(files.map((file) => file.path)).toContain("autos/field/into-the-deep.field.json");
    expect(files.map((file) => file.path)).not.toContain("autos/waypoints.json");
  });

  it("refuses a season that cannot name a file, before asking for a folder", async () => {
    const field = JSON.parse(read("autos/field/biobuzz.field.json")) as Record<string, unknown>;
    const deps = picks(dir);
    await expect(saveFullProject(deps, { ...payload(), field: JSON.stringify({ ...field, season: "../../x" }) })).rejects.toThrow(
      /cannot name a file/,
    );
    expect(deps.pick).not.toHaveBeenCalled();
  });

  it("refuses files that do not load, naming them, before asking for a folder", async () => {
    const deps = picks(dir);
    await expect(saveFullProject(deps, { ...payload(), robot: "{" })).rejects.toThrow(/robot\.json does not load/);
    await expect(saveFullProject(deps, { ...payload(), field: 42 })).rejects.toThrow(/field file is not text/);
    await expect(
      saveFullProject(deps, { ...payload(), autos: [{ fileName: "broken.auto.json", text: "{}" }] }),
    ).rejects.toThrow(/broken\.auto\.json does not load/);
    expect(deps.pick).not.toHaveBeenCalled();
  });

  it("refuses what is not a project, auto names that leave the folder, duplicates and too many autos", () => {
    expect(() => fullProjectFiles(null)).toThrow(/not a project/);
    expect(() => fullProjectFiles({ ...payload(), autos: "x" })).toThrow(/not a project/);
    expect(() => fullProjectFiles({ ...payload(), autos: [{ fileName: "../../evil.auto.json", text: "{}" }] })).toThrow(
      /not an auto file name/,
    );
    expect(() => fullProjectFiles({ ...payload(), autos: [{ fileName: "C:\\x.auto.json", text: "{}" }] })).toThrow(
      /not an auto file name/,
    );
    const one = payload().autos[0] as { fileName: string; text: string };
    expect(() => fullProjectFiles({ ...payload(), autos: [one, one] })).toThrow(/twice/);
    expect(() =>
      fullProjectFiles({ ...payload(), autos: Array.from({ length: AUTO_LIMIT + 1 }, (_, n) => ({ fileName: `a${String(n)}.auto.json`, text: "{}" })) }),
    ).toThrow(/too many autos/);
  });

  it("never writes over a project: a folder with zenith.json is left as it was", async () => {
    writeFileSync(join(dir, "zenith.json"), "mine");
    await expect(saveFullProject(picks(dir), payload())).rejects.toThrow(/already has a zenith\.json, so nothing was written/);
    expect(readFileSync(join(dir, "zenith.json"), "utf8")).toBe("mine");
    expect(readdirSync(dir)).toEqual(["zenith.json"]);
  });

  it("never writes over any of its files, and writes none of them when one is there", async () => {
    mkdirSync(join(dir, "autos"));
    writeFileSync(join(dir, "autos", "first-auto.auto.json"), "mine");
    await expect(saveFullProject(picks(dir), payload())).rejects.toThrow(/is not empty, so nothing was written/);
    expect(existsSync(join(dir, "zenith.json"))).toBe(false);
    expect(readFileSync(join(dir, "autos", "first-auto.auto.json"), "utf8")).toBe("mine");
  });

  it("drops the example's sim command, robot class and command library (issue #159)", () => {
    const link = loadLink(JSON.parse(fullProjectFiles(payload())[0]?.text ?? "{}"));
    expect(link.sim).toBeUndefined();
    expect(link.deploy?.robotClass).toBeUndefined();
    expect(link.deploy?.commandLibrary).toBeUndefined();
    expect(link.codegen).toBeDefined();
  });

  it("never writes into a robot repository, and says Open project sets Zenith up there (issue #159)", async () => {
    mkdirSync(join(dir, "TeamCode"));
    writeFileSync(join(dir, "build.gradle"), "// FTC SDK\n");
    await expect(saveFullProject(picks(dir), payload())).rejects.toThrow(
      /is a robot repository, so nothing was written: Save the full project needs a new, empty folder\. To use Zenith in .*, open it with Open project, and Zenith offers to set it up there\./,
    );
    expect(readdirSync(dir).sort()).toEqual(["TeamCode", "build.gradle"]);
  });

  it("writes into a folder that holds only hidden entries, such as a fresh clone's (issue #159)", async () => {
    mkdirSync(join(dir, ".git"));
    expect(await saveFullProject(picks(dir), payload())).toBe(dir);
    expect(readFileSync(join(dir, "zenith.json"), "utf8")).toBe(newProjectLinkText());
  });

  it("writes nothing when the picker is cancelled", async () => {
    expect(await saveFullProject(picks(null), payload())).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("Save just this auto", () => {
  const project = (): string => {
    const root = join(dir, "robot-repo");
    mkdirSync(join(root, "autos", "field"), { recursive: true });
    for (const path of ["zenith.json", "autos/robot.json", "autos/field/biobuzz.field.json", "autos/waypoints.json"]) {
      writeFileSync(join(root, path), read(path));
    }
    return root;
  };

  it("writes the auto, canonical, into the autos folder zenith.json names", async () => {
    const root = project();
    const text = JSON.stringify(JSON.parse(read("autos/first-auto.auto.json")));
    expect(await saveAutoInto(picks(root), "first-auto.auto.json", text)).toEqual({ root, path: "autos/first-auto.auto.json" });
    expect(readFileSync(join(root, "autos", "first-auto.auto.json"), "utf8")).toBe(read("autos/first-auto.auto.json"));
  });

  it("refuses a folder without zenith.json", async () => {
    await expect(saveAutoInto(picks(dir), "first-auto.auto.json", read("autos/first-auto.auto.json"))).rejects.toThrow(
      /has no zenith\.json/,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("never writes over an auto already there", async () => {
    const root = project();
    writeFileSync(join(root, "autos", "first-auto.auto.json"), "mine");
    await expect(saveAutoInto(picks(root), "first-auto.auto.json", read("autos/first-auto.auto.json"))).rejects.toThrow(
      /already has autos\/first-auto\.auto\.json, so nothing was written/,
    );
    expect(readFileSync(join(root, "autos", "first-auto.auto.json"), "utf8")).toBe("mine");
  });

  it("refuses a name that leaves the autos folder, and text that is not an auto, before asking for a folder", async () => {
    const deps = picks(project());
    await expect(saveAutoInto(deps, "../zenith.json", "{}")).rejects.toThrow(/not an auto file name/);
    await expect(saveAutoInto(deps, "..\\..\\x.auto.json", "{}")).rejects.toThrow(/not an auto file name/);
    await expect(saveAutoInto(deps, "x.auto.json", 42)).rejects.toThrow(/not text/);
    await expect(saveAutoInto(deps, "x.auto.json", "{}")).rejects.toThrow(/x\.auto\.json does not load/);
    expect(deps.pick).not.toHaveBeenCalled();
  });

  it("writes nothing when the picker is cancelled", async () => {
    const root = project();
    expect(await saveAutoInto(picks(null), "first-auto.auto.json", read("autos/first-auto.auto.json"))).toBeNull();
    expect(existsSync(join(root, "autos", "first-auto.auto.json"))).toBe(false);
  });
});

describe("Save just this auto in two steps (issue #158)", () => {
  /** A team's project whose waypoints.json has only its own start and scoreSouth. */
  const teamWaypoints = (): string => {
    const starter = JSON.parse(read("autos/waypoints.json")) as { waypoints: Record<string, unknown> };
    return canonicalize(
      "waypoints",
      loadWaypoints({
        ...starter,
        waypoints: {
          start: { xIn: 36, yIn: -63, headingRad: 1.5708, provenance: "MEASURED: our start tile" },
          scoreSouth: starter.waypoints["scoreSouth"],
        },
      }),
    );
  };
  const project = (waypoints = teamWaypoints()): string => {
    const root = join(dir, "team-repo");
    mkdirSync(join(root, "autos", "field"), { recursive: true });
    for (const path of ["zenith.json", "autos/robot.json", "autos/field/biobuzz.field.json"]) {
      writeFileSync(join(root, path), read(path));
    }
    writeFileSync(join(root, "autos", "waypoints.json"), waypoints);
    return root;
  };
  const scoreNorth = (): unknown =>
    (JSON.parse(read("autos/waypoints.json")) as { waypoints: Record<string, unknown> }).waypoints["scoreNorth"];

  it("picks the project and says where the auto would go and what its waypoints are, writing nothing", async () => {
    const root = project();
    expect(await pickAutoTarget(picks(root), "collect-and-score.auto.json")).toEqual({
      root,
      path: "autos/collect-and-score.auto.json",
      waypointsPath: "autos/waypoints.json",
      waypoints: teamWaypoints(),
    });
    expect(existsSync(join(root, "autos", "collect-and-score.auto.json"))).toBe(false);
  });

  it("refuses at the pick, as Save just this auto does: no zenith.json, an auto already there, a bad name", async () => {
    await expect(pickAutoTarget(picks(dir), "first-auto.auto.json")).rejects.toThrow(/has no zenith\.json/);
    const root = project();
    writeFileSync(join(root, "autos", "first-auto.auto.json"), "mine");
    await expect(pickAutoTarget(picks(root), "first-auto.auto.json")).rejects.toThrow(/already has autos\/first-auto\.auto\.json/);
    const deps = picks(root);
    await expect(pickAutoTarget(deps, "../zenith.json")).rejects.toThrow(/not an auto file name/);
    expect(deps.pick).not.toHaveBeenCalled();
    expect(await pickAutoTarget(picks(null), "x.auto.json")).toBeNull();
  });

  it("writes the auto, canonical, and adds the missing waypoints after the file's own", () => {
    const root = project();
    const text = JSON.stringify(JSON.parse(read("autos/collect-and-score.auto.json")));
    const noted: string[] = [];
    expect(writeAutoInto(root, "collect-and-score.auto.json", text, { scoreNorth: scoreNorth() }, (rel) => noted.push(rel))).toEqual({
      root,
      path: "autos/collect-and-score.auto.json",
    });
    expect(readFileSync(join(root, "autos", "collect-and-score.auto.json"), "utf8")).toBe(read("autos/collect-and-score.auto.json"));
    const waypoints = loadWaypoints(JSON.parse(readFileSync(join(root, "autos", "waypoints.json"), "utf8")));
    expect(Object.keys(waypoints.waypoints)).toEqual(["start", "scoreSouth", "scoreNorth"]);
    expect(waypoints.waypoints["start"]?.provenance).toBe("MEASURED: our start tile");
    expect(noted).toEqual(["autos/waypoints.json", "autos/collect-and-score.auto.json"]);
  });

  it("never adds a waypoint over a name already there, and then writes nothing at all", () => {
    const root = project();
    const before = readFileSync(join(root, "autos", "waypoints.json"), "utf8");
    expect(() =>
      writeAutoInto(root, "collect-and-score.auto.json", read("autos/collect-and-score.auto.json"), { start: scoreNorth() }),
    ).toThrow(/already has a waypoint named start, so nothing was written/);
    expect(readFileSync(join(root, "autos", "waypoints.json"), "utf8")).toBe(before);
    expect(existsSync(join(root, "autos", "collect-and-score.auto.json"))).toBe(false);
  });

  it("refuses waypoints that do not load, an auto already there, and waypoints for a project that names no file", () => {
    const root = project();
    expect(() =>
      writeAutoInto(root, "collect-and-score.auto.json", read("autos/collect-and-score.auto.json"), { scoreNorth: { xIn: "far" } }),
    ).toThrow(/not valid/);
    expect(existsSync(join(root, "autos", "collect-and-score.auto.json"))).toBe(false);

    writeFileSync(join(root, "autos", "collect-and-score.auto.json"), "mine");
    expect(() => writeAutoInto(root, "collect-and-score.auto.json", read("autos/collect-and-score.auto.json"), null)).toThrow(
      /already has autos\/collect-and-score\.auto\.json, so nothing was written/,
    );
    expect(readFileSync(join(root, "autos", "collect-and-score.auto.json"), "utf8")).toBe("mine");

    const link = JSON.parse(read("zenith.json")) as Record<string, unknown>;
    delete link["waypoints"];
    writeFileSync(join(root, "zenith.json"), JSON.stringify(link));
    expect(() => writeAutoInto(root, "first-auto.auto.json", read("autos/first-auto.auto.json"), { scoreNorth: scoreNorth() })).toThrow(
      /names no waypoints file/,
    );
    expect(existsSync(join(root, "autos", "first-auto.auto.json"))).toBe(false);
  });
});
