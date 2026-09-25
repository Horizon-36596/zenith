/**
 * Finding 23: the web editor ignored `auto.robot`/`auto.field`, which the CLI
 * (`packages/cli/src/autoLoad.ts`) and MCP (`packages/mcp/src/findings.ts`) both honour, so the same
 * file could validate differently in the browser than at the command line. `resolveAutoOverrides`
 * is the fix: it resolves an override through the project's `ProjectBackend`, relative to the
 * project root, and falls back to the project's own robot/field when there is none or it is broken.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type Auto } from "@horizon36596/zenith-schema";
import { resolveAutoOverrides } from "./overrides";
import type { Project } from "./types";
import type { ProjectBackend, SaveResult } from "./backend";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/starter/${path}`, import.meta.url)), "utf8");

const robotAText = read("autos/robot.json");
const fieldText = read("autos/field/biobuzz.field.json");

/** A second robot file, distinguishable by its footprint, standing in for a fixture in the repo. */
const robotBText = JSON.stringify({
  ...(JSON.parse(robotAText) as Record<string, unknown>),
  footprint: {
    ...(JSON.parse(robotAText) as { footprint: Record<string, unknown> }).footprint,
    startIn: {
      lengthIn: 12,
      widthIn: 12,
      provenance: "MEASURED: fixture robot B",
    },
  },
});

function baseProject(): Project {
  return {
    source: { kind: "directory", handle: {} as FileSystemDirectoryHandle },
    name: "fixture",
    link: loadLink(JSON.parse(read("zenith.json"))),
    robot: loadRobot(JSON.parse(robotAText)),
    field: loadField(JSON.parse(fieldText)),
    waypoints: loadWaypoints(JSON.parse(read("autos/waypoints.json"))),
    autoFiles: [],
    autoTexts: {},
  };
}

/** A backend that serves fixed text for a fixed set of paths, and refuses everything else. */
function fixtureBackend(files: Record<string, string>): ProjectBackend {
  return {
    kind: "local",
    canPropose: false,
    open: () => {
      throw new Error("not used");
    },
    listAutos: () => Promise.resolve([]),
    readAuto: () => {
      throw new Error("not used");
    },
    save: (): Promise<SaveResult> => {
      throw new Error("not used");
    },
    readText: (path: string) => {
      const text = files[path];
      if (text === undefined) return Promise.reject(new Error(`no fixture file at ${path}`));
      return Promise.resolve(text);
    },
  };
}

const autoWith = (overrides: Partial<Auto>): Auto =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "overrides-fixture",
    title: "Overrides fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps: [
      {
        id: "wait",
        kind: "wait",
        seconds: 1,
      },
    ],
    ...overrides,
  });

describe("resolveAutoOverrides", () => {
  it("falls back to the project's own robot and field when the auto names no override", async () => {
    const project = baseProject();
    const backend = fixtureBackend({});
    const resolved = await resolveAutoOverrides(project, backend, autoWith({}));

    expect(resolved.robot).toBe(project.robot);
    expect(resolved.field).toBe(project.field);
    expect(resolved.error).toBeNull();
  });

  it("resolves auto.robot against a second robot file through the backend, relative to the project root", async () => {
    const project = baseProject();
    const backend = fixtureBackend({ "autos/robot-b.json": robotBText });
    const auto = autoWith({ robot: "autos/robot-b.json" });

    const resolved = await resolveAutoOverrides(project, backend, auto);

    expect(resolved.error).toBeNull();
    expect(resolved.robot).not.toBe(project.robot);
    expect(resolved.robot.footprint.startIn.lengthIn).toBe(12);
    // The field carries no override, so it still falls back to the project's.
    expect(resolved.field).toBe(project.field);
  });

  it("resolves auto.field the same way, independently of auto.robot", async () => {
    const project = baseProject();
    const secondField = JSON.stringify({
      ...(JSON.parse(fieldText) as Record<string, unknown>),
      name: "practice",
    });
    const backend = fixtureBackend({ "autos/field/practice.field.json": secondField });
    const auto = autoWith({ field: "autos/field/practice.field.json" });

    const resolved = await resolveAutoOverrides(project, backend, auto);

    expect(resolved.error).toBeNull();
    expect(resolved.field.name).toBe("practice");
    expect(resolved.robot).toBe(project.robot);
  });

  it("falls back and reports an error when the named override cannot be read", async () => {
    const project = baseProject();
    const backend = fixtureBackend({});
    const auto = autoWith({ robot: "autos/does-not-exist.json" });

    const resolved = await resolveAutoOverrides(project, backend, auto);

    expect(resolved.robot).toBe(project.robot);
    expect(resolved.error).not.toBeNull();
    expect(resolved.error).toContain("autos/does-not-exist.json");
  });

  it("falls back and reports an error when the named override fails its own schema", async () => {
    const project = baseProject();
    const backend = fixtureBackend({ "autos/broken-robot.json": JSON.stringify({ not: "a robot" }) });
    const auto = autoWith({ robot: "autos/broken-robot.json" });

    const resolved = await resolveAutoOverrides(project, backend, auto);

    expect(resolved.robot).toBe(project.robot);
    expect(resolved.error).not.toBeNull();
  });
});
