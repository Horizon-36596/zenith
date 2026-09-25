import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isEntryPoint, main, stripWrapperSeparator } from "./index.js";
import { makeProject, simpleAuto, writeAuto } from "./testSupport.js";

describe("stripWrapperSeparator", () => {
  it("drops a single bare -- right after the node executable and the script path", () => {
    expect(stripWrapperSeparator(["node", "index.js", "--", "validate", "x", "--project", "y"])).toEqual([
      "node",
      "index.js",
      "validate",
      "x",
      "--project",
      "y",
    ]);
  });

  it("leaves argv untouched when there is no leading --", () => {
    const argv = ["node", "index.js", "validate", "x", "--project", "y"];
    expect(stripWrapperSeparator(argv)).toEqual(argv);
  });

  it("only drops the leading --, not one a verb passes on purpose later in the line", () => {
    expect(stripWrapperSeparator(["node", "index.js", "diff", "a.json", "--", "b.json"])).toEqual([
      "node",
      "index.js",
      "diff",
      "a.json",
      "--",
      "b.json",
    ]);
  });
});

describe("isEntryPoint", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "zenith-cli-entry-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is true for the module's own path", () => {
    const script = join(root, "index.js");
    writeFileSync(script, "");
    expect(isEntryPoint(script, pathToFileURL(script).href)).toBe(true);
  });

  it("is true through a symlink, the way npm links a bin on Linux and macOS", (context) => {
    const script = join(root, "index.js");
    const link = join(root, "zenith");
    writeFileSync(script, "");
    try {
      symlinkSync(script, link);
    } catch {
      // Windows without Developer Mode cannot make symlinks; CI on Linux runs this case.
      context.skip();
    }
    expect(isEntryPoint(link, pathToFileURL(script).href)).toBe(true);
  });

  it("is false for another script, and for no script at all", () => {
    const script = join(root, "index.js");
    const other = join(root, "other.js");
    writeFileSync(script, "");
    writeFileSync(other, "");
    expect(isEntryPoint(other, pathToFileURL(script).href)).toBe(false);
    expect(isEntryPoint(undefined, pathToFileURL(script).href)).toBe(false);
    expect(isEntryPoint(join(root, "missing.js"), pathToFileURL(script).href)).toBe(false);
  });
});

describe("main, reproducing the pnpm zenith -- wrapper", () => {
  let root = "";
  let out: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "zenith-cli-wrapper-"));
    out = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "cwd").mockReturnValue(tmpdir());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("honours --project after a leading -- the way pnpm zenith -- validate ... --project <dir> sends it", async () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    const autoPath = join(root, "autos", "demo.auto.json");

    const code = await main([
      process.execPath,
      "packages/cli/src/index.ts",
      "--",
      "validate",
      autoPath,
      "--project",
      root,
      "--json",
    ]);

    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("")) as { project: string; errors: number };
    expect(parsed.errors).toBe(0);
  });
});
