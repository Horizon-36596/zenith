import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProject, simpleAuto, writeAuto } from "../testSupport.js";
import { runEstimate } from "./estimate.js";

let root = "";
let out: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zenith-estimate-"));
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("zenith estimate", () => {
  it("prints a per-step table and the total against the field's period", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    const code = runEstimate("demo", { cwd: root });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("drive");
    expect(text).toContain("shoot1");
    expect(text).toMatch(/total: .* of 30 s/);
  });

  it("prints assumptions when --explain is passed", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    const code = runEstimate("demo", { cwd: root, explain: true });
    expect(code).toBe(0);
    expect(out.join("")).toContain("assumptions:");
  });

  it("prints JSON an agent can read, including the estimate and the field period", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    const code = runEstimate("demo", { cwd: root, json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("")) as { estimate: { nominalS: number | null }; periodS: number };
    expect(parsed.periodS).toBe(30);
    expect(typeof parsed.estimate.nominalS === "number" || parsed.estimate.nominalS === null).toBe(true);
  });

  it("exits 1 and skips the estimate when the auto has a finding error", () => {
    makeProject(root);
    // Runs the robot straight through the test obstacle at (-10..10, -10..10).
    writeAuto(
      root,
      "autos",
      "crash",
      simpleAuto("crash", {
        start: { pose: { xIn: -20, yIn: 0, headingRad: 0 } },
        steps: [
          {
            id: "throughWall",
            kind: "path",
            segments: [{ kind: "line", from: "current", to: { xIn: 20, yIn: 0 } }],
            heading: { mode: "tangent" },
          },
        ],
      }),
    );
    const code = runEstimate("crash", { cwd: root });
    expect(code).toBe(1);
    expect(out.join("")).toContain("STRUCTURE");
  });

  it("resolves a bare auto name against autosDir", () => {
    makeProject(root);
    writeAuto(root, "autos", "byname", simpleAuto("byname"));
    const code = runEstimate("byname", { cwd: root, json: true });
    expect(code).toBe(0);
  });
});
