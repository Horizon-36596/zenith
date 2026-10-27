/**
 * Writing waypoints.json once the editor moved, added, renamed or deleted a waypoint (issue #134).
 * As for robot.json, the renderer sends a waypoints object and nothing else: the main process loads
 * it with the schema, writes it in canonical form to the waypoints path zenith.json names, inside a
 * root the person picked, and refuses file text, invalid waypoints, a project with no waypoints
 * file, and any layout that would make it write zenith.json.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, loadWaypoints } from "@horizon36596/zenith-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeWaypoints } from "../src/main/project.js";
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

const waypointsPath = (root: string): string => join(root, "autos", "waypoints.json");
const waypointsOf = (root: string): { waypoints: Record<string, Record<string, unknown>> } =>
  JSON.parse(readFileSync(waypointsPath(root), "utf8")) as { waypoints: Record<string, Record<string, unknown>> };
const linkOf = (root: string): string => readFileSync(join(root, "zenith.json"), "utf8");

describe("writing waypoints.json", () => {
  it("writes moved waypoints in canonical form to the path zenith.json names", () => {
    const root = project();
    const waypoints = waypointsOf(root);
    waypoints.waypoints["start"] = { xIn: -36, yIn: -63, headingRad: 1.5708, provenance: "SET FROM EDITOR" };
    const note = vi.fn();
    const written = writeWaypoints(root, waypoints, note);
    expect(readFileSync(waypointsPath(root), "utf8")).toBe(written);
    expect(written).toBe(canonicalize("waypoints", loadWaypoints(waypoints)));
    expect(note).toHaveBeenCalledWith("autos/waypoints.json", written);
    expect(waypointsOf(root).waypoints["start"]?.["xIn"]).toBe(-36);
    expect(readdirSync(join(root, "autos")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses file text, arrays and other values that are not waypoints, and writes nothing", () => {
    const root = project();
    const before = readFileSync(waypointsPath(root), "utf8");
    for (const value of [before, ["start"], null, undefined, 1, true]) {
      expect(() => writeWaypoints(root, value)).toThrow(/not waypoints Zenith can save/);
    }
    const broken = waypointsOf(root);
    broken.waypoints["start"] = { xIn: "far", yIn: 0, headingRad: 0 };
    expect(() => writeWaypoints(root, broken)).toThrow(/not valid/);
    expect(readFileSync(waypointsPath(root), "utf8")).toBe(before);
  });

  it("refuses a project whose zenith.json names no waypoints file", () => {
    const root = project();
    const waypoints = waypointsOf(root);
    patchLink(root, (link) => {
      delete link["waypoints"];
    });
    expect(() => writeWaypoints(root, waypoints)).toThrow(/names no waypoints file/);
  });

  it("never writes zenith.json or outside the project", () => {
    const root = project();
    const waypoints = waypointsOf(root);
    patchLink(root, (link) => {
      link["waypoints"] = "zenith.json";
    });
    const link = linkOf(root);
    // The project no longer loads (zenith.json is not a waypoints file), or the write is refused.
    expect(() => writeWaypoints(root, waypoints)).toThrow();
    expect(linkOf(root)).toBe(link);
    patchLink(root, (next) => {
      next["waypoints"] = "../outside/waypoints.json";
    });
    expect(() => writeWaypoints(root, waypoints)).toThrow();
  });

  it("has a channel of its own that takes no path", () => {
    expect(CHANNELS.projectWriteWaypoints).toBe("zenith:project-write-waypoints");
  });
});
