import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { confinePath, resolveAutoPath, resolveProject, type Project } from "./project.js";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zenith-mcp-project-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, content: unknown): void {
  const full = join(root, relative);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
}

/** A minimal, valid project so resolveProject() can load it. */
function makeProject(): void {
  write("zenith.json", {
    $schema: SCHEMA_ID.link,
    formatVersion: 1,
    autosDir: "autos",
    robot: "autos/robot.json",
    field: "autos/field/field.json",
  });
  write("autos/robot.json", {
    $schema: SCHEMA_ID.robot,
    formatVersion: 1,
    name: "Test robot",
    frame: { forward: "+x", left: "+y", headingZero: "+x", headingPositive: "ccw" },
    footprint: {
      startIn: { lengthIn: 18, widthIn: 14, provenance: "PLACEHOLDER: test fixture" },
      expandedIn: { lengthIn: 18, widthIn: 14, provenance: "PLACEHOLDER: test fixture" },
      centreOfRotationIn: { xIn: 0, yIn: 0 },
    },
    heightIn: 18,
    kinematics: {
      maxForwardVelInPerS: { value: 60, provenance: "PLACEHOLDER: test fixture" },
      maxStrafeVelInPerS: { value: 50, provenance: "PLACEHOLDER: test fixture" },
      forwardDecelInPerS2: { value: 60, provenance: "PLACEHOLDER: test fixture" },
      strafeDecelInPerS2: { value: 40, provenance: "PLACEHOLDER: test fixture" },
      accelInPerS2: { value: 90, provenance: "PLACEHOLDER: test fixture" },
      maxAngularVelRadPerS: { value: 6, provenance: "PLACEHOLDER: test fixture" },
      defaultPathSpeedFraction: { value: 0.8, provenance: "SET BY HAND: test fixture" },
      settleS: { value: 0.25, provenance: "PLACEHOLDER: test fixture" },
      follower: { library: "pedro", version: "3.0.0-20260828.185437-17", holdEnd: true },
    },
    commands: [],
  });
  write("autos/field/field.json", {
    $schema: SCHEMA_ID.field,
    formatVersion: 1,
    season: "test",
    name: "Test field",
    frame: {
      origin: "centre",
      xAxis: "audienceRight",
      yAxis: "awayFromAudience",
      headingZero: "+x",
      headingPositive: "ccw",
      units: "in",
      canonicalAlliance: "RED",
      mirror: "pointSymmetry",
    },
    sizeIn: { xIn: 144, yIn: 144 },
    periods: { autoS: 30, teleopS: 120 },
    obstacles: [],
  });
}

describe("finding 2: confinePath", () => {
  it("resolves a plain relative path inside root", () => {
    const resolved = confinePath(root, "autos/demo.auto.json");
    expect(resolved).toBe(join(root, "autos/demo.auto.json"));
  });

  it("refuses the exact escape shape from the review (../../../../etc/passwd)", () => {
    expect(() => confinePath(root, "../../../../etc/passwd")).toThrow(/resolves outside the project root/);
  });

  it("refuses an absolute path outside root", () => {
    const outside = mkdtempSync(join(tmpdir(), "zenith-mcp-outside-"));
    try {
      expect(() => confinePath(root, join(outside, "secret.json"))).toThrow(/resolves outside the project root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("accepts an absolute path that happens to be inside root", () => {
    const inside = join(root, "autos", "demo.auto.json");
    expect(confinePath(root, inside)).toBe(inside);
  });
});

describe("finding 2: resolveAutoPath", () => {
  let project: Project;

  beforeEach(() => {
    makeProject();
    project = resolveProject(root);
  });

  it("resolves a bare name against autosDir, confined to root", () => {
    const resolved = resolveAutoPath(project, "demo");
    expect(resolved).toBe(join(root, "autos", "demo.auto.json"));
  });

  it("refuses the exact ../../../../ traversal input from the review, given as a bare-looking name", () => {
    expect(() => resolveAutoPath(project, "../../../../etc/passwd")).toThrow(/resolves outside the project root/);
  });

  it("refuses a traversal that reaches the review's escape shape via a slash-bearing relative path", () => {
    expect(() => resolveAutoPath(project, "../../../../outside/.gitconfig")).toThrow(
      /resolves outside the project root/,
    );
  });

  it("refuses an absolute path outside root even though resolveAutoPath's absolute branch looks like it should pass it through", () => {
    const outside = mkdtempSync(join(tmpdir(), "zenith-mcp-outside-"));
    try {
      const evil = join(outside, "evil.auto.json");
      writeFileSync(evil, "{}", "utf8");
      expect(() => resolveAutoPath(project, evil)).toThrow(/resolves outside the project root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("still accepts a project-relative path with a slash, confined to root", () => {
    write("autos/nested/demo.auto.json", "{}");
    const resolved = resolveAutoPath(project, "autos/nested/demo.auto.json");
    expect(resolved).toBe(join(root, "autos/nested/demo.auto.json"));
  });
});
