/**
 * Writing robot.json from the Settings window's Robot and Commands sections (issues #100 and #101).
 * The renderer sends a robot object and nothing else: the main process loads it with the schema,
 * writes it in canonical form to the robot path zenith.json names, inside a root the person picked,
 * and refuses file text, invalid robots, roots it was not given, and any layout that would make it
 * write zenith.json, which holds sim.command.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, loadRobot } from "@horizon36596/zenith-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RootRegistry } from "../src/main/confine.js";
import { writeRobot } from "../src/main/project.js";
import { CHANNELS } from "../src/shared/channels.js";
import { exampleProject, patchLink } from "./support.js";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function project(): string {
  const made = exampleProject();
  cleanup = made.cleanup;
  return made.root;
}

const robotPath = (root: string): string => join(root, "autos", "robot.json");
const robotOf = (root: string): Record<string, unknown> => JSON.parse(readFileSync(robotPath(root), "utf8")) as Record<string, unknown>;
const linkOf = (root: string): string => readFileSync(join(root, "zenith.json"), "utf8");

describe("writing robot.json", () => {
  it("writes a changed robot in canonical form to the path zenith.json names", () => {
    const root = project();
    const robot = robotOf(root);
    const kinematics = robot["kinematics"] as Record<string, { value: number; provenance?: string }>;
    kinematics["maxForwardVelInPerS"] = { value: 55, provenance: "MEASURED: velocity tuner" };
    const note = vi.fn();
    const written = writeRobot(root, robot, note);
    expect(readFileSync(robotPath(root), "utf8")).toBe(written);
    expect(written).toBe(canonicalize("robot", loadRobot(robot)));
    expect(note).toHaveBeenCalledWith("autos/robot.json", written);
    const again = robotOf(root);
    expect((again["kinematics"] as Record<string, { value: number }>)["maxForwardVelInPerS"]?.value).toBe(55);
    expect(readdirSync(join(root, "autos")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses file text, arrays and other values that are not a robot object, and writes nothing", () => {
    const root = project();
    const before = readFileSync(robotPath(root), "utf8");
    for (const value of [before, JSON.stringify(robotOf(root)), ["robot"], null, undefined, 1, true]) {
      expect(() => writeRobot(root, value)).toThrow(/not a robot Zenith can save/);
    }
    expect(readFileSync(robotPath(root), "utf8")).toBe(before);
  });

  it("refuses a robot the schema does not accept", () => {
    const root = project();
    const before = readFileSync(robotPath(root), "utf8");
    const broken = robotOf(root);
    (broken["footprint"] as Record<string, unknown>)["startIn"] = { lengthIn: -1, widthIn: 18 };
    expect(() => writeRobot(root, broken)).toThrow(/not valid/);
    const noCommands = robotOf(root);
    delete noCommands["commands"];
    expect(() => writeRobot(root, noCommands)).toThrow(/not valid/);
    const badEstimate = robotOf(root);
    (badEstimate["commands"] as Array<Record<string, unknown>>)[0]!["estimateS"] = "require('child_process')";
    expect(() => writeRobot(root, badEstimate)).toThrow(/not valid/);
    expect(readFileSync(robotPath(root), "utf8")).toBe(before);
  });

  it("never writes zenith.json, even when zenith.json names itself as the robot", () => {
    const root = project();
    const robot = robotOf(root);
    patchLink(root, (link) => {
      link["robot"] = "zenith.json";
    });
    const link = linkOf(root);
    // The project no longer loads (zenith.json is not a robot), or the write is refused outright.
    expect(() => writeRobot(root, robot)).toThrow();
    expect(linkOf(root)).toBe(link);
  });

  it("refuses a robot path that is not a JSON file or leaves the project", () => {
    const root = project();
    const robot = robotOf(root);
    writeFileSync(join(root, "robot.txt"), readFileSync(robotPath(root), "utf8"), "utf8");
    patchLink(root, (link) => {
      link["robot"] = "robot.txt";
    });
    expect(() => writeRobot(root, robot)).toThrow();
    patchLink(root, (link) => {
      link["robot"] = "../outside/robot.json";
    });
    expect(() => writeRobot(root, robot)).toThrow();
  });

  it("is reached only through a granted root, by a channel that takes no path", () => {
    const roots = new RootRegistry();
    expect(() => roots.assert(project())).toThrow(/folder picker/);
    expect(Object.values(CHANNELS)).toContain("zenith:project-write-robot");
    expect(Object.keys(CHANNELS).some((name) => /link|writeFile|writeText/i.test(name))).toBe(false);
  });
});
