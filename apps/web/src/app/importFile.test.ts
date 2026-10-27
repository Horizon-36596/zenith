import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize, loadAuto, loadField } from "@horizon36596/zenith-core";
import { ACTIONS, tooltipHint } from "./actions";
import { assumedAllianceNotice, autoNameFromFile, freeAutoName, importAutoFile, MAX_IMPORT_BYTES } from "./importFile";

/** "Import from another planner" (M-C8): the part that runs once the file's text is in hand. */
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string): string => readFileSync(`${repo}${path}`, "utf8");
const field = loadField(JSON.parse(read("examples/starter/autos/field/biobuzz.field.json")));
const fixture = (path: string): string => read(`packages/import/fixtures/${path}`);

describe("importAutoFile", () => {
  it("opens a .pp project as a canonical auto named after the file, with the importer's warnings", () => {
    const outcome = importAutoFile("score-and-park.pp", fixture("pedro/score-and-park.pp"), field, []);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.source).toBe("pedro");
    expect(outcome.fileName).toBe("score-and-park.auto.json");
    expect(outcome.auto.name).toBe("score-and-park");
    // The editor holds exactly what Save writes: a second pass through the canonical writer changes nothing.
    const text = canonicalize("auto", outcome.auto);
    expect(canonicalize("auto", loadAuto(JSON.parse(text) as unknown))).toBe(text);
    expect(outcome.warnings.some((warning) => warning.includes("does not say which alliance"))).toBe(true);
  });

  it("says what the editor can do about a .pp file's alliance, and imports it for the one chosen", () => {
    const assumed = importAutoFile("score-and-park.pp", fixture("pedro/score-and-park.pp"), field, []);
    expect(assumed).toMatchObject({ ok: true, assumedAlliance: "RED" });
    if (!assumed.ok) return;
    expect(assumed.auto.alliance).toBe("RED");
    expect(assumed.warnings).toContain(assumedAllianceNotice("RED"));
    expect(assumedAllianceNotice("RED")).toContain("click Import for BLUE on this notice");
    // The command line's advice to pass an alliance is not the editor's to give.
    expect(assumed.warnings.join("\n")).not.toMatch(/Pass the alliance/);

    const blue = importAutoFile("score-and-park.pp", fixture("pedro/score-and-park.pp"), field, [], { alliance: "BLUE" });
    expect(blue.ok).toBe(true);
    if (!blue.ok) return;
    expect(blue.auto.alliance).toBe("BLUE");
    expect(blue.assumedAlliance).toBeUndefined();
    expect(blue.warnings.join("\n")).not.toMatch(/does not say which alliance/);
    // Only the alliance the auto is written for changes: the poses are the file's.
    expect(blue.auto.start).toEqual(assumed.auto.start);
  });

  it("opens a path.json as an auto, and never takes the name of an auto the project has", () => {
    const outcome = importAutoFile(
      "pedro-score-and-park.path.json",
      fixture("path/pedro-score-and-park.path.json"),
      field,
      ["pedro-score-and-park.auto.json", "pedro-score-and-park-2.auto.json"],
    );
    expect(outcome).toMatchObject({ ok: true, source: "path", fileName: "pedro-score-and-park-3.auto.json", warnings: [] });
  });

  it("names every wrong field of a file that cannot be imported", () => {
    const outcome = importAutoFile("gap.path.json", fixture("path/broken/piecewise-gap.path.json"), field, []);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.path)).toContain("steps[2].heading.ranges[1].startT");
  });

  it("opens a trajectory.json as an auto, so it can be saved to the library and shared", () => {
    const outcome = importAutoFile("meepmeep.trajectory.json", fixture("trajectory/meepmeep-line-and-turn.trajectory.json"), field, []);
    expect(outcome).toMatchObject({ ok: true, source: "trajectory", fileName: "meepmeep.auto.json" });
    if (!outcome.ok) return;
    expect(outcome.auto.steps.map((step) => step.kind)).toEqual(["path", "wait", "path"]);
    expect(outcome.warnings.some((warning) => warning.includes("timed from this project's robot.json"))).toBe(true);
    const text = canonicalize("auto", outcome.auto);
    expect(canonicalize("auto", loadAuto(JSON.parse(text) as unknown))).toBe(text);
  });

  it("refuses what is not JSON, what is no kind it imports, and text over the size cap", () => {
    expect(importAutoFile("notes.json", "{ not json", field, [])).toMatchObject({ ok: false });
    expect(importAutoFile("other.json", JSON.stringify({ kind: "robot" }), field, [])).toMatchObject({ ok: false });
    const huge = importAutoFile("huge.json", " ".repeat(MAX_IMPORT_BYTES + 1), field, []);
    expect(huge).toMatchObject({ ok: false, issues: [] });
    if (!huge.ok) expect(huge.message).toMatch(/^huge\.json is 16\.0 MB, larger than the 16\.0 MB an import may be, so it was not read\./);
  });

  /** The 0.1.2 UX review, F3 and F4: the folder-open wording, never the parser's own. */
  it("says a file is empty, cut off or a picture in the folder-open wording, never the parser's", () => {
    const message = (name: string, text: string): string => {
      const outcome = importAutoFile(name, text, field, []);
      if (outcome.ok) throw new Error(`${name} imported.`);
      return outcome.message;
    };
    const again = "Check that this is the file you meant, or export it again from that planner.";
    expect(message("empty.auto.json", "")).toBe(`empty.auto.json is empty. ${again}`);
    expect(message("truncated.auto.json", `{"lines": [{"name": "${"x".repeat(380)}`)).toBe(
      `truncated.auto.json is cut off: the JSON in it stops part way. ${again}`,
    );
    expect(message("picture.auto.json", "�PNG\r\n\u001a\n\0\0\0\rIHDR")).toBe(`picture.auto.json is a picture, not a JSON file. ${again}`);
    expect(message("typo.json", '{\n  "lines": [] x\n}')).toBe(`typo.json is not valid JSON (line 2, column 15). ${again}`);
  });

  it("names a Zenith file for what it is and says where it opens, instead of the Pedro sentence", () => {
    const auto = read("examples/starter/autos/first-auto.auto.json");
    const message = (name: string, text: string): string => {
      const outcome = importAutoFile(name, text, field, []);
      if (outcome.ok) throw new Error(`${name} imported.`);
      return outcome.message;
    };
    expect(message("first-auto.auto.json", auto)).toBe(
      "first-auto.auto.json is a Zenith auto, not a file from another planner. Copy it into your project's autos folder, or open its own project with Open project.",
    );
    const newer = JSON.stringify({ ...(JSON.parse(auto) as object), formatVersion: 99 });
    expect(message("newer.auto.json", newer)).toMatch(/^newer\.auto\.json was made by a newer Zenith \(auto format 99; this Zenith reads format \d+\)\. Update Zenith to open it\.$/);
    expect(message("partner.projection.json", read("examples/starter/partners/starter-partner.projection.json"))).toBe(
      "partner.projection.json is a share file, not a file from another planner. Load it in the Partners panel.",
    );
    expect(message("list.json", "[1, 2]")).toBe(
      "list.json is not a file Import reads. Import from another planner reads a Pedro Visualizer project (.pp), a path.json or a trajectory.json.",
    );
  });
});

describe("the auto names an import picks", () => {
  it("takes the stem of the file, without the interchange or auto suffix", () => {
    expect(autoNameFromFile("Score and Park.pp")).toBe("Score-and-Park");
    expect(autoNameFromFile("partner.path.json")).toBe("partner");
    expect(autoNameFromFile("!!!.json")).toBe("imported");
  });

  it("counts up past the names already taken", () => {
    expect(freeAutoName("a", [])).toBe("a");
    expect(freeAutoName("a", ["a.auto.json"])).toBe("a-2");
  });
});

describe("the Import action", () => {
  const action = ACTIONS.find((candidate) => candidate.id === "project.import");

  it("is registered for the palette, and says why it is unavailable with no project open", () => {
    expect(action).toBeDefined();
    if (action === undefined) return;
    expect(action.group).toBe("project");
    const noProject = { project: null, review: null } as unknown as Parameters<typeof tooltipHint>[1];
    expect(tooltipHint(action, noProject)).toMatch(/^Unavailable: Open a project first/);
  });
});
