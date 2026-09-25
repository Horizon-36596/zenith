import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProject, simpleAuto, writeAuto } from "../testSupport.js";
import { runSim } from "./sim.js";

let root = "";
let out: string[] = [];
let errOut: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zenith-sim-"));
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

/** A trace this test controls, matching robot/auto-runtime/AutoTraceWriter.java's shape. */
function traceFixture(autoName: string): Record<string, unknown> {
  return {
    formatVersion: 1,
    auto: autoName,
    simTimeS: 3,
    tickS: 0.02,
    capabilities: ["steps", "poses"],
    steps: [
      { id: "drive", startS: 0, endS: 2, interrupted: false },
      { id: "shoot1", startS: 2, endS: 2.6, interrupted: false },
    ],
    poses: [
      [0, -40, -60, 1.5708],
      [2, -30, -40, 0],
    ],
    truthPoses: [],
    structureContacts: [],
    ledger: [{ timeS: 2.6, held: 3, launches: 3, tips: { RED: 0 } }],
    events: [],
  };
}

/**
 * A fake sim command: writes the trace fixture to the path zenith.json's sim.trace resolves to,
 * then exits with `exitCode`. `spawn(..., { shell: true })` on Windows runs the command through
 * `cmd.exe`, whose quoting rules mangle a `node -e "..."` one-liner with embedded quotes, so the
 * script is written to its own file instead and run with a plain `node <file>` - the same shape the
 * task's own fixture idea (a fake sim command) takes without a fragile inline string.
 */
function fakeSimCommand(root: string, autoName: string, exitCode = 0): string {
  const traceRelative = `sim/${autoName}.trace.json`;
  const traceFull = join(root, traceRelative);
  mkdirSync(join(traceFull, ".."), { recursive: true });
  const scriptFull = join(root, `fake-sim-${autoName}.cjs`);
  const script = [
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(traceFull)}, ${JSON.stringify(JSON.stringify(traceFixture(autoName)))});`,
    `process.exit(${String(exitCode)});`,
  ].join("\n");
  writeFileSync(scriptFull, script, "utf8");
  return `node ${JSON.stringify(scriptFull)}`;
}

describe("zenith sim", () => {
  it("runs the sim command, reads the trace, and prints estimate vs actual per step", async () => {
    makeProject(root, { sim: { command: "PLACEHOLDER", trace: "sim/{auto}.trace.json" } });
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    const link = JSON.parse(readFileSync(join(root, "zenith.json"), "utf8")) as { sim: { command: string } };
    link.sim.command = fakeSimCommand(root, "demo");
    writeFileSync(join(root, "zenith.json"), JSON.stringify(link, null, 2), "utf8");

    const code = await runSim("demo", { cwd: root });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("drive");
    expect(text).toContain("shoot1");
    expect(text).toContain("launches: 3");
  }, 20000);

  it("exits 2 with the output tail when the sim command fails", async () => {
    makeProject(root, { sim: { command: 'node -e "console.error(\'boom\'); process.exit(3)"', trace: "sim/{auto}.trace.json" } });
    writeAuto(root, "autos", "demo", simpleAuto("demo"));

    const code = await runSim("demo", { cwd: root });
    expect(code).toBe(2);
    expect(errOut.join("")).toContain("boom");
  }, 20000);

  it("exits 2 when the command exits 0 but never writes a trace", async () => {
    makeProject(root, { sim: { command: "node -e \"process.exit(0)\"", trace: "sim/{auto}.trace.json" } });
    writeAuto(root, "autos", "demo", simpleAuto("demo"));

    const code = await runSim("demo", { cwd: root });
    expect(code).toBe(2);
    expect(errOut.join("")).toContain("did not write a trace");
  }, 20000);

  it("throws a clear error when zenith.json has no sim section", async () => {
    makeProject(root, { sim: undefined });
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    await expect(runSim("demo", { cwd: root })).rejects.toThrow(/sim/);
  });

  it("prints JSON with the report and whether the estimate was available", async () => {
    makeProject(root, { sim: { command: "PLACEHOLDER", trace: "sim/{auto}.trace.json" } });
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    const link = JSON.parse(readFileSync(join(root, "zenith.json"), "utf8")) as { sim: { command: string } };
    link.sim.command = fakeSimCommand(root, "demo");
    writeFileSync(join(root, "zenith.json"), JSON.stringify(link, null, 2), "utf8");

    const code = await runSim("demo", { cwd: root, json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("")) as { report: { auto: string }; estimateAvailable: boolean };
    expect(parsed.report.auto).toBe("demo");
    expect(typeof parsed.estimateAvailable).toBe("boolean");
  }, 20000);

  it("finding 1 / 14: rejects an auto.name that is not [A-Za-z0-9._-]+ before it ever reaches the shell or a path", async () => {
    makeProject(root, {
      // If the name were substituted into the shell command unchecked, this would write a marker
      // file outside the trace path and exit 0; if it were used as a path segment unchecked, it
      // would try to read/write outside the project root. Neither should ever run.
      sim: { command: `node -e "require('fs').writeFileSync(${JSON.stringify(join(root, "INJECTED"))}, 'x')"`, trace: "sim/{auto}.trace.json" },
    });
    writeAuto(root, "autos", "pwn", simpleAuto('pwn"; touch INJECTED; echo "'));

    const code = await runSim("pwn", { cwd: root });
    expect(code).toBe(1);
    const text = out.join("");
    expect(text).toContain("SCHEMA");
    expect(existsSync(join(root, "INJECTED"))).toBe(false);
  });
});

describe("zenith sim launches through resolveLauncher", () => {
  it("on Windows, starts a batch-file sim command through cmd.exe with shell: false", async () => {
    makeProject(root, { sim: { command: "run-sim {auto}", trace: "sim/{auto}.trace.json" } });
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    const calls: { file: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
    const spawnFn = ((file: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ file, args, options });
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => undefined;
      setImmediate(() => child.emit("close", 5));
      return child;
    }) as never;
    const host = {
      platform: "win32" as const,
      env: { PATH: "C:\\Tools", PATHEXT: ".EXE;.BAT" },
      exists: (path: string) => path.toLowerCase() === "c:\\tools\\run-sim.bat",
    };

    const code = await runSim("demo", { cwd: root, spawnFn, host });
    expect(code).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("cmd.exe");
    expect(calls[0]?.args).toEqual(["/d", "/s", "/c", "C:\\Tools\\run-sim.bat demo"]);
    expect(calls[0]?.options["shell"]).toBe(false);
  });
});
