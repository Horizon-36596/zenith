import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Auto, Kind, Step } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonicalize.js";
import { check } from "./check.js";
import { loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "./load.js";
import { mirrorAuto } from "./mirror.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";

/**
 * The golden test over `examples/starter`: a real project, written by hand from the spec, loads
 * through the schema, resolves, plans and checks, and is saved on disk in canonical form.
 *
 * What is asserted here is the part that is a contract between the files: every waypoint
 * reference resolves and every command and condition the autos name is registered in
 * `robot.json`. That every starter auto validates with no errors and no warnings is asserted in
 * packages/cli/src/commands/validate.golden.test.ts, which has the BIOBUZZ season rules in force.
 */
const root = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const AUTOS = ["first-auto", "collect-and-score", "all-step-kinds", "cycle-and-park"] as const;

const read = (relative: string): unknown => JSON.parse(readFileSync(`${root}${relative}`, "utf8"));
// Git on Windows may check a file out with CRLF; the canonical form is LF.
const readText = (relative: string): string =>
  readFileSync(`${root}${relative}`, "utf8").replace(/\r\n/g, "\n");

function project() {
  const link = loadLink(read("zenith.json"));
  return {
    link,
    robot: loadRobot(read(link.robot)),
    field: loadField(read(link.field)),
    waypoints: loadWaypoints(read(link.waypoints ?? "autos/waypoints.json")),
  };
}

const loadStarterAuto = (name: string): Auto => loadAuto(read(`autos/${name}.auto.json`));

/** Every step in the auto, group members and branch arms included. */
function allSteps(steps: readonly Step[]): Step[] {
  return steps.flatMap((step) => {
    switch (step.kind) {
      case "sequence":
      case "parallel":
        return [step, ...allSteps(step.steps)];
      case "branch":
        return [step, ...allSteps(step.then), ...allSteps(step.else ?? [])];
      default:
        return [step];
    }
  });
}

describe("examples/starter", () => {
  it("loads all five kinds of file", () => {
    const { link, robot, field, waypoints } = project();
    expect(link.autosDir).toBe("autos");
    expect(robot.commands.map((command) => command.name)).toEqual(["intakeOn", "intakeOff", "spinUp", "score"]);
    expect(robot.mouths?.map((mouth) => mouth.side)).toEqual(["FRONT"]);
    expect(field.season).toBe("biobuzz");
    expect(Object.keys(waypoints.waypoints).length).toBeGreaterThan(0);
  });

  it("plans and checks every auto with no SCHEMA, HEADING_MISSING or CONTINUITY finding", () => {
    const { robot, field, waypoints } = project();
    for (const name of AUTOS) {
      const auto = loadStarterAuto(name);
      const planned = plan(resolve(auto, waypoints), robot, field);
      const findings = check(planned, null, robot, field);
      expect(planned.steps.length, name).toBe(auto.steps.length);
      for (const code of ["SCHEMA", "HEADING_MISSING", "CONTINUITY"]) {
        expect(findings.filter((finding) => finding.code === code), `${name} ${code}`).toEqual([]);
      }
    }
  });

  it("names only commands and conditions robot.json registers", () => {
    const { robot } = project();
    const commands = new Set(robot.commands.map((command) => command.name));
    const conditions = new Set((robot.conditions ?? []).map((condition) => condition.name));
    for (const name of AUTOS) {
      for (const step of allSteps(loadStarterAuto(name).steps)) {
        if (step.kind === "command") expect(commands.has(step.name), `${name} ${step.name}`).toBe(true);
        if (step.kind === "path") {
          for (const marker of step.markers ?? []) expect(commands.has(marker.command.name), marker.command.name).toBe(true);
          if (step.endCondition !== undefined) expect(conditions.has(step.endCondition.condition)).toBe(true);
        }
        if (step.kind === "wait" && step.until !== undefined) expect(conditions.has(step.until), step.until).toBe(true);
        if (step.kind === "branch") expect(conditions.has(step.condition), step.condition).toBe(true);
      }
    }
  });

  it("first-auto is drive out, one command, park", () => {
    const auto = loadStarterAuto("first-auto");
    expect(auto.steps.map((step) => `${step.kind}:${step.id ?? ""}`)).toEqual([
      "path:driveOut",
      "command:scorePreload",
      "path:park",
    ]);
  });

  it("collect-and-score has an intake marker, a deadline group with a sequence, and a wait until", () => {
    const { robot, field, waypoints } = project();
    const auto = loadStarterAuto("collect-and-score");
    const steps = allSteps(auto.steps);
    const marked = steps.filter((step) => step.kind === "path" && (step.markers ?? []).some((marker) => marker.command.name === "intakeOn"));
    expect(marked.map((step) => step.id)).toEqual(["sweepGarden"]);
    expect(steps.some((step) => step.kind === "wait" && step.until === "hopperFull")).toBe(true);

    const group = auto.steps.find((step) => step.kind === "parallel");
    expect(group?.kind === "parallel" && group.mode).toBe("deadline");
    if (group?.kind !== "parallel") return;
    expect(group.steps.find((member) => member.id === group.deadline)?.kind).toBe("path");
    const sequence = group.steps.find((member) => member.kind === "sequence");
    expect(sequence?.kind === "sequence" && sequence.steps.map((member) => member.kind)).toEqual(["wait", "command"]);

    // The sequence starts where the group does, not where the drive ends.
    const planned = plan(resolve(auto, waypoints), robot, field);
    const planGroup = planned.steps.find((step) => step.id === group.id);
    const planSequence = planGroup?.children?.find((child) => child.id === sequence?.id);
    expect(planSequence?.startPose).toEqual(planGroup?.startPose);
  });

  it("all-step-kinds uses every step kind and every parallel mode", () => {
    const steps = allSteps(loadStarterAuto("all-step-kinds").steps);
    expect(new Set(steps.map((step) => step.kind))).toEqual(new Set(["path", "command", "wait", "sequence", "parallel", "branch"]));
    const modes = steps.flatMap((step) => (step.kind === "parallel" ? [step.mode] : []));
    expect(new Set(modes)).toEqual(new Set(["all", "race", "deadline"]));
    const waits = steps.flatMap((step) => (step.kind === "wait" ? [step.seconds === undefined ? "until" : "seconds"] : []));
    expect(new Set(waits)).toEqual(new Set(["seconds", "until"]));
  });

  it("every auto mirrors to the other alliance and back unchanged", () => {
    // Every id an auto names has a BLUE counterpart, so mirroring with the season's id map never
    // throws, and mirroring twice gives the document back.
    const mirrorId = (id: string): string | null =>
      id.includes("Red") ? id.replace("Red", "Blue") : id.includes("Blue") ? id.replace("Blue", "Red") : id;
    for (const name of AUTOS) {
      const auto = loadStarterAuto(name);
      const blue = mirrorAuto(auto, "pointSymmetry", mirrorId);
      expect(blue.alliance, name).toBe("BLUE");
      expect(canonicalize("auto", mirrorAuto(blue, "pointSymmetry", mirrorId)), name).toBe(canonicalize("auto", auto));
    }
  });

  it("every shipped file round-trips byte-identically through load and save", () => {
    const { link } = project();
    const files: [string, Kind, (json: unknown) => unknown][] = [
      ["zenith.json", "link", loadLink],
      [link.robot, "robot", loadRobot],
      [link.field, "field", loadField],
      [link.waypoints ?? "autos/waypoints.json", "waypoints", loadWaypoints],
      ...AUTOS.map((name): [string, Kind, (json: unknown) => unknown] => [`autos/${name}.auto.json`, "auto", loadAuto]),
    ];
    for (const [relative, kind, load] of files) {
      const onDisk = readText(relative);
      expect(canonicalize(kind, load(JSON.parse(onDisk) as unknown)), relative).toBe(onDisk);
    }
  });

  it("every robot and waypoint number is a placeholder or set by hand", () => {
    // The public example is made up: nothing in it may claim to be measured.
    const text = readText("autos/robot.json") + readText("autos/waypoints.json");
    const provenance = [...text.matchAll(/"provenance": "([^"]*)"/g)].map((match) => match[1] ?? "");
    expect(provenance.length).toBeGreaterThan(10);
    for (const label of provenance) expect(label, label).toMatch(/^(PLACEHOLDER|SET BY HAND|SPEC)/);
    expect(text).not.toMatch(/MEASURED/);
  });
});
