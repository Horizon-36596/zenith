/**
 * Saving waypoint changes (issue #134). Where the project can write in place, Save writes
 * waypoints.json first, in canonical form, and the auto after it, so a saved auto never follows a
 * waypoint the saved file lacks; when waypoints.json cannot be written, the auto is not saved
 * either. A read-only project (the example, picked files) saves changed waypoints only with the
 * full project, so Just this auto is off while they are unsaved.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type Auto, type Waypoints } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend, SaveResult } from "../project/backend";
import type { Project, ProjectSource } from "../project/types";
import { clearStatus, commit, getState, isDirty, openAuto, openProject, waypointsDirty } from "../state/store";
import { save } from "./projectActions";
import { answerSaveChoice, getSaveChoice } from "./saveChoice";
import { fullProjectOf } from "./saveReadOnly";
import { answerUnsaved, confirmReplace } from "./unsaved";
import { moveWaypoint } from "./waypointEdits";
import { changedWaypointNames, otherAutosRow, waypointImpact } from "./waypointImpact";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const project = (source: ProjectSource): Project => ({
  source,
  name: "save-fixture",
  link: { autosDir: "autos", robot: "autos/robot.json", field: "autos/field.json", waypoints: "autos/waypoints.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("waypoints.json")),
  autoFiles: ["save-fixture.auto.json"],
  autoTexts: {},
});

const auto: Auto = loadAuto({
  $schema: SCHEMA_ID.auto,
  formatVersion: 4,
  name: "save-fixture",
  alliance: "RED",
  start: { pose: { ref: "start" } },
  steps: [{ id: "wait", kind: "wait", seconds: 1 }],
});

/** A writable backend that records what it wrote, in order, and can refuse waypoints.json. */
function backend(failWaypoints = false): ProjectBackend & { writes: string[]; waypointsText: string | null } {
  return {
    kind: "local",
    canPropose: false,
    writes: [],
    waypointsText: null,
    open: () => Promise.resolve(project({ kind: "desktop", root: "C:/save-fixture" })),
    listAutos: () => Promise.resolve([]),
    readAuto: () => Promise.reject(new Error("not used")),
    readText: () => Promise.reject(new Error("not used")),
    save(name: string, text: string): Promise<SaveResult> {
      this.writes.push(name);
      return Promise.resolve({ text });
    },
    writeWaypoints(waypoints: Waypoints): Promise<string> {
      if (failWaypoints) return Promise.reject(new Error("the disk is full"));
      this.waypointsText = canonicalize("waypoints", waypoints);
      this.writes.push("waypoints.json");
      return Promise.resolve(this.waypointsText);
    },
  };
}

function openWith(source: ProjectSource, store: ProjectBackend): void {
  openProject(project(source), store);
  openAuto("save-fixture.auto.json", auto, canonicalize("auto", auto));
  clearStatus();
}

beforeEach(() => {
  answerSaveChoice("cancel");
});

describe("Save where the project writes in place", () => {
  it("writes waypoints.json first, in canonical form, then the auto", async () => {
    const store = backend();
    openWith({ kind: "desktop", root: "C:/save-fixture" }, store);
    moveWaypoint("start", { xIn: -36 }, "drag");
    expect(isDirty()).toBe(true);
    await save();
    expect(store.writes).toEqual(["waypoints.json", "save-fixture.auto.json"]);
    expect(store.waypointsText).toBe(canonicalize("waypoints", getState().project?.waypoints));
    expect(store.waypointsText).toContain('"xIn": -36');
    expect(isDirty()).toBe(false);
    expect(getState().status?.message).toBe("Saved save-fixture.auto.json and waypoints.json.");
  });

  it("leaves waypoints.json alone when no waypoint changed", async () => {
    const store = backend();
    openWith({ kind: "desktop", root: "C:/save-fixture" }, store);
    await save();
    expect(store.writes).toEqual(["save-fixture.auto.json"]);
  });

  it("saves neither file when waypoints.json cannot be written, and says so", async () => {
    const store = backend(true);
    openWith({ kind: "desktop", root: "C:/save-fixture" }, store);
    moveWaypoint("start", { xIn: -36 }, "drag");
    await save();
    expect(store.writes).toEqual([]);
    expect(waypointsDirty()).toBe(true);
    expect(getState().status).toMatchObject({
      kind: "error",
      message: "waypoints.json was not saved, so save-fixture.auto.json was not saved either: the disk is full",
    });
  });
});

describe("Save on a read-only project", () => {
  it("puts the changed waypoints, in canonical form, into the full project", () => {
    openWith({ kind: "example" }, backend());
    moveWaypoint("start", { xIn: -36 }, "drag");
    const state = getState();
    const files = fullProjectOf(state.project as Project, "save-fixture.auto.json", canonicalize("auto", auto));
    const written = files.find((file) => file.path === "autos/waypoints.json");
    expect(written?.text).toBe(canonicalize("waypoints", state.project?.waypoints));
    expect(written?.text).toContain('"provenance": "SET FROM EDITOR"');
  });

  it("turns Just this auto off while waypoints are unsaved", async () => {
    openWith({ kind: "example" }, backend());
    const unchanged = save();
    for (let tries = 0; tries < 50 && getSaveChoice() === null; tries += 1) await Promise.resolve();
    expect(getSaveChoice()?.waypointsChanged).toBeUndefined();
    answerSaveChoice("cancel");
    await unchanged;

    moveWaypoint("start", { xIn: -36 }, "drag");
    const changed = save();
    for (let tries = 0; tries < 50 && getSaveChoice() === null; tries += 1) await Promise.resolve();
    expect(getSaveChoice()?.waypointsChanged).toBe(true);
    // Even if the button were pressed, the auto alone is not saved.
    answerSaveChoice("auto");
    await changed;
    expect(isDirty()).toBe(true);
  });
});

/**
 * Issue #191: moving a shared waypoint says which other autos it breaks. The project holds the four
 * starter autos as text, so each is read and checked as saved and with the moved waypoint.
 */
const shared = (source: ProjectSource = { kind: "desktop", root: "C:/save-fixture" }): Project => {
  const files = ["all-step-kinds", "collect-and-score", "cycle-and-park", "first-auto"].map((name) => `${name}.auto.json`);
  return {
    ...project(source),
    autoFiles: ["save-fixture.auto.json", ...files],
    autoTexts: Object.fromEntries(files.map((file) => [file, readFileSync(`${examples}${file}`, "utf8")])),
  };
};

function openShared(store: ProjectBackend): void {
  openProject(shared(), store);
  openAuto("save-fixture.auto.json", auto, canonicalize("auto", auto));
  clearStatus();
}

/** Waits until the unsaved-changes question is showing. */
async function questionShowing(): Promise<void> {
  for (let tries = 0; tries < 200 && getState().unsavedPrompt === null; tries += 1) await Promise.resolve();
}

describe("what a waypoint edit does to the other autos", () => {
  it("counts the new errors in each follower, from the saved waypoints and the moved ones", async () => {
    openShared(backend());
    moveWaypoint("gardenSweepStart", { xIn: -54, yIn: -58 }, "drag");
    expect(changedWaypointNames()).toEqual(["gardenSweepStart"]);
    const impact = await waypointImpact(["gardenSweepStart"], true);
    expect(impact.followers.map((row) => [row.name, row.newErrors])).toEqual([
      ["all-step-kinds", 1],
      ["collect-and-score", 0],
      ["cycle-and-park", 1],
    ]);
    expect(impact.unreadable).toEqual([]);
    expect(impact.unchecked).toEqual([]);
    expect(otherAutosRow(impact)).toBe("all-step-kinds (1 new error), cycle-and-park (1 new error) and collect-and-score");
  });

  it("only names the followers while the waypoint is as saved", async () => {
    openShared(backend());
    const impact = await waypointImpact(["gardenSweepStart"], false);
    expect(impact.followers.map((row) => [row.name, row.newErrors])).toEqual([
      ["all-step-kinds", null],
      ["collect-and-score", null],
      ["cycle-and-park", null],
    ]);
    expect(otherAutosRow(impact)).toBe("all-step-kinds, collect-and-score and cycle-and-park");
  });

  it("says in Save's status which other autos now have errors, and that waypoints.json was written", async () => {
    const store = backend();
    openShared(store);
    moveWaypoint("gardenSweepStart", { xIn: -54, yIn: -58 }, "drag");
    await save();
    expect(store.writes).toEqual(["waypoints.json", "save-fixture.auto.json"]);
    expect(getState().status).toMatchObject({
      kind: "warn",
      message: "Saved save-fixture.auto.json and waypoints.json. all-step-kinds now has 1 error and cycle-and-park now has 1 error.",
    });
  });

  it("says plainly that waypoints.json was saved when no other auto breaks", async () => {
    const store = backend();
    openShared(store);
    moveWaypoint("parkLoadingZone", { xIn: -56, yIn: 37 }, "drag");
    await save();
    expect(getState().status).toMatchObject({ kind: "ok", message: "Saved save-fixture.auto.json and waypoints.json." });
  });

  it("words the unsaved question by what is dirty", async () => {
    openShared(backend());
    moveWaypoint("gardenSweepStart", { xIn: -54, yIn: -58 }, "drag");
    const going = confirmReplace("Opening first-auto.auto.json will replace it.");
    await questionShowing();
    expect(getState().unsavedPrompt?.lead).toBe(
      "waypoints.json has changes that are not saved (3 other autos follow gardenSweepStart). Discard puts them back.",
    );
    answerUnsaved("cancel");
    expect(await going).toBe(false);
  });

  it("names both files when the auto and the waypoints are both unsaved", async () => {
    openShared(backend());
    moveWaypoint("gardenSweepStart", { xIn: -54, yIn: -58 }, "drag");
    commit({ ...(getState().auto as Auto), title: "Edited" });
    const going = confirmReplace("Opening first-auto.auto.json will replace it.");
    await questionShowing();
    expect(getState().unsavedPrompt?.lead).toMatch(
      /^save-fixture\.auto\.json and waypoints\.json have changes that are not saved \(3 other autos follow gardenSweepStart\)\./,
    );
    answerUnsaved("cancel");
    await going;
  });

  it("keeps the plain question when only the auto changed", async () => {
    openShared(backend());
    commit({ ...(getState().auto as Auto), title: "Edited" });
    const going = confirmReplace("Opening first-auto.auto.json will replace it.");
    await questionShowing();
    expect(getState().unsavedPrompt?.lead).toBeUndefined();
    answerUnsaved("cancel");
    await going;
  });
});
