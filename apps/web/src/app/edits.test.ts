/**
 * `writeTimeout` is the inspector's timeout field's edit function (`packages/panels/Inspector.tsx`
 * always shows the row for path/command/wait steps now; this is what clearing it has to do): `null`
 * clears the timeout rather than writing `timeoutS: null`, because canonical form only ever omits
 * the key or carries a positive number (`packages/core/src/canonicalize.ts` drops `undefined`
 * values, and `packages/core/src/edit/timing.ts`'s `setTimeout` treats `undefined` as "no timeout").
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WRAP_NOT_SAME_LIST,
  answerDeleteHidden,
  deleteMarker,
  deleteSelection,
  deleteStep,
  duplicateSelection,
  moveSelection,
  placeMarker,
  wrapSelection,
  writeTimeout,
} from "./edits";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { ALL_FEATURES, NO_FEATURES, setFeatures } from "../state/features";
import {
  closeProject,
  currentDerived,
  getState,
  openAuto,
  openProject,
  redo,
  selectStep,
  setPrefs,
  toggleMultiStep,
  undo,
} from "../state/store";
import { foldKey } from "../state/prefs";

const fixture = () =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "edits-fixture",
    title: "Edits fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps: [
      {
        id: "leg1",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: 24, headingRad: 0 } }],
        heading: { mode: "tangent" },
        timeoutS: 3,
      },
      { id: "shoot", kind: "command", name: "score", timeoutS: 2 },
      { id: "sit", kind: "wait", seconds: 1 },
      {
        id: "park",
        kind: "parallel",
        mode: "all",
        steps: [{ id: "idle", kind: "command", name: "spinUp" }],
      },
    ],
  });

beforeEach(() => {
  // The fixture has command steps and markers, which the Commands switch shows.
  setFeatures(ALL_FEATURES);
  openAuto("edits-fixture.auto.json", fixture(), canonicalize("auto", fixture()));
});

describe("writeTimeout", () => {
  it("sets a path step's timeoutS", () => {
    writeTimeout("leg1", 5);
    const step = getState().auto?.steps.find((candidate) => candidate.id === "leg1");
    expect(step?.kind === "path" && step.timeoutS).toBe(5);
  });

  it("clears a command step's timeoutS to null, dropping the key rather than writing null", () => {
    writeTimeout("shoot", null);
    const auto = getState().auto;
    if (auto === null) throw new Error("expected an open document");
    const step = auto.steps.find((candidate) => candidate.id === "shoot");
    expect(step?.kind === "command" && step.timeoutS).toBeUndefined();

    // The canonical bytes carry no timeoutS for "shoot" at all: not the key, and not `null`. Other
    // steps still have their own timeoutS, so this checks the parsed step, not a whole-file substring.
    const roundTripped = JSON.parse(canonicalize("auto", auto)) as { steps: Array<Record<string, unknown>> };
    const shoot = roundTripped.steps.find((candidate) => candidate["id"] === "shoot");
    expect(shoot).toBeDefined();
    expect(shoot).not.toHaveProperty("timeoutS");
  });

  it("sets a wait step's timeoutS, which starts absent", () => {
    writeTimeout("sit", 4);
    const step = getState().auto?.steps.find((candidate) => candidate.id === "sit");
    expect(step?.kind === "wait" && step.timeoutS).toBe(4);
  });

  it("leaves the document untouched when the step kind has no timeoutS", () => {
    const before = getState().auto;
    writeTimeout("park", 1);
    expect(getState().auto).toBe(before);
  });
});

describe("deleteSelection", () => {
  const ids = (): string[] => getState().auto?.steps.map((step) => step.id ?? "") ?? [];

  it("deletes every step of a multi-selection as one undo step", () => {
    selectStep("shoot");
    toggleMultiStep("sit");
    deleteSelection();
    expect(ids()).toEqual(["leg1", "park"]);
    expect(getState().undo).toHaveLength(1);
  });

  it("deletes a group and a step inside it without tripping on the one already gone", () => {
    selectStep("idle");
    toggleMultiStep("park");
    deleteSelection();
    expect(ids()).toEqual(["leg1", "shoot", "sit"]);
  });

  it("refuses to delete every step, and says why", () => {
    selectStep("leg1");
    for (const id of ["shoot", "sit", "park"]) toggleMultiStep(id);
    deleteSelection();
    expect(ids()).toEqual(["leg1", "shoot", "sit", "park"]);
    expect(getState().status?.kind).toBe("error");
  });

  it("still deletes the one selected step when nothing else is selected", () => {
    selectStep("sit");
    deleteSelection();
    expect(ids()).toEqual(["leg1", "shoot", "park"]);
  });
});

describe("delete feedback (issue #183)", () => {
  const ids = (): string[] => getState().auto?.steps.map((step) => step.id ?? "") ?? [];
  const onlyLeg = () =>
    openAuto("one.auto.json", { ...fixture(), steps: [fixture().steps[0]!] }, canonicalize("auto", fixture()));

  it("says what went and how to get it back", () => {
    selectStep("sit");
    deleteSelection();
    expect(getState().status).toMatchObject({ kind: "info", message: "Deleted sit. Ctrl+Z puts it back." });
  });

  it("gives the count when several steps go", () => {
    selectStep("shoot");
    toggleMultiStep("sit");
    deleteSelection();
    expect(getState().status).toMatchObject({ kind: "info", message: "Deleted 2 steps. Ctrl+Z puts them back." });
  });

  it("counts a group as the one step that went, and says how many steps it took with it (issue #411)", () => {
    selectStep("park");
    deleteSelection();
    expect(getState().status?.message).toBe("Deleted park and its 1 step. Ctrl+Z puts them back.");
  });

  it("selects the next row after a delete, so a second Delete keeps going, and undo selects the deleted step again", () => {
    selectStep("sit");
    deleteSelection();
    expect(getState().selection).toEqual({ stepId: "park" });
    undo();
    expect(getState().selection).toEqual({ stepId: "sit" });
  });

  it("selects the row before when the deleted row was the last (issue #411)", () => {
    selectStep("park");
    deleteSelection();
    expect(getState().selection).toEqual({ stepId: "sit" });
    deleteSelection();
    expect(ids()).toEqual(["leg1", "shoot"]);
    expect(getState().selection).toEqual({ stepId: "shoot" });
  });

  it("undo brings a multi-selection back, and so does undo after redo", () => {
    selectStep("shoot");
    toggleMultiStep("sit");
    deleteSelection();
    undo();
    expect(getState().multiSteps).toEqual(["shoot", "sit"]);
    expect(getState().selection).toEqual({ stepId: "sit" });
    redo();
    expect(ids()).toEqual(["leg1", "park"]);
    undo();
    expect(getState().multiSteps).toEqual(["shoot", "sit"]);
  });

  it("writes no success line and keeps the selection when the delete is refused", () => {
    onlyLeg();
    selectStep("leg1");
    deleteSelection();
    expect(getState().status?.kind).toBe("error");
    expect(getState().selection).toEqual({ stepId: "leg1" });
  });

  it("says it once the hidden-commands prompt is answered Delete all", () => {
    setFeatures(NO_FEATURES);
    selectStep("park");
    deleteSelection();
    expect(getState().status?.message ?? "").not.toMatch(/^Deleted/);
    answerDeleteHidden("delete");
    expect(getState().status?.message).toBe("Deleted park and its 1 step. Ctrl+Z puts them back.");
    undo();
    expect(getState().selection).toEqual({ stepId: "park" });
  });
});

describe("deleteStep", () => {
  const ids = (): string[] => getState().auto?.steps.map((step) => step.id ?? "") ?? [];

  it("deletes only the row it is given, not the multi-selection", () => {
    selectStep("shoot");
    toggleMultiStep("sit");
    deleteStep("leg1");
    expect(ids()).toEqual(["shoot", "sit", "park"]);
    expect(getState().status?.message).toBe("Deleted leg1. Ctrl+Z puts it back.");
  });

  it("deletes a step nothing has selected", () => {
    deleteStep("sit");
    expect(ids()).toEqual(["leg1", "shoot", "park"]);
  });

  it("removes a group with everything inside it", () => {
    deleteStep("park");
    expect(ids()).toEqual(["leg1", "shoot", "sit"]);
    expect(JSON.stringify(getState().auto?.steps)).not.toContain("idle");
  });

  it("refuses the last top-level step with a plain message", () => {
    openAuto("one.auto.json", { ...fixture(), steps: [fixture().steps[0]!] }, canonicalize("auto", fixture()));
    deleteStep("leg1");
    expect(ids()).toEqual(["leg1"]);
    expect(getState().status).toMatchObject({
      kind: "error",
      message: "An auto needs at least one step; the last one cannot be deleted.",
    });
  });

  it("opens the hidden-commands prompt for a group that holds hidden steps", () => {
    setFeatures(NO_FEATURES);
    deleteStep("park");
    expect(getState().deleteHiddenPrompt).toEqual({ ids: ["park"], hidden: 1 });
    expect(ids()).toEqual(["leg1", "shoot", "sit", "park"]);
  });

  it("does nothing for an id that is not in the auto", () => {
    const before = getState().auto;
    deleteStep("nope");
    expect(getState().auto).toBe(before);
  });
});

describe("with Commands off", () => {
  const ids = (): string[] => getState().auto?.steps.map((step) => step.id ?? "") ?? [];

  beforeEach(() => {
    setFeatures(NO_FEATURES);
  });

  it("moves a step past the hidden command step to the next visible one, never swapping with it", () => {
    selectStep("sit");
    moveSelection(-1);
    // sit passes shoot (hidden) and leg1, landing just before leg1; shoot stays after leg1.
    expect(ids()).toEqual(["sit", "leg1", "shoot", "park"]);
    expect(getState().undo).toHaveLength(1);
  });

  it("moves down past the hidden step the same way, landing just after the next visible step", () => {
    selectStep("leg1");
    moveSelection(1);
    expect(ids()).toEqual(["shoot", "sit", "leg1", "park"]);
  });

  it("does nothing when only hidden steps lie that way", () => {
    openAuto(
      "edits-fixture.auto.json",
      { ...fixture(), steps: [fixture().steps[0]!, fixture().steps[1]!] },
      canonicalize("auto", fixture()),
    );
    selectStep("leg1");
    moveSelection(1);
    expect(ids()).toEqual(["leg1", "shoot"]);
    expect(getState().undo).toHaveLength(0);
  });

  it("asks before deleting a group that holds hidden steps, and Cancel keeps everything", () => {
    selectStep("park");
    deleteSelection();
    expect(getState().deleteHiddenPrompt).toEqual({ ids: ["park"], hidden: 1 });
    expect(ids()).toEqual(["leg1", "shoot", "sit", "park"]);
    answerDeleteHidden("cancel");
    expect(getState().deleteHiddenPrompt).toBeNull();
    expect(ids()).toEqual(["leg1", "shoot", "sit", "park"]);
  });

  it("deletes the group and its hidden steps on Delete all, and Undo brings them all back", () => {
    selectStep("park");
    deleteSelection();
    answerDeleteHidden("delete");
    expect(ids()).toEqual(["leg1", "shoot", "sit"]);
    undo();
    expect(ids()).toEqual(["leg1", "shoot", "sit", "park"]);
    const park = getState().auto?.steps.find((step) => step.id === "park");
    expect(park?.kind === "parallel" && park.steps.map((step) => step.id)).toEqual(["idle"]);
  });

  it("deletes a step with nothing hidden inside it without asking", () => {
    selectStep("sit");
    deleteSelection();
    expect(getState().deleteHiddenPrompt).toBeNull();
    expect(ids()).toEqual(["leg1", "shoot", "park"]);
  });
});

describe("placeMarker and deleteMarker", () => {
  const markers = () => {
    const step = getState().auto?.steps.find((candidate) => candidate.id === "leg1");
    return step?.kind === "path" ? (step.markers ?? []) : [];
  };

  it("places a marker and selects it, so the inspector opens its section", () => {
    placeMarker("leg1", { t: 0.25 }, "score");
    expect(markers()).toEqual([{ at: { t: 0.25 }, command: { name: "score" } }]);
    expect(getState().selection).toEqual({ stepId: "leg1", markerIndex: 0 });

    placeMarker("leg1", { t: 0.75 }, "spinUp");
    expect(markers()).toHaveLength(2);
    expect(getState().selection).toEqual({ stepId: "leg1", markerIndex: 1 });
  });

  it("leaves the selection alone when the marker cannot be placed", () => {
    selectStep("shoot");
    placeMarker("shoot", { t: 0.5 }, "score");
    expect(getState().status?.kind).toBe("error");
    expect(getState().selection).toEqual({ stepId: "shoot" });
  });

  it("removing the selected marker keeps its path selected on its own", () => {
    placeMarker("leg1", { t: 0.25 }, "score");
    deleteMarker("leg1", 0);
    expect(markers()).toHaveLength(0);
    expect(getState().selection).toEqual({ stepId: "leg1" });
  });

  it("removing an earlier marker keeps the selected one selected at its new index", () => {
    placeMarker("leg1", { t: 0.25 }, "score");
    placeMarker("leg1", { t: 0.75 }, "spinUp");
    deleteMarker("leg1", 0);
    expect(markers()).toEqual([{ at: { t: 0.75 }, command: { name: "spinUp" } }]);
    expect(getState().selection).toEqual({ stepId: "leg1", markerIndex: 0 });
  });

  it("Delete with a marker selected removes the marker, never its path", () => {
    placeMarker("leg1", { t: 0.25 }, "score");
    deleteSelection();
    expect(getState().auto?.steps.map((step) => step.id)).toEqual(["leg1", "shoot", "sit", "park"]);
    expect(markers()).toHaveLength(0);
    expect(getState().selection).toEqual({ stepId: "leg1" });
  });
});

/**
 * Issue #317: Alt + Up and Alt + Down do what a drag does (site/docs/editor.md, "Steps panel"), so
 * they move a step into and out of groups; and an edit that would leave a sequence or parallel
 * group with no steps is refused in plain words, never with the schema's text.
 */
describe("moving and deleting across groups", () => {
  const wait = (id: string) => ({ id, kind: "wait" as const, seconds: 1 });
  const grouped = () =>
    loadAuto({
      ...fixture(),
      steps: [
        wait("a"),
        { id: "grp", kind: "sequence", steps: [wait("b"), wait("c")] },
        wait("d"),
        { id: "br", kind: "branch", condition: "hasPollen", then: [wait("e")], else: [wait("f")] },
        { id: "solo", kind: "parallel", mode: "all", steps: [wait("g")] },
      ],
    });
  /** The tree as nested ids: a group is its id followed by its lists of children. */
  const shape = (): unknown => {
    const walk = (steps: readonly { id?: string; steps?: unknown; then?: unknown; else?: unknown }[]): unknown[] =>
      steps.map((step) => {
        const lists = [step.steps, step.then, step.else].filter((list): list is typeof steps => Array.isArray(list));
        return lists.length === 0 ? step.id : [step.id, ...lists.map(walk)];
      });
    return walk(getState().auto?.steps ?? []);
  };
  const press = (id: string, delta: -1 | 1) => {
    selectStep(id);
    moveSelection(delta);
  };

  beforeEach(() => {
    openAuto("groups.auto.json", grouped(), canonicalize("auto", grouped()));
    setPrefs({ foldedGroups: [] });
  });

  it("moves the first step of a group out, to just before the group, with Alt Up", () => {
    press("b", -1);
    expect(shape()).toEqual(["a", "b", ["grp", ["c"]], "d", ["br", ["e"], ["f"]], ["solo", ["g"]]]);
    expect(getState().selection.stepId).toBe("b");
    expect(getState().undo).toHaveLength(1);
  });

  it("moves the last step of a group out, to just after the group, with Alt Down", () => {
    press("c", 1);
    expect(shape()).toEqual(["a", ["grp", ["b"]], "c", "d", ["br", ["e"], ["f"]], ["solo", ["g"]]]);
  });

  it("moves a step into an open group next to it: first step going down, last step going up", () => {
    press("a", 1);
    expect(shape()).toEqual([["grp", ["a", "b", "c"]], "d", ["br", ["e"], ["f"]], ["solo", ["g"]]]);
    openAuto("groups.auto.json", grouped(), canonicalize("auto", grouped()));
    press("d", -1);
    expect(shape()).toEqual(["a", ["grp", ["b", "c", "d"]], ["br", ["e"], ["f"]], ["solo", ["g"]]]);
  });

  it("passes over a folded group whole", () => {
    setPrefs({ foldedGroups: [foldKey(getState().fileName, "grp")] });
    press("a", 1);
    expect(shape()).toEqual([["grp", ["b", "c"]], "a", "d", ["br", ["e"], ["f"]], ["solo", ["g"]]]);
  });

  it("crosses between a branch's arms before it leaves the branch", () => {
    press("e", 1);
    expect(shape()).toEqual(["a", ["grp", ["b", "c"]], "d", ["br", [], ["e", "f"]], ["solo", ["g"]]]);
    press("e", -1);
    expect(shape()).toEqual(["a", ["grp", ["b", "c"]], "d", ["br", ["e"], ["f"]], ["solo", ["g"]]]);
  });

  it("still does nothing at the very top of the list", () => {
    const before = getState().auto;
    press("a", -1);
    expect(getState().auto).toBe(before);
  });

  it("refuses to move a group's only step out of it, in plain words", () => {
    const before = getState().auto;
    press("g", -1);
    expect(getState().auto).toBe(before);
    expect(getState().status).toMatchObject({
      kind: "error",
      message: "solo is a parallel group and needs at least one step, so g cannot leave it. Unwrap solo to take the step out.",
    });
  });

  it("refuses to delete a sequence's last step, in plain words", () => {
    selectStep("b");
    deleteSelection();
    expect(shape()).toEqual(["a", ["grp", ["c"]], "d", ["br", ["e"], ["f"]], ["solo", ["g"]]]);
    selectStep("c");
    deleteSelection();
    expect(shape()).toEqual(["a", ["grp", ["c"]], "d", ["br", ["e"], ["f"]], ["solo", ["g"]]]);
    expect(getState().status).toMatchObject({
      kind: "error",
      message: "grp is a sequence and needs at least one step, so c cannot be deleted. Delete grp to remove the group with it.",
    });
  });

  it("refuses to delete every step of a group at once, and still deletes a branch arm's only step", () => {
    selectStep("b");
    toggleMultiStep("c");
    deleteSelection();
    expect(getState().status?.message).toBe(
      "grp is a sequence and needs at least one step, so not all of its steps can be deleted. Delete grp to remove the group with it.",
    );
    selectStep("e");
    deleteSelection();
    expect(shape()).toEqual(["a", ["grp", ["b", "c"]], "d", ["br", [], ["f"]], ["solo", ["g"]]]);
  });
});

describe("duplicate chains on (issue #411)", () => {
  const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
  const read = (relative: string): unknown => JSON.parse(readFileSync(`${starter}${relative}`, "utf8"));
  const link = loadLink(read("zenith.json"));
  const project: Project = {
    source: { kind: "example" },
    name: "examples/starter",
    link,
    robot: loadRobot(read(link.robot)),
    field: loadField(read(link.field)),
    waypoints: loadWaypoints(read(link.waypoints ?? "autos/waypoints.json")),
    autoFiles: [],
    autoTexts: {},
  };
  const continuity = (): number => currentDerived().findings.filter((finding) => finding.code === "CONTINUITY").length;

  beforeEach(() => {
    openProject(project, { kind: "local" } as unknown as ProjectBackend);
    const own = loadAuto(read("autos/first-auto.auto.json"));
    openAuto("first-auto.auto.json", own, canonicalize("auto", own));
  });

  afterEach(() => {
    closeProject();
  });

  it("copies the starter's driveOut from where it ends, shifted by its own move, with no CONTINUITY error", () => {
    const continuityBefore = continuity();
    const original = currentDerived().resolved?.steps.find((step) => step.id === "driveOut");
    if (original === undefined) throw new Error("expected driveOut");
    const dx = original.endPose.xIn - original.startPose.xIn;
    const dy = original.endPose.yIn - original.startPose.yIn;

    selectStep("driveOut");
    duplicateSelection();

    const steps = getState().auto?.steps ?? [];
    const at = steps.findIndex((step) => step.id === "driveOut");
    const copy = steps[at + 1];
    expect(copy?.id).toBe("driveOutCopy");
    if (copy?.kind !== "path") throw new Error("expected a path copy");
    expect(copy.segments[0]?.from).toBe("current");
    // Its end followed a waypoint in the original; the copy's end is its own pose, moved.
    const end = copy.segments[copy.segments.length - 1]?.to;
    if (end === undefined || end === "current" || "ref" in end) throw new Error("expected an own pose");
    expect(end.xIn).toBeCloseTo(original.endPose.xIn + dx, 6);
    expect(end.yIn).toBeCloseTo(original.endPose.yIn + dy, 6);
    expect(end.provenance).toBe("SET FROM EDITOR");
    // No CONTINUITY: the copy starts where driveOut ends. Repeating the move does take the robot 27 in
    // further north, into the hive frame, and the steps after it start from there, so the starter
    // gains STRUCTURE and LEGAL_APPROACH errors that a person then fixes by dragging the copy.
    expect(continuity()).toBe(0);
    expect(continuityBefore).toBe(0);
    expect(getState().selection.stepId).toBe("driveOutCopy");
    expect(getState().status?.message).toBe("Duplicated driveOut as driveOutCopy.");
  });

  it("chains a duplicated group on too: its first path, written from the group's start, starts from where the robot is", () => {
    const grouped = loadAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 1,
      name: "grouped",
      alliance: "RED",
      start: { pose: { xIn: -13, yIn: -63, headingRad: Math.PI / 2 } },
      steps: [
        {
          id: "grp",
          kind: "sequence",
          steps: [
            {
              id: "out",
              kind: "path",
              segments: [{ kind: "line", from: { xIn: -13, yIn: -63, headingRad: Math.PI / 2 }, to: { xIn: -13, yIn: -51, headingRad: Math.PI / 2 } }],
              heading: { mode: "tangent" },
            },
            { id: "pause", kind: "wait", seconds: 0.5 },
            {
              id: "side",
              kind: "path",
              segments: [{ kind: "line", from: "current", to: { xIn: -7, yIn: -51, headingRad: Math.PI / 2 } }],
              heading: { mode: "constant", headingRad: Math.PI / 2 },
            },
          ],
        },
      ],
    });
    openAuto("grouped.auto.json", grouped, canonicalize("auto", grouped));
    expect(continuity()).toBe(0);
    selectStep("grp");
    duplicateSelection();

    const copy = getState().auto?.steps[1];
    if (copy?.kind !== "sequence") throw new Error("expected a sequence copy");
    const [out, , side] = copy.steps;
    if (out?.kind !== "path" || side?.kind !== "path") throw new Error("expected the two paths");
    // The opening path follows the original group's end; every point is otherwise as written.
    expect(out.segments[0]?.from).toBe("current");
    expect(out.segments[0]?.to).toEqual({ xIn: -13, yIn: -51, headingRad: Math.PI / 2 });
    expect(side.segments[0]?.from).toBe("current");
    expect(side.segments[0]?.to).toEqual({ xIn: -7, yIn: -51, headingRad: Math.PI / 2 });
    expect(continuity()).toBe(0);
    expect(getState().status?.message).toBe("Duplicated grp as grpCopy.");
  });

  it("starts every member of a duplicated parallel group from where the robot is, and keeps a start written elsewhere", () => {
    const pose = (xIn: number, yIn: number) => ({ xIn, yIn, headingRad: Math.PI / 2 });
    const line = (id: string, from: ReturnType<typeof pose>, to: ReturnType<typeof pose>) => ({
      id,
      kind: "path",
      segments: [{ kind: "line", from, to }],
      heading: { mode: "constant", headingRad: Math.PI / 2 },
    });
    const parallel = loadAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 1,
      name: "parallel",
      alliance: "RED",
      start: { pose: pose(-13, -63) },
      steps: [
        {
          id: "both",
          kind: "parallel",
          mode: "all",
          steps: [line("a", pose(-13, -63), pose(-13, -51)), line("b", pose(-13, -63), pose(-13, -51))],
        },
        { id: "later", kind: "sequence", steps: [line("c", pose(-20, -40), pose(-20, -30))] },
      ],
    });
    openAuto("parallel.auto.json", parallel, canonicalize("auto", parallel));
    selectStep("both");
    duplicateSelection();
    const copy = getState().auto?.steps[1];
    if (copy?.kind !== "parallel") throw new Error("expected a parallel copy");
    for (const member of copy.steps) {
      if (member.kind !== "path") throw new Error("expected paths");
      expect(member.segments[0]?.from).toBe("current");
    }
    // "later" opens away from where the robot is, a gap the original has too; its copy keeps it.
    const gapsBefore = continuity();
    selectStep("later");
    duplicateSelection();
    const laterCopy = getState().auto?.steps.find((step) => step.id === "laterCopy");
    if (laterCopy?.kind !== "sequence" || laterCopy.steps[0]?.kind !== "path") throw new Error("expected the sequence copy");
    expect(laterCopy.steps[0].segments[0]?.from).toEqual(pose(-20, -40));
    expect(continuity()).toBe(gapsBefore + 1);
  });

  it("duplicates every step of a multi-selection as one undo step", () => {
    const count = getState().auto?.steps.length ?? 0;
    const ids = getState().auto?.steps.map((step) => step.id ?? "") ?? [];
    selectStep(ids[0]);
    toggleMultiStep(ids[1]!);
    duplicateSelection();
    expect(getState().auto?.steps.length).toBe(count + 2);
    expect(getState().status?.message).toBe("Duplicated 2 steps.");
    undo();
    expect(getState().auto?.steps.length).toBe(count);
  });
});

describe("wrap refuses steps in different lists in plain words (issue #411)", () => {
  it("says to pick steps in the same list, and never says siblings", () => {
    selectStep("sit");
    toggleMultiStep("idle");
    const before = getState().auto;
    wrapSelection("sequence");
    expect(getState().auto).toBe(before);
    expect(getState().status).toMatchObject({ kind: "error", message: WRAP_NOT_SAME_LIST });
    expect(getState().status?.message).not.toMatch(/sibling/);
  });
});