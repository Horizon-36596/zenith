/**
 * "New auto" in the standalone editor (sweep item A11): a blank auto in the open project, from the
 * same skeleton host mode and `zenith new` start from, found in the palette by searching "new".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalize, loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { matchesQuery } from "../palette/match";
import type { Project } from "../project/types";
import { ACTIONS, tooltipHint } from "./actions";
import { importedLine } from "./importActions";
import { DEFAULT_PREFS } from "../state/prefs";
import { setPrefs, setSetting } from "../state/store";
import { blankAuto, newAutoBlockedReason, newAutoSavedLine } from "./newAuto";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/starter/${path}`, import.meta.url)), "utf8");

function project(source: Project["source"] = { kind: "files" }): Project {
  return {
    source,
    name: "examples/starter",
    link: loadLink(JSON.parse(read("zenith.json"))),
    robot: loadRobot(JSON.parse(read("autos/robot.json"))),
    field: loadField(JSON.parse(read("autos/field/biobuzz.field.json"))),
    waypoints: loadWaypoints(JSON.parse(read("autos/waypoints.json"))),
    autoFiles: ["first-auto.auto.json"],
    autoTexts: { "first-auto.auto.json": read("autos/first-auto.auto.json") },
  };
}

type Hint = Parameters<typeof tooltipHint>[1];

describe("New auto", () => {
  const action = ACTIONS.find((candidate) => candidate.id === "project.newAuto");

  it("is in the palette, and is what searching for new finds", () => {
    expect(action).toBeDefined();
    if (action === undefined) return;
    expect(action.group).toBe("project");
    expect(action.label).toBe("New auto");
    expect(matchesQuery({ label: action.label, group: action.group, keywords: action.keywords }, "new")).toBe(true);
  });

  it("says why it is unavailable with no project open, and in review mode", () => {
    if (action === undefined) return;
    const noProject = { project: null, review: null } as unknown as Hint;
    expect(tooltipHint(action, noProject)).toMatch(/^Unavailable: Open a project first/);
    const reviewing = { project: project(), review: {} } as unknown as Hint;
    expect(tooltipHint(action, reviewing)).toBe("Unavailable: Review mode is read only.");
    expect(newAutoBlockedReason({ project: project(), review: null })).toBeNull();
  });

  it("starts a valid auto named after no auto in the project, nor the one open now", () => {
    const first = blankAuto(project(), "first-auto.auto.json");
    expect(first.fileName).toBe("new-auto.auto.json");
    // What Save writes loads back as the same auto.
    const text = canonicalize("auto", first.auto);
    expect(canonicalize("auto", loadAuto(JSON.parse(text) as unknown))).toBe(text);
    expect(first.auto.steps.length).toBeGreaterThan(0);

    // A second New auto while the first is open and unsaved does not take its name.
    expect(blankAuto(project(), "new-auto.auto.json").fileName).toBe("new-auto-2.auto.json");
  });

  describe("its first path (issue #435)", () => {
    // Everything but the theme, which would reach for the document.
    const resetPrefs = (): void => {
      const { theme: _theme, ...rest } = DEFAULT_PREFS;
      setPrefs(rest);
    };
    beforeEach(resetPrefs);
    afterEach(resetPrefs);

    const firstHeading = (): unknown => {
      const step = blankAuto(project(), null).auto.steps[0];
      return step?.kind === "path" ? step.heading : undefined;
    };

    it("takes the person's default heading, Linear until chosen, from the start's heading to the same heading, not Tangent", () => {
      const heading = firstHeading() as { mode: string; fromRad: number; toRad: number };
      const startHeading = project().waypoints?.waypoints["start"]?.headingRad ?? Number.NaN;
      expect(heading.mode).toBe("linear");
      expect(heading.fromRad).toBeCloseTo(startHeading, 9);
      expect(heading.toRad).toBeCloseTo(startHeading, 9);
    });

    it("is Tangent or Constant when that is the setting", () => {
      setSetting("editing.defaultHeading", "tangent");
      expect(firstHeading()).toEqual({ mode: "tangent" });
      setSetting("editing.defaultHeading", "constant");
      expect(firstHeading()).toMatchObject({ mode: "constant" });
    });
  });

  it("says what Save will do with it", () => {
    expect(newAutoSavedLine(project({ kind: "example" }))).toBe("This project is read only, so Save asks where to put it.");
    expect(newAutoSavedLine(project({ kind: "desktop", root: "/robot" }))).toBe("Save writes it into the project.");
  });
});

/**
 * An import says what Save will do in the project it lands in: in the read-only example Save
 * downloads, so the line no longer says it writes into the project (sweep items A19 and C24).
 */
describe("the status line after an import", () => {
  it("says Save asks where to put it in the read-only example", () => {
    expect(importedLine("path.json", "path.auto.json", undefined, newAutoSavedLine(project({ kind: "example" })))).toBe(
      "Imported path.json as path.auto.json. This project is read only, so Save asks where to put it.",
    );
  });

  it("says Save writes into a project opened from a folder", () => {
    expect(
      importedLine("a.pp", "a.auto.json", "BLUE", newAutoSavedLine(project({ kind: "desktop", root: "/robot" }))),
    ).toBe("Imported a.pp as a.auto.json, written for BLUE. Save writes it into the project.");
  });
});
