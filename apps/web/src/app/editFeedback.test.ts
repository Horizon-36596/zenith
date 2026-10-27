/**
 * What the editor says after a step edit, and what a default insert leaves behind (issue #505, part
 * of #498): an insert, a wrap, a rename, a move and a placed marker each write one status line in the
 * past tense; a default path, sequence or parallel group raises no error on the steps it brings; a
 * rename outside the step id rule is refused with the reason (issue #494).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, collectIds, loadAuto, loadField, loadRobot } from "@horizon36596/zenith-core";
import type { Auto, Step } from "@horizon36596/zenith-schema";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import { turnIds } from "../lib/stepKinds";
import { currentDerived, getState, openAuto, selectStep, selectStepRange, setAutoOverrides, toggleMultiStep } from "../state/store";
import {
  addParallelStep,
  addPathStep,
  addSequenceStep,
  addTurnStep,
  addWaitStep,
  deletePoint,
  markerPlace,
  moveSelection,
  moveStepTo,
  movedMessage,
  placeMarker,
  renameStepTo,
  setSegmentKindAt,
  stepRenameProblem,
  wrapSelection,
} from "./edits";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const line = (id: string, xIn: number, yIn: number): Step => ({
  id,
  kind: "path",
  segments: [{ kind: "line", from: "current", to: { xIn, yIn, headingRad: Math.PI / 2 } }],
  heading: { mode: "tangent" },
});

/** Three legs north from the RED side's south wall, clear of the hives. */
const fixture = (start = { xIn: -36, yIn: -60 }, steps: Step[] = [line("leg1", -36, -48), line("leg2", -36, -36), line("leg3", -36, -24)]): Auto =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "feedback-fixture",
    title: "Feedback fixture",
    alliance: "RED",
    start: { pose: { ...start, headingRad: Math.PI / 2 } },
    steps,
  });

const open = (auto: Auto): void => {
  openAuto("feedback-fixture.auto.json", auto, canonicalize("auto", auto));
  setAutoOverrides(loadRobot(read("robot.json")), loadField(read("field/biobuzz.field.json")));
};

const auto = (): Auto => {
  const current = getState().auto;
  if (current === null) throw new Error("expected an open document");
  return current;
};

const status = (): string | undefined => getState().status?.message;

/** The errors Problems shows on any of `ids`. */
const errorsOn = (ids: ReadonlySet<string>): string[] =>
  currentDerived()
    .findings.filter((finding) => finding.severity === "error" && finding.stepId !== undefined && ids.has(finding.stepId))
    .map((finding) => `${finding.code} ${finding.stepId ?? ""}`);

/** The ids a document has that `before` did not. */
const newIds = (before: Auto): Set<string> => {
  const had = collectIds(before.steps);
  return new Set([...collectIds(auto().steps)].filter((id) => !had.has(id)));
};

beforeEach(() => {
  open(fixture());
});

describe("an insert says where it went", () => {
  it("names the step it went after", () => {
    selectStep("leg1");
    const id = addWaitStep();
    expect(status()).toBe(`Added ${String(id)} after leg1.`);
  });

  it("says at the end when nothing was selected", () => {
    selectStep(undefined);
    const id = addTurnStep();
    expect(status()).toBe(`Added ${String(id)} at the end.`);
  });
});

describe("a default insert starts with no error (part of #498)", () => {
  for (const [name, insert] of [
    ["path", addPathStep],
    ["sequence", addSequenceStep],
    ["parallel group", () => addParallelStep("all")],
    ["deadline group", () => addParallelStep("deadline", "drive")],
  ] as const) {
    it(`a ${name} after a step in the open`, () => {
      selectStep("leg3");
      const before = auto();
      expect(insert()).not.toBeNull();
      expect(errorsOn(newIds(before))).toEqual([]);
    });

    it(`a ${name} again and again, as the review did, toward the hive`, () => {
      open(fixture({ xIn: -16, yIn: -40 }, [line("leg1", -16, -28)]));
      for (let count = 0; count < 4; count += 1) {
        const before = auto();
        expect(insert()).not.toBeNull();
        expect(errorsOn(newIds(before))).toEqual([]);
      }
    });
  }

  it("names the leg path1 when it is clear, as before", () => {
    selectStep("leg3");
    const id = addSequenceStep();
    const group = auto().steps.find((step) => step.id === id);
    expect(group?.kind === "sequence" ? group.steps.map((step) => step.kind) : []).toEqual(["path"]);
  });
});

describe("wrap, rename and move say what they did", () => {
  it("wraps in document order and names the group", () => {
    selectStep("leg2");
    toggleMultiStep("leg1");
    wrapSelection("parallel");
    const group = auto().steps[0]?.id ?? "";
    expect(status()).toBe(`Wrapped leg1 and leg2 in ${group}.`);
  });

  it("renames, and says so", () => {
    expect(renameStepTo("leg2", "driveNorth")).toBe("driveNorth");
    expect(status()).toBe("Renamed leg2 to driveNorth.");
    expect(getState().selection.stepId).toBe("driveNorth");
  });

  it("refuses an id with a space, with the reason, and changes nothing (#494)", () => {
    const before = auto();
    expect(stepRenameProblem("leg2", "drive north")).toBe("A step's id starts with a letter and holds only letters, digits, _ and -.");
    expect(renameStepTo("leg2", "drive north")).toBe("leg2");
    expect(auto()).toBe(before);
    expect(getState().status?.kind).toBe("error");
    expect(status()).toBe("A step's id starts with a letter and holds only letters, digits, _ and -. leg2 keeps its id.");
  });

  it("refuses an id another step has", () => {
    expect(renameStepTo("leg2", "leg1")).toBe("leg2");
    expect(status()).toBe("There is already a step named leg1. leg2 keeps its id.");
  });

  it("says where Alt Up moved a step", () => {
    selectStep("leg3");
    moveSelection(-1);
    expect(status()).toBe("Moved leg3 before leg2.");
  });

  it("says a drag into and out of a group", () => {
    selectStep("leg3");
    wrapSelection("sequence");
    const group = auto().steps[2]?.id ?? "";
    moveStepTo("leg1", group, "into");
    expect(status()).toBe(`Moved leg1 into ${group}.`);
    moveStepTo("leg1", group, "after");
    expect(status()).toBe(`Moved leg1 out of ${group}.`);
  });

  it("names a moved positional step by the id it had, then the one it has", () => {
    const unnamed = (step: Step): Step => {
      const copy = { ...step };
      delete copy.id;
      return copy;
    };
    open(fixture(undefined, [line("leg1", -36, -48), line("leg2", -36, -36), line("leg3", -36, -24)].map(unnamed)));
    selectStep("step3");
    moveSelection(-1);
    expect(status()).toBe("Moved step3, now step2, before step3.");
    moveStepTo("step3", "step1", "before");
    expect(status()).toBe("Moved step3, now step1, before step2.");
  });

  it("has nothing to say for a move that did not happen", () => {
    const before = auto();
    expect(movedMessage(before, before, "leg1")).toBeNull();
  });
});

describe("markers and points", () => {
  it("says what a placed marker runs, and where", () => {
    placeMarker("leg2", { t: 0.3 }, "intakeOn");
    expect(status()).toBe("Added a marker on leg2 at 30 % that runs intakeOn.");
    expect(markerPlace({ distanceIn: 12 })).toBe("12.0 in along");
    expect(markerPlace({ distanceFromEndIn: 6 })).toBe("6.0 in before its end");
  });

  it("names a one-path step alone when it becomes a curve", () => {
    setSegmentKindAt("leg2", 0, "bezier");
    expect(status()).toBe("leg2 is a curve now. Drag the hollow square in its middle to bend it.");
    setSegmentKindAt("leg2", 0, "line");
    expect(status()).toBe("leg2 is a straight line now.");
  });

  it("says why the end of the only step cannot go", () => {
    open(fixture(undefined, [line("leg1", -36, -48)]));
    deletePoint("leg1", { segmentIndex: 0, pointKind: "to" });
    expect(status()).toBe("leg1 has one path, so deleting its end would delete the step, and an auto needs at least one step.");
  });
});

describe("selection and kinds", () => {
  it("selects a run of rows with the clicked one primary", () => {
    selectStepRange(["leg1", "leg2", "leg3"], "leg3");
    expect(getState().multiSteps).toEqual(["leg1", "leg2", "leg3"]);
    expect(getState().selection.stepId).toBe("leg3");
  });

  it("finds a turn on the spot among the planned steps", () => {
    selectStep("leg3");
    const id = addTurnStep();
    expect([...turnIds(currentDerived().plan)]).toEqual([id]);
  });
});
