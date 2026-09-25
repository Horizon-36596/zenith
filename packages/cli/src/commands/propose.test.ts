import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProject, simpleAuto, writeAuto } from "../testSupport.js";
import { runPropose } from "./propose.js";

let root = "";
let out: string[] = [];
let errOut: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zenith-propose-"));
  out = [];
  errOut = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    errOut.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("zenith propose", () => {
  it("without --dry-run, names the alternative and exits 2 (GitHub mode is not this package's)", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    const code = runPropose("demo", { cwd: root });
    expect(code).toBe(2);
    expect(errOut.join("")).toContain("--dry-run");
  });

  it("--dry-run blocks on a finding error before touching core.render", () => {
    makeProject(root);
    writeAuto(
      root,
      "autos",
      "bad",
      simpleAuto("bad", {
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
    const code = runPropose("bad", { cwd: root, dryRun: true });
    expect(code).toBe(1);
    expect(existsSync(join(root, "autos/.renders"))).toBe(false);
  });

  it("--dry-run either renders and prints the PR body (core.render landed) or the core M1 gate message (it has not)", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    const code = runPropose("demo", { cwd: root, dryRun: true });

    if (code === 0) {
      expect(existsSync(join(root, "autos/.renders/demo.svg"))).toBe(true);
      expect(out.join("")).toContain("demo");
    } else {
      expect(code).toBe(2);
      expect(errOut.join("") + out.join("")).toContain("core M1 not landed yet");
    }
  });

  it("--dry-run --json either prints the render path and body, or the error, an agent can parse", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    const code = runPropose("demo", { cwd: root, dryRun: true, json: true });
    const parsed = JSON.parse(out.join("")) as Record<string, unknown>;

    if (code === 0) {
      expect(parsed.render).toBe("autos/.renders/demo.svg");
      expect(typeof parsed.body).toBe("string");
    } else {
      expect(code).toBe(2);
      expect(typeof parsed.error).toBe("string");
    }
  });

  it("finding 14: rejects an auto.name with a path traversal segment before it is ever used as a render path", () => {
    makeProject(root);
    writeAuto(root, "autos", "escape", simpleAuto("../../../../ESCAPED"));

    const code = runPropose("escape", { cwd: root, dryRun: true });
    expect(code).toBe(1);
    expect(out.join("")).toContain("SCHEMA");
    expect(existsSync(join(root, "..", "..", "..", "..", "ESCAPED.svg"))).toBe(false);
  });
});
