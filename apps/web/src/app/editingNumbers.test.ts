/**
 * Nudge, rotate and scrub distances are settings (issue #282): `editing.nudgeIn`, `editing.nudgeFarIn`,
 * `editing.rotateDeg` and `editing.scrubStepS`. Their defaults are the old constants in `shortcuts.ts`,
 * so with nothing set every nudge, turn and scrub moves exactly as before, and a value outside its
 * range falls back to the default.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type Auto } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFS, readPrefs } from "../state/prefs";
import { editingNumbers, formatDegrees, formatInches, formatSeconds, roundEditingNumber } from "../settings/editingNumbers";
import { SETTINGS, settingEntry, type SettingEntry } from "../settings/registry";
import type { Project } from "../project/types";
import type { ProjectBackend } from "../project/backend";
import { keyOnlyRows, KEY_ONLY } from "./keymap";
import { keyRows } from "../help/ShortcutsOverlay";
import { nudge, rotateHeading } from "./edits";
import { NUDGE_FAR_IN, NUDGE_IN, ROTATE_DEG, SCRUB_STEP_S } from "./shortcuts";
import { nudgeWaypoint, rotateWaypoint } from "./waypointEdits";
import { clearStatus, getState, openAuto, openProject, setHost, setPrefs, setSelection, setSetting } from "../state/store";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const project = (): Project => ({
  source: { kind: "example" },
  name: "editing-numbers",
  link: { autosDir: "autos", robot: "autos/robot.json", field: "autos/field.json", waypoints: "autos/waypoints.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("waypoints.json")),
  autoFiles: ["fixture.auto.json"],
  autoTexts: {},
});

const fixture = (): Auto =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 4,
    name: "fixture",
    alliance: "RED",
    start: { pose: { xIn: 10, yIn: -20, headingRad: 0, provenance: "MEASURED" } },
    steps: [
      {
        id: "leg1",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: 24, headingRad: 0 } }],
        heading: { mode: "tangent" },
      },
    ],
  });

const open = (): void => {
  setHost(null);
  openProject(project(), { kind: "local" } as ProjectBackend);
  const auto = fixture();
  openAuto("fixture.auto.json", auto, canonicalize("auto", auto));
  clearStatus();
};

const start = () => getState().auto?.start.pose;
const startHeadingDeg = (): number => {
  const pose = start();
  return (((pose !== undefined && "headingRad" in pose ? pose.headingRad : 0) ?? 0) * 180) / Math.PI;
};
const waypoint = (name: string) => getState().project?.waypoints?.waypoints[name];

beforeEach(() => {
  // Everything but the theme, which would reach for the document.
  const { theme: _theme, ...rest } = DEFAULT_PREFS;
  setPrefs(rest);
  open();
});

describe("the four editing numbers in the registry", () => {
  it("default to the old constants, and no preset sets them", () => {
    expect(NUDGE_IN).toBe(0.5);
    expect(NUDGE_FAR_IN).toBe(2);
    expect(ROTATE_DEG).toBe(5);
    expect(SCRUB_STEP_S).toBe(0.1);
    const expected = {
      "editing.nudgeIn": { storage: "nudgeIn", default: NUDGE_IN, min: 0.05, max: 12 },
      "editing.nudgeFarIn": { storage: "nudgeFarIn", default: NUDGE_FAR_IN, min: 0.1, max: 24 },
      "editing.rotateDeg": { storage: "rotateDeg", default: ROTATE_DEG, min: 0.5, max: 90 },
      "editing.scrubStepS": { storage: "scrubStepS", default: SCRUB_STEP_S, min: 0.01, max: 1 },
    } as const;
    for (const [id, want] of Object.entries(expected) as [keyof typeof expected, (typeof expected)[keyof typeof expected]][]) {
      const entry = settingEntry(id);
      expect(entry.storage).toBe(want.storage);
      expect(entry.defaultValue).toBe(want.default);
      expect(entry.presets).toBe("leave");
      expect([entry.scope, entry.kind, entry.section, entry.group]).toEqual(["person", "editing", "editor", "Editing"]);
      expect(entry.control).toMatchObject({ type: "number", min: want.min, max: want.max });
      expect(entry.parse(want.min)).toBe(want.min);
      expect(entry.parse(want.max)).toBe(want.max);
      expect(entry.parse(want.min / 2)).toBeUndefined();
      expect(entry.parse(want.max * 2)).toBeUndefined();
    }
  });

  it("are in DEFAULT_PREFS as the defaults", () => {
    expect(editingNumbers(DEFAULT_PREFS)).toEqual({ nudgeIn: 0.5, nudgeFarIn: 2, rotateDeg: 5, scrubStepS: 0.1 });
  });

  it("fall back to the default for a stored value out of range or of the wrong type, one at a time", () => {
    const prefs = readPrefs({ nudgeIn: 100, nudgeFarIn: "2", rotateDeg: 0, scrubStepS: 0.5 });
    expect(editingNumbers(prefs)).toEqual({ nudgeIn: 0.5, nudgeFarIn: 2, rotateDeg: 5, scrubStepS: 0.5 });
    for (const junk of [Number.NaN, Number.POSITIVE_INFINITY, -1, null, true, [], {}]) {
      expect(editingNumbers(readPrefs({ nudgeIn: junk })).nudgeIn, String(junk)).toBe(0.5);
    }
    expect(editingNumbers(readPrefs({ nudgeIn: 1, nudgeFarIn: 3, rotateDeg: 15, scrubStepS: 0.25 }))).toEqual({
      nudgeIn: 1,
      nudgeFarIn: 3,
      rotateDeg: 15,
      scrubStepS: 0.25,
    });
  });

  it("are never set by a built-in preset, so every registry entry that leaves them has a default", () => {
    // The toolbar buttons, Optimize path's card options and the keys are left alone by the built-ins too.
    const leave = SETTINGS.filter((entry) => entry.presets === "leave");
    const ids = leave.map((entry) => entry.id);
    for (const id of ["editing.nudgeIn", "editing.nudgeFarIn", "editing.rotateDeg", "editing.scrubStepS"]) expect(ids, id).toContain(id);
    for (const entry of leave as readonly SettingEntry[]) expect(entry.parse(entry.defaultValue), entry.id).toEqual(entry.defaultValue);
  });
});

describe("a nudge or a turn", () => {
  it("moves a point by the old steps with nothing set", () => {
    setSelection({ start: true });
    nudge(1, 0, false);
    expect(start()).toMatchObject({ xIn: 10.5, yIn: -20 });
    nudge(0, 1, true);
    expect(start()).toMatchObject({ xIn: 10.5, yIn: -18 });
    rotateHeading(1);
    expect(startHeadingDeg()).toBeCloseTo(5, 9);
  });

  it("moves a point by the nudge distance that was set, and a far nudge by the far distance", () => {
    setSetting("editing.nudgeIn", 1);
    setSetting("editing.nudgeFarIn", 3);
    setSelection({ start: true });
    nudge(1, 0, false);
    expect(start()).toMatchObject({ xIn: 11, yIn: -20 });
    nudge(0, 1, true);
    expect(start()).toMatchObject({ xIn: 11, yIn: -17 });
  });

  it("turns a point by the angle that was set", () => {
    setSetting("editing.rotateDeg", 15);
    setSelection({ start: true });
    rotateHeading(1);
    expect(startHeadingDeg()).toBeCloseTo(15, 9);
    rotateHeading(-1);
    rotateHeading(-1);
    expect(startHeadingDeg()).toBeCloseTo(-15, 9);
  });

  it("turns a path point's heading by the angle that was set, not by the old 5 degrees", () => {
    const auto = loadAuto({
      ...(JSON.parse(canonicalize("auto", fixture())) as object),
      steps: [
        {
          id: "leg1",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: 24, headingRad: 0 } }],
          heading: { mode: "constant", headingRad: 0.5 },
        },
      ],
    });
    openAuto("fixture.auto.json", auto, canonicalize("auto", auto));
    const constantRad = (): number => {
      const heading = (getState().auto?.steps[0] as { heading?: { mode: string; headingRad?: number } }).heading;
      if (heading?.mode !== "constant" || heading.headingRad === undefined) throw new Error("expected a constant heading");
      return heading.headingRad;
    };
    setSelection({ stepId: "leg1", point: { segmentIndex: 0, pointKind: "to" } });
    rotateHeading(1);
    expect(constantRad()).toBeCloseTo(0.5 + (5 * Math.PI) / 180, 9);
    setSetting("editing.rotateDeg", 15);
    rotateHeading(1);
    expect(constantRad()).toBeCloseTo(0.5 + (20 * Math.PI) / 180, 9);
  });

  it("moves a waypoint pin by the same distances and angle", () => {
    const x = waypoint("scoreSouth")?.xIn ?? Number.NaN;
    const y = waypoint("scoreSouth")?.yIn ?? Number.NaN;
    const h = waypoint("scoreSouth")?.headingRad ?? Number.NaN;
    nudgeWaypoint("scoreSouth", 1, 0, false);
    expect(waypoint("scoreSouth")?.xIn).toBeCloseTo(x + 0.5, 9);
    setSetting("editing.nudgeIn", 1);
    setSetting("editing.nudgeFarIn", 4);
    setSetting("editing.rotateDeg", 10);
    nudgeWaypoint("scoreSouth", 1, 0, false);
    expect(waypoint("scoreSouth")?.xIn).toBeCloseTo(x + 1.5, 9);
    nudgeWaypoint("scoreSouth", 0, -1, true);
    expect(waypoint("scoreSouth")?.yIn).toBeCloseTo(y - 4, 9);
    rotateWaypoint("scoreSouth", 1);
    expect(waypoint("scoreSouth")?.headingRad).toBeCloseTo(h + (10 * Math.PI) / 180, 9);
  });

  it("keeps a waypoint pin's heading in (-180, 180] when the angle that was set turns it past a half turn (#318)", () => {
    const h = waypoint("scoreSouth")?.headingRad ?? Number.NaN;
    setSetting("editing.rotateDeg", 45);
    // 90 degrees plus three turns of 45 is 225, which is -135.
    for (let i = 0; i < 3; i += 1) rotateWaypoint("scoreSouth", 1);
    expect(waypoint("scoreSouth")?.headingRad).toBeCloseTo(h + (135 * Math.PI) / 180 - 2 * Math.PI, 9);
    for (let i = 0; i < 3; i += 1) rotateWaypoint("scoreSouth", -1);
    expect(waypoint("scoreSouth")?.headingRad).toBeCloseTo(h, 9);
  });
});

describe("the words that name the distances", () => {
  it("formats a number without trailing zeros", () => {
    expect([formatInches(0.5), formatInches(1), formatInches(0.05), formatInches(12)]).toEqual(["0.5 in", "1 in", "0.05 in", "12 in"]);
    expect([formatDegrees(5), formatDegrees(0.5)]).toEqual(["5°", "0.5°"]);
    expect([formatSeconds(0.1), formatSeconds(1), formatSeconds(0.01)]).toEqual(["0.1 s", "1 s", "0.01 s"]);
  });

  it("say 1 in on the shortcut sheet once nudgeIn is 1", () => {
    const numbers = editingNumbers(readPrefs({ nudgeIn: 1, nudgeFarIn: 3, scrubStepS: 0.25 }));
    const rows = keyOnlyRows(numbers);
    expect(rows.find((row) => row.id === "nudge")?.does).toContain("1 in");
    expect(rows.find((row) => row.id === "nudgeFar")?.does).toContain("3 in");
    expect(rows.find((row) => row.id === "stepTime")?.does).toContain("0.25 s");
    const folded = keyRows(numbers).find((row) => row.keys.includes("Shift + arrows"));
    expect(folded?.does).toContain("1 in");
    expect(folded?.does).toContain("3 in");
    expect(keyRows(numbers).find((row) => row.keys.includes("Shift + arrows"))?.does).not.toContain("0.5 in");
  });

  it("keeps the sheet's rows, keys and words as they were before the distances were settings, at the defaults", () => {
    // Written out in full, not derived from KEY_ONLY, which is built from the same defaults.
    const defaults = keyOnlyRows(editingNumbers(DEFAULT_PREFS));
    expect(defaults.map((row) => [row.id, row.keys])).toEqual([
      ["nudge", "← ↑ → ↓"],
      ["nudgeFar", "Shift + arrows"],
      ["rotate", "R / Shift R"],
      ["reorder", "Alt + ↑ ↓"],
      ["screens", "Alt + ← →"],
      ["stepTime", ", ."],
      ["cycleRegion", "F6"],
      ["escape", "Esc"],
    ]);
    const does = (id: string): string | undefined => defaults.find((row) => row.id === id)?.does;
    expect(does("nudge")).toBe("Move the selected point or waypoint by 0.5 in. On a step row they walk the list.");
    expect(does("nudgeFar")).toBe("Move the selected point or waypoint by 2 in.");
    expect(does("stepTime")).toBe("Step the playhead back or forward 0.1 s.");
    expect(defaults).toEqual([...KEY_ONLY]);
    expect(keyRows(editingNumbers(DEFAULT_PREFS)).length).toBe(KEY_ONLY.length - 1);
  });

  it("keeps what is typed to the two decimals the Settings field shows, so the key and the sheet say the same number", () => {
    expect(roundEditingNumber(0.123)).toBe(0.12);
    expect(roundEditingNumber(0.125)).toBe(0.13);
    expect(roundEditingNumber(0.05)).toBe(0.05);
    expect(roundEditingNumber(12)).toBe(12);
    // Rounding never leaves a registered range: each one runs between whole hundredths.
    for (const id of ["editing.nudgeIn", "editing.nudgeFarIn", "editing.rotateDeg", "editing.scrubStepS"] as const) {
      const { control } = settingEntry(id);
      if (control.type !== "number") throw new Error(`${id} is not a number`);
      expect(roundEditingNumber(control.min), id).toBe(control.min);
      expect(roundEditingNumber(control.max), id).toBe(control.max);
    }
    expect(formatInches(roundEditingNumber(0.123))).toBe("0.12 in");
  });
});

/** Every non-test source file under `apps/web/src`. */
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = `${directory}/${name}`;
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("the four constants", () => {
  it("are read only by the registry and shortcuts.ts, and everything else reads the setting", () => {
    const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");
    const allowed = new Set([`${root}/settings/registry.ts`, `${root}/app/shortcuts.ts`]);
    const offenders = sources(root)
      .map((path) => path.replace(/\\/g, "/"))
      .filter((path) => !allowed.has(path))
      .filter((path) => /\b(NUDGE_IN|NUDGE_FAR_IN|ROTATE_DEG|SCRUB_STEP_S)\b/.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
