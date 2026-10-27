import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProject, simpleAuto, writeAuto } from "../testSupport.js";
import { runPropose, runProposeDryRun } from "./propose.js";

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
  it("without --dry-run outside a git clone, exits 2 and says to run it in one, without asking GitHub anything", async () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    const fetchImpl = vi.fn();
    const code = await runPropose(
      "demo",
      { cwd: root, json: true },
      {
        run: async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" }),
        env: {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(code).toBe(2);
    const parsed = JSON.parse(out.join("")) as { error: string; next: string };
    expect(parsed.error).toContain("not inside a git repository");
    expect(parsed.next).toContain("clone");
    expect(fetchImpl).not.toHaveBeenCalled();
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
    const code = runProposeDryRun("bad", { cwd: root });
    expect(code).toBe(1);
    expect(existsSync(join(root, "autos/.renders"))).toBe(false);
  });

  it("--dry-run either renders and prints the PR body (core.render landed) or the core M1 gate message (it has not)", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    const code = runProposeDryRun("demo", { cwd: root });

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
    const code = runProposeDryRun("demo", { cwd: root, json: true });
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

    const code = runProposeDryRun("escape", { cwd: root });
    expect(code).toBe(1);
    expect(out.join("")).toContain("SCHEMA");
    expect(existsSync(join(root, "..", "..", "..", "..", "ESCAPED.svg"))).toBe(false);
  });
});
