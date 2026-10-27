import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import type { Finding } from "@horizon36596/zenith-core";
import type { Link } from "@horizon36596/zenith-schema";
import { derive } from "../state/derived";
import { NO_ROBOT_CLASS_EXPORT_MESSAGE } from "@horizon36596/zenith-core";
import {
  CODEGEN_SECTION_JSON,
  codeViewOf,
  linesOfStep,
  NO_CODEGEN_LINE,
  NO_LIBRARY_LINE,
  NO_PLAN_LINE,
  routineLine,
  sourcePathOf,
  stepAtLine,
} from "./codeView";

/**
 * The Code tab runs the CLI's generator in the browser. The strongest check that it shows what
 * `zenith codegen` writes is the starter's checked-in output (`examples/starter/generated/`, kept in
 * step with the CLI by `starterJava.golden.test.ts`): the tab's text must be those files byte for
 * byte, sha and source path included, through the same derive pipeline the editor runs.
 */
const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const text = (path: string): string => readFileSync(`${starter}${path}`, "utf8").replace(/\r\n/g, "\n");
const json = (path: string): unknown => JSON.parse(text(path));

const link = loadLink(json("zenith.json"));
const robot = loadRobot(json("autos/robot.json"));
const field = loadField(json("autos/field/biobuzz.field.json"));
const waypoints = loadWaypoints(json("autos/waypoints.json"));
const FILE = "cycle-and-park.auto.json";
const auto = loadAuto(json(`autos/${FILE}`));
const derived = derive(auto, robot, field, waypoints);

const withLibrary = (library: "solverslib" | "ivy"): Link => ({
  ...link,
  deploy: { ...(link.deploy as NonNullable<Link["deploy"]>), commandLibrary: library },
});

describe("codeViewOf on the starter's cycle-and-park", () => {
  for (const library of ["solverslib", "ivy"] as const) {
    it(`is byte for byte the checked-in ${library} class`, () => {
      const view = codeViewOf({ link: withLibrary(library), fileName: FILE, auto, plan: derived.plan, findings: derived.findings });
      expect(view.kind).toBe("code");
      if (view.kind !== "code") return;
      expect(view.fileName).toBe("CycleAndParkGenerated.java");
      expect(view.text).toBe(text(`generated/${library}/CycleAndParkGenerated.java`));
    });
  }

  it("maps every top-level step to the line that calls it", () => {
    const view = codeViewOf({ link, fileName: FILE, auto, plan: derived.plan, findings: derived.findings });
    if (view.kind !== "code") throw new Error("expected code");
    const lines = view.text.split("\n");
    for (const step of derived.plan?.steps ?? []) {
      const owned = [...linesOfStep(view.stepLines, step.id)];
      expect(owned.length, step.id).toBeGreaterThan(0);
      expect(owned.some((line) => (lines[line - 1] ?? "").includes(`step("${step.id}", `))).toBe(true);
      for (const line of owned) expect(stepAtLine(view.stepLines, line)).toBe(step.id);
    }
    // The package line belongs to no step.
    expect(stepAtLine(view.stepLines, 3)).toBeNull();
    expect(linesOfStep(view.stepLines, undefined).size).toBe(0);
  });

  it("finds the line that declares buildRoutine(), where the tab starts with no step selected (issue #413)", () => {
    for (const library of ["solverslib", "ivy"] as const) {
      const view = codeViewOf({ link: withLibrary(library), fileName: FILE, auto, plan: derived.plan, findings: derived.findings });
      if (view.kind !== "code") throw new Error("expected code");
      const at = routineLine(view.text);
      expect(at, library).not.toBeNull();
      expect(view.text.split("\n")[(at ?? 0) - 1]).toMatch(/protected \w+ buildRoutine\(\) \{/);
      // Past the licence, the package and the imports.
      expect(at ?? 0).toBeGreaterThan(10);
    }
    expect(routineLine("class A {}\n")).toBeNull();
  });
});

describe("codeViewOf refuses as zenith codegen does", () => {
  const error: Finding = { severity: "error", stepId: "x", code: "SCHEMA", message: "Broken." };

  it("says the auto has errors in the editor's words, and offers to show them (0.1.2 UX review)", () => {
    const view = codeViewOf({ link, fileName: FILE, auto, plan: derived.plan, findings: [error, error] });
    expect(view).toEqual({ kind: "blocked", message: "No code while the auto has 2 errors.", settings: false, errors: true });
    expect(codeViewOf({ link, fileName: FILE, auto, plan: derived.plan, findings: [error] })).toMatchObject({ message: "No code while the auto has 1 error." });
  });

  it("says how many of the errors are in features the settings hide, since the Problems header does not count them", () => {
    const view = (hiddenErrors: number, count = 4) =>
      codeViewOf({ link, fileName: FILE, auto, plan: derived.plan, findings: Array.from({ length: count }, () => error), hiddenErrors });
    expect(view(2)).toMatchObject({ message: "No code while the auto has 4 errors. 2 of them are in features your settings hide." });
    expect(view(1)).toMatchObject({ message: "No code while the auto has 4 errors. 1 of them is in features your settings hide." });
    expect(view(4)).toMatchObject({ message: "No code while the auto has 4 errors. All of them are in features your settings hide." });
    expect(view(1, 1)).toMatchObject({ message: "No code while the auto has 1 error. It is in features your settings hide." });
  });

  it("offers to turn the hiding features on, not to show a Problems list with none of the errors in it", () => {
    const view = (hiddenErrors: number) =>
      codeViewOf({ link, fileName: FILE, auto, plan: derived.plan, findings: [error, error], hiddenErrors });
    expect(view(1)).toMatchObject({ errors: true });
    expect(view(1)).not.toHaveProperty("hiddenErrors");
    expect(view(2)).toMatchObject({ hiddenErrors: true });
    expect(view(2)).not.toHaveProperty("errors");
  });

  it("points to Settings when zenith.json names no command library", () => {
    const { commandLibrary: _dropped, ...deploy } = link.deploy as NonNullable<Link["deploy"]>;
    const view = codeViewOf({ link: { ...link, deploy }, fileName: FILE, auto, plan: derived.plan, findings: [] });
    expect(view).toEqual({ kind: "blocked", message: NO_LIBRARY_LINE, settings: true });
    expect(NO_LIBRARY_LINE).toContain("Settings");
  });

  it("says so when zenith.json has no codegen section", () => {
    const { codegen: _dropped, ...rest } = link;
    const view = codeViewOf({ link: rest, fileName: FILE, auto, plan: derived.plan, findings: [] });
    expect(view).toEqual({ kind: "blocked", message: NO_CODEGEN_LINE, settings: false, json: CODEGEN_SECTION_JSON });
    expect(NO_CODEGEN_LINE).toContain('zenith.json has no "codegen" section');
  });

  it("gives the exact JSON to add when zenith.json has no codegen section (issue #156)", () => {
    expect(CODEGEN_SECTION_JSON).toBe(
      ['"codegen": {', '  "package": "org.firstinspires.ftc.teamcode.zenith",', '  "dir": "TeamCode/src/main/java"', "}"].join("\n"),
    );
    // Added to a zenith.json that has none, it is a codegen section the Code tab then uses.
    const { codegen: _dropped, ...rest } = link;
    const added = loadLink({ ...(JSON.parse(`{${CODEGEN_SECTION_JSON}}`) as object), ...rest });
    expect(added.codegen).toEqual({ package: "org.firstinspires.ftc.teamcode.zenith", dir: "TeamCode/src/main/java" });
    expect(codeViewOf({ link: added, fileName: FILE, auto, plan: derived.plan, findings: [] }).kind).toBe("code");
  });

  it("says there is nothing to show when the auto does not plan", () => {
    expect(codeViewOf({ link, fileName: FILE, auto, plan: null, findings: [] })).toEqual({
      kind: "blocked",
      message: NO_PLAN_LINE,
      settings: false,
    });
  });
});

describe("sourcePathOf", () => {
  it("joins the autos folder and the file name with one slash", () => {
    expect(sourcePathOf("autos", "a.auto.json")).toBe("autos/a.auto.json");
    expect(sourcePathOf("./autos/", "a.auto.json")).toBe("autos/a.auto.json");
    expect(sourcePathOf("src\\autos", "a.auto.json")).toBe("src/autos/a.auto.json");
    expect(sourcePathOf(".", "a.auto.json")).toBe("a.auto.json");
  });
});

describe("the exported form (issues #534, #535)", () => {
  for (const library of ["solverslib", "ivy"] as const) {
    it(`is byte for byte the checked-in exported ${library} OpMode`, () => {
      const view = codeViewOf({
        link: withLibrary(library),
        fileName: FILE,
        auto,
        plan: derived.plan,
        findings: derived.findings,
        form: "export",
      });
      expect(view.kind).toBe("code");
      if (view.kind !== "code") return;
      expect(view.form).toBe("export");
      expect(view.fileName).toBe("CycleAndParkExported.java");
      expect(view.text).toBe(text(`generated/${library}/CycleAndParkExported.java`));
    });
  }

  it("shows the reference class when no form is asked for", () => {
    const view = codeViewOf({ link, fileName: FILE, auto, plan: derived.plan, findings: derived.findings });
    expect(view.kind === "code" && view.form).toBe("reference");
  });

  it("refuses the export, in the CLI's words, when zenith.json names no robot class", () => {
    const deploy = { ...(link.deploy as NonNullable<Link["deploy"]>) };
    delete deploy.robotClass;
    const view = codeViewOf({
      link: { ...link, deploy },
      fileName: FILE,
      auto,
      plan: derived.plan,
      findings: derived.findings,
      form: "export",
    });
    expect(view).toEqual({ kind: "blocked", message: NO_ROBOT_CLASS_EXPORT_MESSAGE, settings: false });
  });
});
