import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simpleAuto } from "../testSupport.js";
import { runDiff } from "./diff.js";

let root = "";
let out: string[] = [];
let errOut: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zenith-diff-"));
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

const write = (name: string, doc: unknown): void => {
  writeFileSync(join(root, name), `${JSON.stringify(doc, null, 2)}\n`, "utf8");
};

describe("zenith diff", () => {
  it("either prints the structural diff (core.diff landed) or the core M1 gate message (it has not)", () => {
    write("a.auto.json", simpleAuto("a"));
    write("b.auto.json", simpleAuto("b"));
    const code = runDiff(join(root, "a.auto.json"), join(root, "b.auto.json"), { cwd: root });

    if (code === 0) {
      expect(out.join("")).toContain("vs");
    } else {
      expect(code).toBe(2);
      expect(errOut.join("")).toContain("core M1 not landed yet");
    }
  });

  it("exits 2 and names the file when one side does not parse", () => {
    write("a.auto.json", simpleAuto("a"));
    writeFileSync(join(root, "broken.auto.json"), "{ not json", "utf8");
    const code = runDiff(join(root, "a.auto.json"), join(root, "broken.auto.json"), { cwd: root });
    expect(code).toBe(2);
    expect(errOut.join("")).toContain("broken.auto.json");
  });

  it("prints JSON with both file labels and the diff (or the error) an agent can read", () => {
    write("a.auto.json", simpleAuto("a"));
    write("b.auto.json", simpleAuto("b"));
    const code = runDiff(join(root, "a.auto.json"), join(root, "b.auto.json"), { cwd: root, json: true });
    const parsed = JSON.parse(out.join("")) as Record<string, unknown>;
    if (code === 0) {
      expect(parsed.a).toBe("a.auto.json");
      expect(parsed.b).toBe("b.auto.json");
    } else {
      expect(typeof parsed.error).toBe("string");
    }
  });
});
