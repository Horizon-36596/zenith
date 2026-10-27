import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, projectShare, runLedger, simulate } from "@horizon36596/zenith-core";
import { parseProjection } from "@horizon36596/zenith-schema";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAutoAndPlan, resolveAutoPath } from "../autoLoad.js";
import { main } from "../index.js";
import { loadProject } from "../project.js";
import { runAlliance } from "./alliance.js";
import { runProjection, type ProjectionReport } from "./projection.js";

/**
 * `zenith projection`: the projection a share would send, written to a file without the cloud. It
 * must be byte for byte what core's `projectShare` builds from the instant sim's run, the way the
 * editor's share dialog builds it, so a partner who loads the file sees what a share would show.
 */

const STARTER = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));

let dir = "";
let out: string[] = [];
let errOut: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zenith-projection-"));
  cpSync(STARTER, dir, { recursive: true });
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
  rmSync(dir, { recursive: true, force: true });
});

/** What core builds for the auto, the way the share dialog does. */
function expected(auto: string, level: "view" | "propose", extra: { title?: string; coarsen?: boolean; includeCommands?: boolean } = {}): string {
  const project = loadProject(dir, dir);
  const loaded = loadAutoAndPlan(resolveAutoPath(dir, project, auto), project);
  if (!loaded.ok) throw new Error("the starter auto does not load");
  const { plan, robot, field } = loaded.loaded;
  const season = resolveSeason(field).rules;
  const ledger = runLedger(plan, field, season);
  return canonicalize("projection", projectShare({ plan, trace: simulate(plan, robot, field, { ledger, season }), robot, field, ledger }, { level, ...extra }));
}

describe("zenith projection", () => {
  it("prints the canonical view projection core builds, with no title unless one is given", () => {
    expect(runProjection("first-auto", { cwd: dir, project: dir })).toBe(0);
    const text = out.join("");
    expect(text).toBe(expected("first-auto", "view"));
    expect(parseProjection(JSON.parse(text)).title).toBeUndefined();
  });

  it("writes a propose projection with a title and coarsening to --out, and refuses to overwrite it", () => {
    const target = join(dir, "partners", "mine.projection.json");
    const options = { cwd: dir, project: dir, level: "propose", title: "Horizon collect", coarsen: true, out: target };
    expect(runProjection("collect-and-score", options)).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(expected("collect-and-score", "propose", { title: "Horizon collect", coarsen: true }));
    expect(out.join("")).toMatch(/written: partners\/mine\.projection\.json \(a propose projection of autos\/collect-and-score\.auto\.json\)/);
    out = [];
    expect(runProjection("collect-and-score", { ...options, json: true })).toBe(2);
    expect(JSON.parse(out.join(""))).toEqual({ error: expect.stringMatching(/already exists\. Pass --force/) as unknown });
    out = [];
    expect(runProjection("collect-and-score", { ...options, force: true, json: true })).toBe(0);
    const report = JSON.parse(out.join("")) as ProjectionReport;
    expect(report).toMatchObject({ level: "propose", written: "partners/mine.projection.json" });
    expect(report.bytes).toBe(Buffer.byteLength(readFileSync(target, "utf8")));
  });

  it("writes a file zenith alliance reads as a partner", () => {
    const target = join(dir, "me.projection.json");
    expect(runProjection("first-auto", { cwd: dir, project: dir, out: target })).toBe(0);
    out = [];
    expect(runAlliance("collect-and-score", [target], { cwd: dir, project: dir, json: true })).not.toBe(2);
  }, 20000);

  it("refuses an auto with an error, as the share dialog does, and an unknown level", () => {
    const broken = join(dir, "autos", "broken.auto.json");
    const auto = JSON.parse(readFileSync(join(dir, "autos", "first-auto.auto.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(broken, JSON.stringify({ ...auto, name: "broken", steps: [{ id: "x", kind: "command", name: "noSuchCommand" }] }));
    expect(runProjection("broken", { cwd: dir, project: dir })).toBe(1);
    expect(out.join("")).toMatch(/nothing to share yet/);
    expect(runProjection("first-auto", { cwd: dir, project: dir, level: "everything" })).toBe(2);
    expect(errOut.join("")).toMatch(/--level must be view or propose/);
  });

  it("names the commands only under --include-commands, and is otherwise byte for byte the same", () => {
    expect(runProjection("collect-and-score", { cwd: dir, project: dir, level: "propose" })).toBe(0);
    const plain = out.join("");
    expect(plain).toBe(expected("collect-and-score", "propose"));
    expect(parseProjection(JSON.parse(plain)).commands).toBeUndefined();
    out = [];
    expect(runProjection("collect-and-score", { cwd: dir, project: dir, level: "propose", includeCommands: true })).toBe(0);
    const named = out.join("");
    expect(named).toBe(expected("collect-and-score", "propose", { includeCommands: true }));
    const commands = parseProjection(JSON.parse(named)).commands ?? [];
    expect(commands.length).toBeGreaterThan(0);
    // Taking the list out leaves exactly the projection without the option.
    const { commands: _dropped, ...rest } = JSON.parse(named) as Record<string, unknown>;
    expect(rest).toEqual(JSON.parse(plain));
  });

  it("is wired into the binary, with --include-commands and --title", async () => {
    const argv = ["node", "zenith", "projection", "first-auto", "--project", dir, "--json"];
    expect(await main([...argv, "--include-commands", "--title", "Horizon first"])).toBe(0);
    const report = JSON.parse(out.join("")) as ProjectionReport;
    expect(report.projection.title).toBe("Horizon first");
    expect(report.projection.commands?.length).toBeGreaterThan(0);
    out = [];
    expect(await main(argv)).toBe(0);
    expect((JSON.parse(out.join("")) as ProjectionReport).projection.commands).toBeUndefined();
  });

  it("is wired into the binary", async () => {
    expect(await main(["node", "zenith", "projection", "first-auto", "--project", dir, "--level", "view", "--json"])).toBe(0);
    expect((JSON.parse(out.join("")) as ProjectionReport).projection.kind).toBe("projection");
  });
});
