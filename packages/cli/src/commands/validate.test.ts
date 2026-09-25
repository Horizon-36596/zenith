import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProject } from "../project.js";
import { makeProject, simpleAuto, writeAuto } from "../testSupport.js";
import { runValidate, validateAuto } from "./validate.js";

let root = "";
let out: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zenith-validate-"));
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

describe("finding 26: a schema error's stepId is the step's own id, not the raw JSON path", () => {
  it("reports the offending path step's id for too many Bezier control points, keeping the JSON path in the message", () => {
    makeProject(root);
    writeAuto(
      root,
      "autos",
      "bad-bezier",
      simpleAuto("bad-bezier", {
        steps: [
          {
            id: "curvyLeg",
            kind: "path",
            segments: [
              {
                kind: "bezier",
                control: [
                  { xIn: 0, yIn: 0, headingRad: 0 },
                  { xIn: 5, yIn: 5, headingRad: 0 },
                  { xIn: 10, yIn: 10, headingRad: 0 },
                  { xIn: 15, yIn: 15, headingRad: 0 }, // one more than MAX_BEZIER_CONTROL_POINTS (3)
                ],
              },
            ],
            heading: { mode: "tangent" },
          },
        ],
      }),
    );
    const project = loadProject(root);
    const result = validateAuto(join(root, "autos/bad-bezier.auto.json"), project);
    const schemaFindings = result.findings.filter((finding) => finding.code === "SCHEMA");
    expect(schemaFindings.length).toBeGreaterThan(0);
    // The step has its own id ("curvyLeg"); stepId must be that, not the raw "steps.0.segments.0.control".
    expect(schemaFindings.every((finding) => finding.stepId === "curvyLeg")).toBe(true);
    // The JSON path is not lost — it still lives in the message, for a human or an agent reading detail.
    expect(schemaFindings.some((finding) => finding.message.startsWith("steps.0"))).toBe(true);
  });

  it("falls back to the step's positional id when the offending step itself has no id", () => {
    makeProject(root);
    writeAuto(
      root,
      "autos",
      "bad-anon",
      simpleAuto("bad-anon", {
        steps: [
          {
            // no "id": the schema allows an unnamed step, and effectiveId's convention is step<n>.
            kind: "path",
            segments: [{ kind: "line", from: "current", to: { xIn: 10, yIn: 10 } }],
            heading: { mode: "tangent" },
            speedFraction: 1.5, // out of range: z.number().positive().max(1)
          },
        ],
      }),
    );
    const project = loadProject(root);
    const result = validateAuto(join(root, "autos/bad-anon.auto.json"), project);
    const schemaFindings = result.findings.filter((finding) => finding.code === "SCHEMA");
    expect(schemaFindings.length).toBeGreaterThan(0);
    expect(schemaFindings[0]?.stepId).toBe("step1");
    expect(schemaFindings[0]?.message).toContain("steps.0.speedFraction");
  });
});

describe("finding 27: validate resolves an auto relative to its project, not the shell's cwd", () => {
  it("the documented command shape works: a project-relative auto argument with an explicit --project run from elsewhere", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    const elsewhere = mkdtempSync(join(tmpdir(), "zenith-validate-elsewhere-"));
    try {
      // Mirrors `pnpm zenith -- validate autos/first-auto.auto.json --project examples/starter`
      // run from the repository root: the auto argument is relative to --project, not to cwd.
      const code = runValidate(["autos/demo.auto.json"], { cwd: elsewhere, project: root });
      expect(code).toBe(0);
      expect(out.join("")).not.toContain("Cannot read");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("without --project, walks up from the auto argument itself to find the project when cwd has no zenith.json above it", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    const elsewhere = mkdtempSync(join(tmpdir(), "zenith-validate-elsewhere-"));
    try {
      const autoAbsolute = join(root, "autos", "demo.auto.json");
      const code = runValidate([autoAbsolute], { cwd: elsewhere });
      expect(code).toBe(0);
      expect(out.join("")).not.toContain("No zenith.json");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
