/**
 * The skeleton files `zenith init`, `zenith new` and the editor's Set up write (issue #159). They live
 * in core so the CLI and the app write the same files; each must load with the current schema, be
 * canonical, and carry a provenance on every number (CLAUDE.md rule 4).
 */
import { FORMAT_VERSIONS } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonicalize.js";
import { STARTER_CODEGEN_SECTION } from "./codegen/javaCodegen.js";
import { loadAuto, loadLink, loadRobot, loadWaypoints } from "./load.js";
import { autoSkeleton, linkSkeleton, robotSkeleton, skeletonRobot, waypointsSkeleton } from "./skeletons.js";

/**
 * Every number in `value` with the path to it, and the provenance of the object that holds it. The
 * file's `formatVersion` is the format's, not a constant about the robot, so it is left out.
 */
function numbers(value: unknown, path = ""): Array<{ path: string; provenance: unknown }> {
  if (Array.isArray(value)) return value.flatMap((item, index) => numbers(item, `${path}[${String(index)}]`));
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  return Object.entries(record).flatMap(([key, item]) => {
    if (path === "" && key === "formatVersion") return [];
    return typeof item === "number" ? [{ path: `${path}.${key}`, provenance: record["provenance"] }] : numbers(item, `${path}.${key}`);
  });
}

describe("linkSkeleton", () => {
  it("loads with the current schema, is canonical, and names no library, robot class or sim", () => {
    const text = linkSkeleton();
    const link = loadLink(JSON.parse(text));
    expect(canonicalize("link", link)).toBe(text);
    expect(link.formatVersion).toBe(FORMAT_VERSIONS.link);
    expect(link.deploy?.commandLibrary).toBeUndefined();
    expect(link.deploy?.robotClass).toBeUndefined();
    expect(link.sim).toBeUndefined();
    expect(link.field).toBe("autos/field/biobuzz.field.json");
  });

  it("writes the codegen section by default, as zenith init does (issue #156), and leaves it out when asked", () => {
    expect(loadLink(JSON.parse(linkSkeleton())).codegen).toEqual(STARTER_CODEGEN_SECTION);
    expect(loadLink(JSON.parse(linkSkeleton({ codegen: false }))).codegen).toBeUndefined();
  });

  it("writes the command library and robot class it is given", () => {
    const link = loadLink(
      JSON.parse(linkSkeleton({ commandLibrary: "ivy", robotClass: "org.firstinspires.ftc.teamcode.robot.TeamRobot" })),
    );
    expect(link.deploy?.commandLibrary).toBe("ivy");
    expect(link.deploy?.robotClass).toBe("org.firstinspires.ftc.teamcode.robot.TeamRobot");
  });

  it("refuses a robot class that is not a Java class name, through the schema", () => {
    expect(() => linkSkeleton({ robotClass: "not a class; rm -rf" })).toThrow();
  });
});

describe("robotSkeleton", () => {
  it("loads with the current schema, is canonical, and has no commands yet", () => {
    const text = robotSkeleton("team-robot");
    const robot = loadRobot(JSON.parse(text));
    expect(canonicalize("robot", robot)).toBe(text);
    expect(robot.name).toBe("team-robot");
    expect(robot.commands).toEqual([]);
    expect(robot.conditions).toEqual([]);
    expect(skeletonRobot("team-robot")).toEqual(robot);
  });

  it("gives every number a NEEDS MEASUREMENT provenance that says what wrote it", () => {
    const found = numbers(JSON.parse(robotSkeleton("team-robot")));
    expect(found.length).toBeGreaterThan(0);
    for (const { path, provenance } of found) expect(provenance, path).toBe("NEEDS MEASUREMENT: written by zenith init");
    for (const { path, provenance } of numbers(JSON.parse(robotSkeleton("team-robot", "the editor's Set up")))) {
      expect(provenance, path).toBe("NEEDS MEASUREMENT: written by the editor's Set up");
    }
  });
});

describe("waypointsSkeleton", () => {
  it("loads with the current schema, is canonical, and its start carries a provenance", () => {
    const text = waypointsSkeleton();
    const waypoints = loadWaypoints(JSON.parse(text));
    expect(canonicalize("waypoints", waypoints)).toBe(text);
    expect(Object.keys(waypoints.waypoints)).toEqual(["start"]);
    expect(waypoints.waypoints["start"]?.provenance).toMatch(/^NEEDS MEASUREMENT: written by zenith init/);
    expect(loadWaypoints(JSON.parse(waypointsSkeleton("the editor's Set up"))).waypoints["start"]?.provenance).toMatch(
      /^NEEDS MEASUREMENT: written by the editor's Set up/,
    );
  });
});

describe("autoSkeleton", () => {
  it("loads with the current schema in the current format, is canonical, and every number carries a provenance", () => {
    for (const alliance of ["RED", "BLUE"] as const) {
      const text = autoSkeleton("first-auto", alliance);
      const auto = loadAuto(JSON.parse(text));
      expect(canonicalize("auto", auto), alliance).toBe(text);
      expect(auto.formatVersion, alliance).toBe(FORMAT_VERSIONS.auto);
      expect(auto.alliance, alliance).toBe(alliance);
      for (const { path, provenance } of numbers(JSON.parse(text))) {
        expect(provenance, `${alliance} ${path}`).toMatch(/^(NEEDS MEASUREMENT|PLACEHOLDER): written by zenith new/);
      }
    }
  });

  it("mirrors the RED skeleton for BLUE, and says what wrote it", () => {
    expect(loadAuto(JSON.parse(autoSkeleton("a", "RED"))).start.pose).toMatchObject({ xIn: -12, yIn: -63, headingRad: 1.5708 });
    expect(loadAuto(JSON.parse(autoSkeleton("a", "BLUE"))).start.pose).toMatchObject({ xIn: 12, yIn: 63, headingRad: -1.5708 });
    const setUp = autoSkeleton("first-auto", "RED", "pointSymmetry", "the editor's Set up");
    expect(setUp).toContain("NEEDS MEASUREMENT: written by the editor's Set up");
    expect(setUp).not.toContain("zenith new");
  });
});
