/**
 * The Robot and Commands sections' edits (issue #100): every number keeps its unit in the file and
 * its provenance, a robot that would not load is never offered for saving, and a command typed into
 * the form becomes a registry entry the schema accepts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CLEARANCE_IN, EDITOR_PROVENANCE, canonicalize, loadRobot, robotClearanceIn, robotHeightIn } from "@horizon36596/zenith-core";
import { DEFAULT_ROBOT_HEIGHT_IN, type Robot } from "@horizon36596/zenith-schema";
import {
  CAPACITY,
  CLEARANCE,
  CLEARANCE_SET_PROVENANCE,
  EMPTY_COMMAND,
  EMPTY_PARAM,
  ROBOT_GROUPS,
  addCommand,
  commandFromDraft,
  describeParam,
  draftAfterSave,
  draftOf,
  numberOf,
  provenanceOf,
  removeCommand,
  replaceCommand,
  robotDraftKey,
  robotProblem,
  clearanceSummary,
  clearanceValueText,
  setClearance,
  setMouthNumber,
  setRobotNumber,
  setRobotProvenance,
  settledOf,
  unsettledCounts,
  unsettledLine,
  whyRobotIsReadOnly,
  withCurrentCommands,
  type RobotNumber,
} from "./robotSettings";
import type { Project } from "../project/types";

const path = fileURLToPath(new URL("../../../../examples/starter/autos/robot.json", import.meta.url));
const starter = (): Robot => loadRobot(JSON.parse(readFileSync(path, "utf8")));

const number = (id: string): RobotNumber => {
  const found = ROBOT_GROUPS.flatMap((group) => group.numbers).find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`No number ${id}`);
  return found;
};

describe("read only", () => {
  it("names why each kind of project cannot change its robot here", () => {
    expect(whyRobotIsReadOnly({ kind: "example" } as never, null)).toMatch(/example/);
    expect(whyRobotIsReadOnly({ kind: "files" } as never, null)).toMatch(/one at a time/);
    expect(whyRobotIsReadOnly({ kind: "github" } as never, null)).toMatch(/GitHub/);
    expect(whyRobotIsReadOnly({ kind: "host" } as never, { name: "DSIM", readOnlyRobot: true })).toMatch(/DSIM/);
    expect(whyRobotIsReadOnly({ kind: "directory" } as never, null)).toBeNull();
    expect(whyRobotIsReadOnly({ kind: "desktop", root: "C:\\robot" }, null)).toBeNull();
  });
});

describe("robot numbers", () => {
  it("reads and writes a value and keeps its provenance", () => {
    const robot = starter();
    const top = number("maxForward");
    expect(numberOf(robot, top)).toBe(60);
    const next = setRobotNumber(robot, top, 72);
    expect(numberOf(next, top)).toBe(72);
    expect(provenanceOf(next, top)).toBe(provenanceOf(robot, top));
    expect(robotProblem(next)).toBeNull();
    // The original is untouched.
    expect(numberOf(robot, top)).toBe(60);
  });

  it("shows turning speed in degrees and keeps radians in the file", () => {
    const robot = starter();
    const turn = number("maxTurn");
    expect(turn.unit.toShown(numberOf(robot, turn) ?? 0)).toBeCloseTo((6 * 180) / Math.PI, 6);
    const next = setRobotNumber(robot, turn, 180);
    expect(numberOf(next, turn)).toBeCloseTo(Math.PI, 9);
  });

  it("labels a new optional number SET FROM EDITOR, and clears it again", () => {
    const robot = starter();
    const track = number("trackWidth");
    expect(numberOf(robot, track)).toBeNull();
    const set = setRobotNumber(robot, track, 14);
    expect(numberOf(set, track)).toBe(14);
    expect(provenanceOf(set, track)).toBe(EDITOR_PROVENANCE);
    expect(robotProblem(set)).toBeNull();
    const cleared = setRobotNumber(set, track, null);
    expect(numberOf(cleared, track)).toBeNull();
    expect(robotProblem(cleared)).toBeNull();
  });

  it("never clears a required number", () => {
    const robot = starter();
    expect(setRobotNumber(robot, number("startLength"), null)).toBe(robot);
  });

  it("issue #272: the Height row sets the root heightIn that the structure check and the legs read", () => {
    const robot = starter();
    const height = number("height");
    expect(height.path).toEqual(["heightIn", "value"]);
    expect(numberOf(robot, height)).toBe(18);
    const taller = setRobotNumber(robot, height, 26);
    expect(taller.heightIn?.value).toBe(26);
    expect(robotHeightIn(taller)).toBe(26);
    // Clearing it leaves the robot with no heightIn, so the check falls back to its default.
    const cleared = setRobotNumber(taller, height, null);
    expect(cleared.heightIn).toBeUndefined();
    expect(robotHeightIn(cleared)).toBe(DEFAULT_ROBOT_HEIGHT_IN);
    // A value typed where the file had none is labelled, never left with no provenance.
    const typed = setRobotNumber(cleared, height, 22);
    expect(typed.heightIn).toEqual({ value: 22, provenance: EDITOR_PROVENANCE });
    expect(robotProblem(typed)).toBeNull();
  });

  it("issue #272: the Height row's hint says it decides which part of the slanted legs the robot hits", () => {
    expect(number("height").hint).toMatch(/which part of the slanted legs the robot hits/);
  });

  it("changes the provenance a box's numbers share", () => {
    const robot = starter();
    const length = number("startLength");
    const next = setRobotProvenance(robot, length, "MEASURED");
    expect(provenanceOf(next, length)).toBe("MEASURED");
    expect(provenanceOf(next, number("startWidth"))).toBe("MEASURED");
    expect(numberOf(next, length)).toBe(18);
  });

  it("edits capacity and a mouth", () => {
    const robot = setMouthNumber(setRobotNumber(starter(), CAPACITY, 3), 0, "x", 8);
    expect(robot.capacity?.max).toBe(3);
    expect(robot.mouths?.[0]?.offsetIn.xIn).toBe(8);
    expect(robotProblem(robot)).toBeNull();
  });

  it("refuses a robot that would not load", () => {
    const bad = setRobotNumber(starter(), number("startLength"), -4);
    expect(robotProblem(bad)).not.toBeNull();
  });

  it("an edit round-trips through the canonical form", () => {
    const edited = setRobotNumber(starter(), number("accel"), 75);
    const text = canonicalize("robot", edited);
    expect(numberOf(loadRobot(JSON.parse(text)), number("accel"))).toBe(75);
  });
});

describe("commands", () => {
  const others = (robot: Robot, except?: string) => robot.commands.map((command) => command.name).filter((name) => name !== except);

  it("builds a new command from the form", () => {
    const robot = starter();
    const result = commandFromDraft(
      {
        ...EMPTY_COMMAND,
        name: "liftUp",
        summary: "Raises the lift.",
        estimateS: "0.5",
        requires: "lift",
        params: [{ ...EMPTY_PARAM, name: "height", type: "integer", min: "0", max: "6000", default: "3000" }],
      },
      others(robot),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command).toEqual({
      name: "liftUp",
      summary: "Raises the lift.",
      params: { height: { type: "integer", min: 0, max: 6000, default: 3000 } },
      estimateS: "0.5",
      requires: ["lift"],
    });
    const added = addCommand(robot, result.command);
    expect(robotProblem(added)).toBeNull();
    expect(describeParam("height", result.command.params?.["height"] ?? { type: "string" })).toBe("height: whole number 0 to 6000, default 3000");
  });

  it("refuses a bad name, a taken name, a bad time and a bad argument", () => {
    const robot = starter();
    const taken = robot.commands[0]?.name ?? "";
    expect(commandFromDraft({ ...EMPTY_COMMAND, name: "" }, others(robot))).toMatchObject({ ok: false });
    expect(commandFromDraft({ ...EMPTY_COMMAND, name: "two words" }, others(robot))).toMatchObject({ ok: false });
    expect(commandFromDraft({ ...EMPTY_COMMAND, name: taken }, others(robot))).toMatchObject({ ok: false, problem: `The robot already has a command named ${taken}.` });
    expect(commandFromDraft({ ...EMPTY_COMMAND, name: "x", estimateS: "soon" }, others(robot))).toMatchObject({ ok: false });
    expect(
      commandFromDraft({ ...EMPTY_COMMAND, name: "x", params: [{ ...EMPTY_PARAM, name: "n", min: "5", max: "1" }] }, others(robot)),
    ).toMatchObject({ ok: false });
    expect(
      commandFromDraft({ ...EMPTY_COMMAND, name: "x", params: [{ ...EMPTY_PARAM, name: "mode", type: "enum", values: "" }] }, others(robot)),
    ).toMatchObject({ ok: false });
  });

  it("edits a command in place and keeps what the form does not show", () => {
    const robot = starter();
    const previous = robot.commands[0];
    if (previous === undefined) throw new Error("The starter robot has commands.");
    const draft = { ...draftOf(previous), summary: "Runs the intake." };
    const result = commandFromDraft(draft, others(robot, previous.name), previous);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.params).toEqual(previous.params);
    expect(result.command.stationary).toBe(previous.stationary);
    const edited = replaceCommand(robot, previous.name, result.command);
    expect(edited.commands.map((command) => command.name)).toEqual(robot.commands.map((command) => command.name));
    expect(edited.commands[0]?.summary).toBe("Runs the intake.");
    expect(robotProblem(edited)).toBeNull();
  });

  it("an unchanged draft gives back the same command", () => {
    for (const command of starter().commands) {
      const result = commandFromDraft(draftOf(command), [], command);
      expect(result, command.name).toEqual({ ok: true, command });
    }
  });

  it("removes a command", () => {
    const robot = starter();
    const name = robot.commands[0]?.name ?? "";
    const removed = removeCommand(robot, name);
    expect(removed.commands.some((command) => command.name === name)).toBe(false);
    expect(removed.commands.length).toBe(robot.commands.length - 1);
  });
});

describe("path speed hints (issue #192)", () => {
  it("says the robot applies Default path speed only if its ZenithRobot implements atSpeed", () => {
    const entry = ROBOT_GROUPS.flatMap((group) => group.numbers).find((number) => number.id === "speedFraction");
    expect(entry?.hint).toContain("atSpeed");
  });
});

/**
 * Owner ruling D8: the clearance from field elements belongs to the robot, so Settings, Robot shows
 * it and Set writes `footprint.clearanceIn` to robot.json, SET BY HAND by default. It is the one
 * project-file write the settings make.
 */
describe("the clearance from field elements (D8)", () => {
  it("shows Zenith's 1 in default while robot.json leaves it out", () => {
    const robot = starter();
    expect(robot.footprint.clearanceIn).toBeUndefined();
    expect(numberOf(robot, CLEARANCE)).toBeNull();
    // The Robot row says so in one word, and the Editor's Safety margin shows only the number (issue #414).
    expect(clearanceSummary(robot)).toBe("1 in (default)");
    expect(clearanceSummary(robot)).not.toContain("robot.json");
    expect(clearanceValueText(robot)).toBe("1 in");
  });

  it("Set writes the default into robot.json, SET BY HAND, and the robot still loads", () => {
    const set = setClearance(starter());
    expect(set.footprint.clearanceIn).toEqual({ value: DEFAULT_CLEARANCE_IN, provenance: CLEARANCE_SET_PROVENANCE });
    expect(CLEARANCE_SET_PROVENANCE.startsWith("SET BY HAND")).toBe(true);
    expect(provenanceOf(set, CLEARANCE)).toBe(CLEARANCE_SET_PROVENANCE);
    expect(robotProblem(set)).toBeNull();
    expect(clearanceSummary(set)).toBe("1 in");
    // Set on a robot that has the key already changes nothing.
    expect(setClearance(set)).toBe(set);
  });

  it("saves byte-stable: the canonical file gains only the key, last in footprint, and re-saves the same", () => {
    const before = canonicalize("robot", starter());
    const text = canonicalize("robot", setClearance(starter()));
    const block = `,
    "clearanceIn": {
      "value": 1,
      "provenance": ${JSON.stringify(CLEARANCE_SET_PROVENANCE)}
    }`;
    expect(text).toContain(block);
    expect(text.replace(block, "")).toBe(before);
    expect(canonicalize("robot", loadRobot(JSON.parse(text) as unknown))).toBe(text);
  });

  it("keeps SET BY HAND when the number is typed, and clearing it goes back to the default", () => {
    const set = setClearance(starter());
    const typed = setRobotNumber(set, CLEARANCE, 2.5);
    expect(typed.footprint.clearanceIn).toEqual({ value: 2.5, provenance: CLEARANCE_SET_PROVENANCE });
    expect(robotClearanceIn(typed)).toBe(2.5);
    const cleared = setRobotNumber(typed, CLEARANCE, null);
    expect(cleared.footprint.clearanceIn).toBeUndefined();
    expect(robotClearanceIn(cleared)).toBe(DEFAULT_CLEARANCE_IN);
    expect(canonicalize("robot", cleared)).toBe(canonicalize("robot", starter()));
  });

  it("refuses a negative clearance, as the schema does", () => {
    expect(robotProblem(setRobotNumber(setClearance(starter()), CLEARANCE, -1))).not.toBeNull();
    expect(CLEARANCE.min).toBe(0);
  });
});

/**
 * The line above Robot (issue #414): how many values are placeholders and how many still need
 * measuring, and the filter that shows only those rows.
 */
describe("what is left to settle", () => {
  const listed = ROBOT_GROUPS.flatMap((group) => group.numbers);

  it("reads a value's provenance as a placeholder, as needing measurement, or as settled", () => {
    expect(settledOf("PLACEHOLDER: until calibrated")).toBe("placeholder");
    expect(settledOf("NEEDS MEASUREMENT")).toBe("needs");
    // A value with no label, or a note with none of the vocabulary, has not been settled either.
    expect(settledOf(undefined)).toBe("needs");
    expect(settledOf("whatever somebody typed")).toBe("needs");
    for (const label of ["MEASURED 2026-01-15", "SET BY HAND", "SET FROM EDITOR", "CALIBRATED FROM ROBOT", "SPEC", "APPROX"]) {
      expect(settledOf(label), label).toBe("settled");
    }
  });

  it("counts the numbers the file has, by what their provenance says, and skips one it leaves out", () => {
    const robot = starter();
    const counts = unsettledCounts(robot, listed);
    const by = (kind: string) => listed.filter((entry) => numberOf(robot, entry) !== null && settledOf(provenanceOf(robot, entry)) === kind).length;
    expect(counts).toEqual({ placeholders: by("placeholder"), needMeasuring: by("needs") });
    expect(counts.placeholders + counts.needMeasuring).toBeGreaterThan(0);
    // A value that is set by hand is settled: it leaves both counts.
    const entry = number("startLength");
    const before = unsettledCounts(robot, [entry]);
    const settled = setRobotProvenance(robot, entry, "SET BY HAND: tape");
    const after = unsettledCounts(settled, [entry]);
    expect(before.placeholders + before.needMeasuring).toBe(1);
    expect(after).toEqual({ placeholders: 0, needMeasuring: 0 });
  });

  it("says it as one line, and says nothing when nothing is left", () => {
    expect(unsettledLine({ placeholders: 12, needMeasuring: 4 })).toBe("12 values are placeholders and 4 need measuring");
    expect(unsettledLine({ placeholders: 1, needMeasuring: 1 })).toBe("1 value is a placeholder and 1 needs measuring");
    expect(unsettledLine({ placeholders: 3, needMeasuring: 0 })).toBe("3 values are placeholders");
    expect(unsettledLine({ placeholders: 0, needMeasuring: 2 })).toBe("2 values need measuring");
    expect(unsettledLine({ placeholders: 0, needMeasuring: 1 })).toBe("1 value needs measuring");
    expect(unsettledLine({ placeholders: 0, needMeasuring: 0 })).toBeNull();
  });
});

describe("command arguments named like what every object has (issue #403)", () => {
  it("takes an argument named constructor, toString or __proto__ as any other name", () => {
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      const result = commandFromDraft(
        { ...EMPTY_COMMAND, name: "spin", estimateS: `0.5 * ${name}`, params: [{ ...EMPTY_PARAM, name, default: "1" }] },
        [],
      );
      expect(result, name).toMatchObject({ ok: true });
      if (!result.ok) continue;
      expect(Object.keys(result.command.params ?? {}), name).toEqual([name]);
      expect(Object.hasOwn(result.command.params ?? {}, name), name).toBe(true);
    }
  });

  it("still refuses two arguments of one name, and a time that names no argument", () => {
    expect(
      commandFromDraft({ ...EMPTY_COMMAND, name: "spin", params: [{ ...EMPTY_PARAM, name: "n" }, { ...EMPTY_PARAM, name: "n" }] }, []),
    ).toMatchObject({ ok: false, problem: "Two arguments are named n." });
    expect(commandFromDraft({ ...EMPTY_COMMAND, name: "spin", estimateS: "0.5 * constructor" }, [])).toMatchObject({
      ok: false,
      problem: "The time uses constructor, which is not one of the arguments.",
    });
  });
});

describe("the Robot section's unsaved draft (issue #403)", () => {
  const project = (source: unknown, name = "biobuzz"): Project =>
    ({ name, source, link: { robot: "robot.json" } }) as unknown as Project;

  it("belongs to where the project was opened from, not only its name and robot file", () => {
    const first = project({ kind: "directory", handle: { name: "biobuzz-clone-a" } });
    const second = project({ kind: "directory", handle: { name: "biobuzz-clone-b" } });
    const github = project({ kind: "github", owner: "Horizon-36596", repo: "biobuzz", branch: "main", base: "main" });
    expect(robotDraftKey(first)).not.toBe(robotDraftKey(second));
    expect(robotDraftKey(first)).not.toBe(robotDraftKey(github));
    expect(robotDraftKey(first)).toBe(robotDraftKey(project({ kind: "directory", handle: { name: "biobuzz-clone-a" } })));
  });

  it("goes after a save that wrote it, and stays when it was edited while the save was on its way", () => {
    const saved = starter();
    const written = setRobotNumber(saved, number("accel"), 75);
    const draft = { key: "k", robot: written };
    expect(draftAfterSave(draft, withCurrentCommands(written, saved))).toBeNull();
    const later = { key: "k", robot: setRobotNumber(written, number("accel"), 80) };
    expect(draftAfterSave(later, withCurrentCommands(written, saved))).toBe(later);
    expect(draftAfterSave(null, written)).toBeNull();
  });
});
