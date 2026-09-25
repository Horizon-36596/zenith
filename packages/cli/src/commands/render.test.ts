import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProject, simpleAuto, writeAuto } from "../testSupport.js";
import { runRender } from "./render.js";

let root = "";
let out: string[] = [];
let errOut: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zenith-render-"));
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

describe("zenith render", () => {
  it("requires --svg or --png", async () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    await expect(runRender("demo", { cwd: root })).rejects.toThrow(/--svg.*--png/);
  });

  it("either writes an SVG (core.render landed) or reports the core M1 gate clearly (it has not)", async () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    const svgOut = join(root, "out.svg");
    const code = await runRender("demo", { cwd: root, svg: svgOut });

    if (code === 0) {
      expect(existsSync(svgOut)).toBe(true);
      expect(readFileSync(svgOut, "utf8")).toContain("<svg");
      expect(out.join("")).toContain("written: ");
    } else {
      expect(code).toBe(2);
      expect(errOut.join("")).toContain("core M1 not landed yet");
    }
  });

  it("rejects an --alliance other than RED or BLUE before doing any work", async () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    await expect(runRender("demo", { cwd: root, svg: join(root, "out.svg"), alliance: "GREEN" })).rejects.toThrow(
      /RED or BLUE/,
    );
  });
});
