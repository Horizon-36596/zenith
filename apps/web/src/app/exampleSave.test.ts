/**
 * Issue #158: saving the read-only example.
 *
 * N69: the unsaved-edits question's Save on the example, before another auto of the example opens
 * (or a New auto starts), writes the full project into a folder and then opens that folder, so the
 * next auto opens from it and the saved work is what the person sees. A real replacement (another
 * project) leaves the folder closed, and the row says so. Whatever Save wrote, the example's own
 * copy keeps it, so the auto opens again with the saved edits.
 *
 * N71: Just this auto reads the picked project's waypoints first. When it lacks or has elsewhere a
 * waypoint the auto follows, the person is asked, and each answer writes what it says; Cancel
 * writes nothing. A save that leaves errors there says so instead of a green "Saved".
 *
 * Issue #159: Save the full project leaves out the sim command, robot class and command library
 * only when its zenith.json is the example's. Files opened on their own keep the team's own
 * zenith.json as it is.
 *
 * The folder is an in-memory stand-in for the File System Access API's directory handle, handed out
 * by a stubbed `window.showDirectoryPicker`, and the desktop app's bridge is a stand-in over a map
 * of paths, so both run in node.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadLink, loadWaypoints, waypointsUsed } from "@horizon36596/zenith-core";
import type { Auto, Waypoints } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalBackend } from "../project/backend";
import { DESKTOP_API_VERSION, type ZenithDesktopBridge } from "../project/desktopBridge";
import { exampleProjectWith, loadExampleProject } from "../project/example";
import { projectFromFiles } from "../project/fallback";
import { presetSettings } from "../settings/presets";
import { setFeatures } from "../state/features";
import { clearStatus, closeProject, commit, currentDerived, getState, isDirty, setSettings, waypointsDirty } from "../state/store";
import { createAuto } from "./newAuto";
import { loadExample, openAutoNamed, openPickedFiles, save } from "./projectActions";
import { answerSaveChoice, answerWaypointCheck, getSaveChoice, getWaypointCheck, type SaveChoice } from "./saveChoice";
import { fullProjectOf, saveReadOnly } from "./saveReadOnly";
import { answerUnsaved, confirmReplace } from "./unsaved";
import { autoForTarget, checkWaypoints, withAddedWaypoints } from "./waypointCheck";
import { moveWaypoint } from "./waypointEdits";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string): string => readFileSync(`${repo}${path}`, "utf8").replace(/\r\n/g, "\n");
const example = (path: string): string => read(`examples/starter/${path}`);

/** The names collect-and-score follows that the team's waypoints below lack, in the order it follows them. */
const MISSING = ["flowerNorthApproach", "flowerNorthPickup", "scoreNorth", "gardenSweepStart", "gardenSweepEnd"];

/**
 * A team's waypoints.json with only two names: its own measured start, 48 in east of the example's,
 * and scoreSouth where the example has it.
 */
function teamWaypoints(startXIn = 36): string {
  const starter = JSON.parse(example("autos/waypoints.json")) as Waypoints;
  const ours: Waypoints = {
    ...starter,
    waypoints: {
      start: { xIn: startXIn, yIn: -63, headingRad: 1.5708, provenance: "MEASURED: our start tile, tape to wall" },
      scoreSouth: starter.waypoints["scoreSouth"] as Waypoints["waypoints"][string],
    },
  };
  return canonicalize("waypoints", loadWaypoints(ours));
}

/** A robot repository: the starter's zenith.json, robot, field and first-auto, with `waypoints` as its waypoints.json. */
function teamFiles(waypoints = teamWaypoints()): Record<string, string> {
  return {
    "zenith.json": example("zenith.json"),
    "autos/robot.json": example("autos/robot.json"),
    "autos/field/biobuzz.field.json": example("autos/field/biobuzz.field.json"),
    "autos/first-auto.auto.json": example("autos/first-auto.auto.json"),
    "autos/waypoints.json": waypoints,
  };
}

/** Enough of a `FileSystemDirectoryHandle` for `local.ts`: folders, files, and listing a folder. */
class MemoryFolder {
  readonly kind = "directory";
  private readonly files = new Map<string, string>();
  private readonly folders = new Map<string, MemoryFolder>();

  constructor(readonly name: string) {}

  static of(name: string, files: Record<string, string>): MemoryFolder {
    const root = new MemoryFolder(name);
    for (const [path, text] of Object.entries(files)) root.put(path, text);
    return root;
  }

  put(path: string, text: string): void {
    const parts = path.split("/");
    const file = parts.pop() ?? "";
    let folder: MemoryFolder = this;
    for (const part of parts) {
      const next = folder.folders.get(part) ?? new MemoryFolder(part);
      folder.folders.set(part, next);
      folder = next;
    }
    folder.files.set(file, text);
  }

  text(path: string): string | undefined {
    const parts = path.split("/");
    const file = parts.pop() ?? "";
    let folder: MemoryFolder | undefined = this;
    for (const part of parts) folder = folder?.folders.get(part);
    return folder?.files.get(file);
  }

  getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<MemoryFolder> {
    const found = this.folders.get(name);
    if (found !== undefined) return Promise.resolve(found);
    if (options.create !== true) return Promise.reject(new Error(`${name} is not a folder here`));
    const made = new MemoryFolder(name);
    this.folders.set(name, made);
    return Promise.resolve(made);
  }

  getFileHandle(name: string, options: { create?: boolean } = {}): Promise<unknown> {
    if (!this.files.has(name) && options.create !== true) return Promise.reject(new Error(`${name} is not a file here`));
    const files = this.files;
    return Promise.resolve({
      kind: "file",
      getFile: () => Promise.resolve({ text: () => Promise.resolve(files.get(name) ?? "") }),
      createWritable: () => {
        let written = "";
        return Promise.resolve({
          write: (text: string) => {
            written += text;
            return Promise.resolve();
          },
          close: () => {
            files.set(name, written);
            return Promise.resolve();
          },
        });
      },
    });
  }

  async *entries(): AsyncGenerator<[string, { kind: string }]> {
    for (const name of this.files.keys()) yield [name, { kind: "file" }];
    for (const [name, folder] of this.folders) yield [name, folder];
  }
}

/** The folder the next folder pick hands out. */
let picked: MemoryFolder | null = null;

beforeEach(() => {
  answerUnsaved("cancel");
  answerSaveChoice("cancel");
  answerWaypointCheck("cancel");
  // Each test starts with nothing open, so opening the example never asks about the last test's edits.
  closeProject();
  clearStatus();
  picked = null;
  vi.stubGlobal("window", { showDirectoryPicker: () => Promise.resolve(picked) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Waits, a turn at a time, for `get` to have something, and resolves with it. */
async function until<T>(get: () => T | null | undefined): Promise<T> {
  for (let tries = 0; tries < 500; tries += 1) {
    const value = get();
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for the editor.");
}

/** Duplicates collect-and-score's waitForFull step, as Ctrl D does, so the open auto has an edit. */
function duplicateWaitForFull(): void {
  const auto = getState().auto as Auto;
  const index = auto.steps.findIndex((step) => step.id === "waitForFull");
  const copy = { ...(auto.steps[index] as Auto["steps"][number]), id: "waitForFullAgain" };
  commit({ ...auto, steps: [...auto.steps.slice(0, index + 1), copy, ...auto.steps.slice(index + 1)] });
  expect(isDirty()).toBe(true);
}

const stepIds = (): string[] => getState().auto?.steps.map((step) => step.id ?? "") ?? [];

/** Answers the unsaved-edits question with Save, then the save question with `choice`. */
async function saveFromQuestion(choice: SaveChoice): Promise<void> {
  await until(() => getState().unsavedPrompt);
  answerUnsaved("save");
  await until(getSaveChoice);
  answerSaveChoice(choice);
}

describe("Save from the unsaved-edits question on the example (N69)", () => {
  it("before another auto of the example opens, writes the full project, opens it, and opens that auto from it", async () => {
    await loadExample();
    duplicateWaitForFull();
    const folder = new MemoryFolder("ex-repo");
    picked = folder;

    const opening = openAutoNamed("first-auto.auto.json");
    await until(() => getState().unsavedPrompt);
    answerUnsaved("save");
    const question = await until(getSaveChoice);
    expect(question.opensProject).not.toBe(false);
    answerSaveChoice("project");
    await opening;

    expect(getState().project?.source.kind).toBe("directory");
    expect(getState().project?.name).toBe("ex-repo");
    expect(getState().fileName).toBe("first-auto.auto.json");
    expect(folder.text("autos/collect-and-score.auto.json")).toContain("waitForFullAgain");

    // Reopening collect-and-score shows the duplicated step, read from the new folder.
    await openAutoNamed("collect-and-score.auto.json");
    expect(stepIds()).toContain("waitForFullAgain");
    expect(isDirty()).toBe(false);

    // And Save now writes there in place, with no question.
    commit({ ...(getState().auto as Auto), title: "Ours now" });
    await save();
    expect(getSaveChoice()).toBeNull();
    expect(folder.text("autos/collect-and-score.auto.json")).toContain("Ours now");
  });

  it("before a New auto starts, writes the full project, opens it, and starts the New auto in it", async () => {
    await loadExample();
    duplicateWaitForFull();
    picked = new MemoryFolder("ex-repo");

    const creating = createAuto();
    await saveFromQuestion("project");
    await creating;

    expect(getState().project?.source.kind).toBe("directory");
    expect(getState().fileName).toBe("new-auto.auto.json");
    expect(getState().status?.message).toBe("Started new-auto.auto.json. Save writes it into the project.");
    expect(picked.text("autos/collect-and-score.auto.json")).toContain("waitForFullAgain");
  });

  it("before another project replaces it, leaves the folder closed, says to open it later, and keeps what was saved", async () => {
    await loadExample();
    duplicateWaitForFull();
    picked = new MemoryFolder("ex-repo");

    const going = confirmReplace("Opening the example will close it.");
    await until(() => getState().unsavedPrompt);
    answerUnsaved("save");
    const question = await until(getSaveChoice);
    expect(question.opensProject).toBe(false);
    answerSaveChoice("project");
    expect(await going).toBe(true);

    expect(getState().project?.source.kind).toBe("example");
    expect(getState().status?.message).toBe("Saved the project to ex-repo. Open ex-repo later with Open project to keep working in it.");
    // The example's own copy, in the store and in its backend, is what was saved.
    const saved = picked.text("autos/collect-and-score.auto.json");
    expect(getState().project?.autoTexts["collect-and-score.auto.json"]).toBe(saved);
    const backend = getState().backend as LocalBackend;
    expect((await backend.readAuto("collect-and-score.auto.json")).canonical).toBe(saved);
  });

  it("Just this auto before another auto opens writes into the other project, stays on the example, and keeps what was saved", async () => {
    await loadExample();
    duplicateWaitForFull();
    const team = MemoryFolder.of("team-repo", teamFiles(example("autos/waypoints.json")));
    picked = team;

    const opening = openAutoNamed("first-auto.auto.json");
    await saveFromQuestion("auto");
    await opening;

    expect(team.text("autos/collect-and-score.auto.json")).toContain("waitForFullAgain");
    expect(getState().project?.source.kind).toBe("example");
    expect(getState().fileName).toBe("first-auto.auto.json");
    await openAutoNamed("collect-and-score.auto.json");
    expect(stepIds()).toContain("waitForFullAgain");
    expect(isDirty()).toBe(false);
  });
});

describe("Just this auto checks the picked project's waypoints first (N71)", () => {
  /**
   * Ctrl S on the open example, answered with Just this auto, into `folder`. Resolves once the
   * waypoint step shows, with the save still waiting on its answer (wrapped, so awaiting this does
   * not wait for the save).
   */
  async function justThisAuto(folder: MemoryFolder): Promise<{ saving: Promise<void> }> {
    picked = folder;
    const saving = save();
    await until(getSaveChoice);
    answerSaveChoice("auto");
    await until(getWaypointCheck);
    return { saving };
  }

  it("states up front how many waypoints the auto follows", async () => {
    await loadExample();
    const saving = save();
    const question = await until(getSaveChoice);
    expect(question.waypointsFollowed).toBe(7);
    answerSaveChoice("cancel");
    await saving;
  });

  it("lists each name the project lacks or has elsewhere, with both poses, before writing, and Cancel writes nothing", async () => {
    await loadExample();
    const team = MemoryFolder.of("team-repo", teamFiles());
    const { saving } = await justThisAuto(team);

    const check = getWaypointCheck();
    expect(check?.followed).toBe(7);
    expect(check?.rows.map((row) => [row.name, row.match])).toEqual([
      ["start", "differs"],
      ...MISSING.map((name) => [name, "missing"]),
    ]);
    expect(check?.rows[0]).toMatchObject({ here: "x -13.00 in, y -63.00 in, 90.0°", there: "x 36.00 in, y -63.00 in, 90.0°" });
    expect(check?.rows[1]?.there).toBeNull();
    expect(check?.addTo).toBe("team-repo/autos/waypoints.json");
    expect(team.text("autos/collect-and-score.auto.json")).toBeUndefined();

    answerWaypointCheck("cancel");
    await saving;
    expect(team.text("autos/collect-and-score.auto.json")).toBeUndefined();
    expect(team.text("autos/waypoints.json")).toBe(teamWaypoints());
    expect(getState().project?.source.kind).toBe("example");
    expect(getState().status?.message).toBe("Nothing was written to team-repo.");
  });

  it("Give these points their own poses writes an auto with no SCHEMA finding there, and leaves waypoints.json alone", async () => {
    await loadExample();
    const team = MemoryFolder.of("team-repo", teamFiles());
    const { saving } = await justThisAuto(team);
    answerWaypointCheck("own");
    await saving;

    const written = loadAuto(JSON.parse(team.text("autos/collect-and-score.auto.json") ?? "{}"));
    expect(waypointsUsed(written)).toEqual(["scoreSouth"]);
    expect(written.start.pose).toMatchObject({ xIn: -13, yIn: -63 });
    expect(team.text("autos/waypoints.json")).toBe(teamWaypoints());

    expect(getState().project?.name).toBe("team-repo");
    expect(getState().fileName).toBe("collect-and-score.auto.json");
    expect(isDirty()).toBe(false);
    expect(currentDerived().findings.filter((finding) => finding.code === "SCHEMA")).toEqual([]);
    expect(getState().status?.message).toMatch(/^Saved team-repo\/autos\/collect-and-score\.auto\.json and opened team-repo\./);
  });

  it("Add the missing waypoints adds them after the project's own, never over a name, and the start keeps its own pose", async () => {
    await loadExample();
    const team = MemoryFolder.of("team-repo", teamFiles());
    const { saving } = await justThisAuto(team);
    answerWaypointCheck("add");
    await saving;

    const waypoints = loadWaypoints(JSON.parse(team.text("autos/waypoints.json") ?? "{}"));
    expect(Object.keys(waypoints.waypoints)).toEqual(["start", "scoreSouth", ...MISSING]);
    expect(waypoints.waypoints["start"]?.provenance).toBe("MEASURED: our start tile, tape to wall");
    expect(waypoints.waypoints["scoreNorth"]).toEqual(loadWaypoints(JSON.parse(example("autos/waypoints.json"))).waypoints["scoreNorth"]);

    const written = loadAuto(JSON.parse(team.text("autos/collect-and-score.auto.json") ?? "{}"));
    expect(waypointsUsed(written)).toEqual(["scoreSouth", ...MISSING]);
    expect(currentDerived().findings.filter((finding) => finding.code === "SCHEMA")).toEqual([]);
    expect(getState().status?.message).toMatch(
      /^Saved team-repo\/autos\/collect-and-score\.auto\.json, added 5 waypoints to team-repo\/autos\/waypoints\.json and opened team-repo\./,
    );
  });

  it("Follow the project's own keeps the start on the project's waypoint, and a save that leaves errors warns", async () => {
    await loadExample();
    // The team's start is off the field, so following it leaves the auto with errors there.
    const team = MemoryFolder.of("team-repo", teamFiles(teamWaypoints(100)));
    const { saving } = await justThisAuto(team);
    answerWaypointCheck("follow");
    await saving;

    const written = loadAuto(JSON.parse(team.text("autos/collect-and-score.auto.json") ?? "{}"));
    expect(waypointsUsed(written)).toEqual(["start", "scoreSouth"]);
    expect(team.text("autos/waypoints.json")).toBe(teamWaypoints(100));
    const errors = currentDerived().findings.filter((finding) => finding.severity === "error").length;
    expect(errors).toBeGreaterThan(0);
    expect(getState().status?.kind).toBe("warn");
    expect(getState().status?.message).toContain(`It has ${String(errors)} error${errors === 1 ? "" : "s"} there`);
  });

  it("leaves an auto opened while the file was written as it is, and not marked saved (issue #401)", async () => {
    await loadExample();
    const team = MemoryFolder.of("team-repo", teamFiles());
    // Hold the write of the auto's file until the test lets it finish.
    const autos = await team.getDirectoryHandle("autos");
    const getFileHandle = autos.getFileHandle.bind(autos);
    let finishWrite = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    let writing = false;
    autos.getFileHandle = async (name: string, options: { create?: boolean } = {}) => {
      const handle = (await getFileHandle(name, options)) as { createWritable: () => Promise<{ write: (text: string) => Promise<void>; close: () => Promise<void> }> };
      if (name !== "collect-and-score.auto.json" || options.create !== true) return handle;
      return {
        ...handle,
        createWritable: async () => {
          const writer = await handle.createWritable();
          return {
            write: writer.write,
            close: async () => {
              writing = true;
              await held;
              await writer.close();
            },
          };
        },
      };
    };
    picked = team;
    const saving = saveReadOnly({ open: false });
    await until(getSaveChoice);
    answerSaveChoice("auto");
    await until(getWaypointCheck);
    answerWaypointCheck("own");
    await until(() => (writing ? true : null));

    await openAutoNamed("first-auto.auto.json");
    const opened = canonicalize("auto", getState().auto as Auto);
    finishWrite();
    await saving;

    expect(team.text("autos/collect-and-score.auto.json")).toBeDefined();
    expect(getState().fileName).toBe("first-auto.auto.json");
    expect(canonicalize("auto", getState().auto as Auto)).toBe(opened);
    expect(getState().undo).toEqual([]);
    expect(getState().savedCanonical).toBe(opened);
    expect(getState().status?.message).toMatch(/^Saved team-repo\/autos\/collect-and-score\.auto\.json\./);
  });

  it("asks nothing when the project has every waypoint as it is here", async () => {
    await loadExample();
    const team = MemoryFolder.of("team-repo", teamFiles(example("autos/waypoints.json")));
    picked = team;
    const saving = save();
    await until(getSaveChoice);
    answerSaveChoice("auto");
    await saving;
    expect(getWaypointCheck()).toBeNull();
    expect(team.text("autos/collect-and-score.auto.json")).toBe(canonicalize("auto", loadAuto(JSON.parse(example("autos/collect-and-score.auto.json")))));
    expect(getState().status).toMatchObject({ kind: "ok" });
  });

  it("warns about an error in a hidden feature, and says where it is, not green (0.1.2 batch review)", async () => {
    const before = getState().prefs.features;
    try {
      setSettings(presetSettings("essential"));
      await loadExample();
      // Forty pollen at the start, where the robot holds at most four: errors the ledger raises, which
      // Essential's Ledger switch hides from Problems.
      const auto = getState().auto as Auto;
      commit({ ...auto, start: { ...auto.start, holds: { ...auto.start.holds, pollen: 40 } } });
      picked = MemoryFolder.of("team-repo", teamFiles(example("autos/waypoints.json")));
      const saving = save();
      await until(getSaveChoice);
      answerSaveChoice("auto");
      await saving;

      expect(getState().project?.name).toBe("team-repo");
      expect(currentDerived().findings.filter((finding) => finding.severity === "error")).toEqual([]);
      expect(getState().status?.kind).toBe("warn");
      expect(getState().status?.message).toMatch(
        /^Saved team-repo\/autos\/collect-and-score\.auto\.json and opened team-repo\. It has \d+ errors? there, in a feature your settings hide \(Ledger and ball counting\)\.$/,
      );
    } finally {
      setFeatures(before);
    }
  });
});

describe("the waypoint check itself", () => {
  const auto = loadAuto(JSON.parse(example("autos/collect-and-score.auto.json")));
  const here = loadWaypoints(JSON.parse(example("autos/waypoints.json")));

  it("counts a waypoint as the same when only its provenance, or a digit the editor does not show, differs", () => {
    const start = here.waypoints["start"] as Waypoints["waypoints"][string];
    const there: Waypoints = {
      ...here,
      waypoints: { ...here.waypoints, start: { ...start, xIn: start.xIn + 0.001, provenance: "MEASURED: by us" } },
    };
    expect(checkWaypoints(auto, here, there).compared.every((entry) => entry.match === "same")).toBe(true);
    const moved: Waypoints = { ...here, waypoints: { ...here.waypoints, start: { ...start, xIn: start.xIn + 0.01 } } };
    expect(checkWaypoints(auto, here, moved).compared.find((entry) => entry.name === "start")?.match).toBe("differs");
  });

  it("leaves a name this project has no pose for as it is", () => {
    const { start: _start, ...rest } = here.waypoints;
    const check = checkWaypoints(auto, { ...here, waypoints: rest }, undefined);
    expect(check.used).toContain("start");
    expect(check.compared.map((entry) => entry.name)).not.toContain("start");
    expect(waypointsUsed(autoForTarget(auto, check, "own").auto)).toEqual(["start"]);
  });

  it("never adds a waypoint over one the project already has", () => {
    const start = here.waypoints["start"] as Waypoints["waypoints"][string];
    expect(() => withAddedWaypoints(here, { start })).toThrow(/already a waypoint named start/);
  });
});

/**
 * A team's own zenith.json, as Open files reads it: its own robot class, command library and sim
 * command, none of them the example's.
 */
function teamLinkText(): string {
  const link = JSON.parse(example("zenith.json")) as Record<string, unknown>;
  link["deploy"] = {
    ...(link["deploy"] as Record<string, unknown>),
    commandLibrary: "ivy",
    robotClass: "org.firstinspires.ftc.teamcode.OurRobot",
  };
  link["sim"] = {
    command: './gradlew :TeamCode:testDebugUnitTest --tests "*OurSimTest*" -Dzenith.auto={auto}',
    trace: "TeamCode/build/sim/{auto}.trace.json",
  };
  return canonicalize("link", loadLink(link));
}

/** The team's project as Open files gets it, one file at a time, with the team's zenith.json. */
const teamPickedFiles = (): File[] =>
  Object.entries({ ...teamFiles(example("autos/waypoints.json")), "zenith.json": teamLinkText() }).map(
    ([path, text]) => new File([text], path.split("/").pop() as string),
  );

const linkIn = (files: ReadonlyArray<{ path: string; text: string }>) =>
  loadLink(JSON.parse(files.find((file) => file.path === "zenith.json")?.text ?? "{}"));

describe("Save the full project's zenith.json (issue #159)", () => {
  it("leaves out the example's sim command, robot class and command library", () => {
    const project = loadExampleProject();
    const link = linkIn(fullProjectOf(project, "first-auto.auto.json", example("autos/first-auto.auto.json")));
    expect(link.sim).toBeUndefined();
    expect(link.deploy?.robotClass).toBeUndefined();
    expect(link.deploy?.commandLibrary).toBeUndefined();
    expect(link.codegen).toEqual(project.link.codegen);
  });

  it("leaves them out of autos opened on the example's robot and field, whose zenith.json is the example's", () => {
    const text = example("autos/first-auto.auto.json");
    const link = linkIn(fullProjectOf(exampleProjectWith({ "first-auto.auto.json": text }), "first-auto.auto.json", text));
    expect(link.sim).toBeUndefined();
    expect(link.deploy?.robotClass).toBeUndefined();
    expect(link.deploy?.commandLibrary).toBeUndefined();
  });

  it("keeps the team's own zenith.json, as it is, for files opened on their own (the zip a browser without a folder picker downloads)", async () => {
    const project = await projectFromFiles(teamPickedFiles());
    expect(project.source.kind).toBe("files");
    const files = fullProjectOf(project, "first-auto.auto.json", example("autos/first-auto.auto.json"));
    expect(files.find((file) => file.path === "zenith.json")?.text).toBe(teamLinkText());
    const link = linkIn(files);
    expect(link.deploy?.robotClass).toBe("org.firstinspires.ftc.teamcode.OurRobot");
    expect(link.deploy?.commandLibrary).toBe("ivy");
    expect(link.sim?.command).toContain("OurSimTest");
  });

  it("keeps it when a waypoint edit on files opened on their own is saved with the full project into a folder", async () => {
    await openPickedFiles(teamPickedFiles());
    expect(getState().project?.source.kind).toBe("files");
    // A changed waypoint saves only with the full project, so this is the save a team ends up making.
    moveWaypoint("start", { xIn: -36 }, "drag");
    expect(waypointsDirty()).toBe(true);
    const folder = new MemoryFolder("our-copy");
    picked = folder;

    const saving = save();
    const question = await until(getSaveChoice);
    expect(question.isExample).toBe(false);
    answerSaveChoice("project");
    await saving;

    expect(folder.text("zenith.json")).toBe(teamLinkText());
    expect(folder.text("autos/waypoints.json")).toContain('"xIn": -36');
    expect(getState().project?.name).toBe("our-copy");
    expect(getState().project?.link.deploy?.robotClass).toBe("org.firstinspires.ftc.teamcode.OurRobot");
  });
});

/** A desktop bridge over a map of project paths, with the two-step Just this auto (issue #158). */
function desktopBridge(files: Map<string, string>) {
  const writes: Array<{ fileName: string; text: string; addWaypoints: Record<string, unknown> | null }> = [];
  const ref = { root: "C:/team-repo", name: "team-repo" };
  const bridge = {
    apiVersion: DESKTOP_API_VERSION,
    project: {
      saveFullProject: () => Promise.resolve(null),
      pickAutoTarget: (fileName: string) =>
        Promise.resolve({ project: ref, path: `autos/${fileName}`, waypointsPath: "autos/waypoints.json", waypoints: files.get("autos/waypoints.json") ?? null }),
      writeAutoInto: (_root: string, fileName: string, text: string, addWaypoints: Record<string, unknown> | null) => {
        writes.push({ fileName, text, addWaypoints });
        files.set(`autos/${fileName}`, text);
        if (addWaypoints !== null) {
          const now = loadWaypoints(JSON.parse(files.get("autos/waypoints.json") ?? "{}"));
          files.set("autos/waypoints.json", canonicalize("waypoints", loadWaypoints({ ...now, waypoints: { ...now.waypoints, ...addWaypoints } })));
        }
        return Promise.resolve({ project: ref, path: `autos/${fileName}` });
      },
      listAutos: () =>
        Promise.resolve(
          [...files.keys()]
            .filter((path) => path.startsWith("autos/") && path.endsWith(".auto.json") && path.split("/").length === 2)
            .map((path) => path.slice("autos/".length))
            .sort((a, b) => a.localeCompare(b)),
        ),
      read: (_root: string, path: string) => {
        const text = files.get(path);
        return text === undefined ? Promise.reject(new Error(`Could not read ${path} in this folder.`)) : Promise.resolve(text);
      },
      watch: () => Promise.resolve(),
    },
  } as unknown as ZenithDesktopBridge;
  return { bridge, writes };
}

describe("Just this auto in the desktop app picks first, then writes (N71)", () => {
  it("shows the project picked to the editor, and writes what the answer says", async () => {
    const files = new Map(Object.entries(teamFiles()));
    const { bridge, writes } = desktopBridge(files);
    vi.stubGlobal("window", { zenithDesktop: bridge });
    await loadExample();

    const saving = save();
    await until(getSaveChoice);
    answerSaveChoice("auto");
    const check = await until(getWaypointCheck);
    expect(check.project).toBe("team-repo");
    expect(check.rows.map((row) => row.name)).toEqual(["start", ...MISSING]);
    expect(writes).toEqual([]);
    answerWaypointCheck("add");
    await saving;

    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0]?.addWaypoints ?? {})).toEqual(MISSING);
    expect(waypointsUsed(loadAuto(JSON.parse(writes[0]?.text ?? "{}")))).toEqual(["scoreSouth", ...MISSING]);
    expect(getState().project?.source.kind).toBe("desktop");
    expect(currentDerived().findings.filter((finding) => finding.code === "SCHEMA")).toEqual([]);
  });

  it("writes nothing on Cancel", async () => {
    const files = new Map(Object.entries(teamFiles()));
    const { bridge, writes } = desktopBridge(files);
    vi.stubGlobal("window", { zenithDesktop: bridge });
    await loadExample();

    const saving = save();
    await until(getSaveChoice);
    answerSaveChoice("auto");
    await until(getWaypointCheck);
    answerWaypointCheck("cancel");
    await saving;
    expect(writes).toEqual([]);
    expect(files.has("autos/collect-and-score.auto.json")).toBe(false);
  });
});
