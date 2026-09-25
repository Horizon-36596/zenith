import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProject, simpleAuto, writeAuto } from "../testSupport.js";
import { runCalibrate } from "./calibrate.js";

let root = "";
let out: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zenith-calibrate-"));
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

/** A trace with one path-step sample ("drive", matching testSupport's `simpleAuto`) that took
 * `actualS` seconds, plus the trailing command step the fit ignores (it is not a path step). */
function traceFile(autoName: string, actualS: number): Record<string, unknown> {
  return {
    formatVersion: 1,
    auto: autoName,
    simTimeS: actualS + 0.6,
    tickS: 0.02,
    capabilities: ["steps", "poses"],
    steps: [
      { id: "drive", startS: 0, endS: actualS, interrupted: false },
      { id: "shoot1", startS: actualS, endS: actualS + 0.6, interrupted: false },
    ],
    poses: [],
    truthPoses: [],
    structureContacts: [],
    ledger: [],
    events: [],
  };
}

const writeTrace = (dir: string, name: string, doc: Record<string, unknown>): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.trace.json`), `${JSON.stringify(doc, null, 2)}\n`, "utf8");
};

describe("zenith calibrate", () => {
  it("throws a clear error when there is nowhere to look for traces", () => {
    makeProject(root, { sim: undefined });
    expect(() => runCalibrate({ cwd: root })).toThrow(/traces/);
  });

  it("fits accel and settle from a trace and reports the residual band, without writing by default", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    writeTrace(join(root, "sim"), "demo", traceFile("demo", 0.6));

    const code = runCalibrate({ cwd: root });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("accelInPerS2:");
    expect(text).toContain("settleS:");
    expect(text).toContain("residual band:");
    expect(text).toContain("not written (pass --write)");
  });

  it("--write updates robot.json's kinematics with a CALIBRATED FROM SIM provenance", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    writeTrace(join(root, "sim"), "demo", traceFile("demo", 0.6));

    const code = runCalibrate({ cwd: root, write: true, date: "2026-09-21" });
    expect(code).toBe(0);
    const robot = JSON.parse(readFileSync(join(root, "autos/robot.json"), "utf8")) as {
      kinematics: { accelInPerS2: { provenance: string }; settleS: { provenance: string } };
    };
    expect(robot.kinematics.accelInPerS2.provenance).toBe("CALIBRATED FROM SIM 2026-09-21 (1 steps)");
    expect(robot.kinematics.settleS.provenance).toBe("CALIBRATED FROM SIM 2026-09-21 (1 steps)");
  });

  it("--traces overrides the default directory", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    writeTrace(join(root, "custom-traces"), "demo", traceFile("demo", 0.6));

    const code = runCalibrate({ cwd: root, traces: "custom-traces" });
    expect(code).toBe(0);
    expect(out.join("")).toContain("custom-traces");
  });

  it("skips a trace file that does not parse and reports why, but still fits the rest", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    writeTrace(join(root, "sim"), "demo", traceFile("demo", 0.6));
    mkdirSync(join(root, "sim"), { recursive: true });
    writeFileSync(join(root, "sim", "broken.trace.json"), "{ not json", "utf8");

    const code = runCalibrate({ cwd: root, json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("")) as { skipped: { file: string; reason: string }[]; fit: { sampleCount: number } };
    expect(parsed.skipped.some((entry) => entry.file === "broken.trace.json")).toBe(true);
    expect(parsed.fit.sampleCount).toBe(1);
  });

  it("reports zero samples and writes nothing when no trace matches an existing auto", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    writeTrace(join(root, "sim"), "other", traceFile("other", 0.6));

    const code = runCalibrate({ cwd: root, write: true });
    expect(code).toBe(0);
    expect(out.join("")).toContain("no path-step samples to fit");
  });
});
