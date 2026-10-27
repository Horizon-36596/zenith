/**
 * A Full sim run streamed from the desktop app's sim server (site/docs/full-sim-simloop.md, "Full
 * sim speed"): the trace grows as rows arrive and plays at the Full sim level from the first rows,
 * the finished run is the whole trace, and a run that does not finish, falls back or belongs to an
 * earlier click leaves no rows behind.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, parseTrace, type Trace } from "@horizon36596/zenith-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getState, openAuto, openProject, setPrefs, setTrace } from "../state/store";
import { settingsPatch, withSetting } from "../settings/registry";
import { DesktopBackend } from "./desktop";
import { currentSimSpeed, getPanel, onSimEvent, resetSimStateForTests, runHighFidelitySim } from "./desktopActions";
import { DESKTOP_API_VERSION, type DesktopSimEvent, type ZenithDesktopBridge } from "./desktopBridge";
import { settleTrace } from "./desktopTrace";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/starter/${path}`, import.meta.url)), "utf8");

const ROOT = "C:/repo";
const FIRST = "first-auto.auto.json";
const files: Record<string, string> = {
  "zenith.json": read("zenith.json"),
  "autos/robot.json": read("autos/robot.json"),
  "autos/field/biobuzz.field.json": read("autos/field/biobuzz.field.json"),
  "autos/waypoints.json": read("autos/waypoints.json"),
};

const file = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../desktop/e2e/fixtures/fake-sim-trace.json", import.meta.url)), "utf8"),
) as Record<string, unknown> & { poses: unknown[] };
const { steps, poses, truthPoses, structureContacts, ledger, events, ...header } = file;
const whole = parseTrace(file);

function fakeBridge() {
  const started: Array<{ fileName: string; speed: unknown }> = [];
  const bridge = {
    apiVersion: DESKTOP_API_VERSION,
    project: {
      read: (_root: string, path: string) => {
        const text = files[path] ?? (path === `autos/${FIRST}` ? read(`autos/${FIRST}`) : undefined);
        return text === undefined ? Promise.reject(new Error(`Could not read ${path}.`)) : Promise.resolve(text);
      },
      listAutos: () => Promise.resolve([FIRST]),
      watch: () => Promise.resolve(),
    },
    sim: {
      start: (_root: string, fileName: string, options?: { speed?: unknown }) => {
        started.push({ fileName, speed: options?.speed });
        return Promise.resolve(`run-${String(started.length)}`);
      },
      cancel: vi.fn(() => Promise.resolve()),
      onEvent: () => () => undefined,
    },
  } as unknown as ZenithDesktopBridge;
  return { bridge, started };
}

async function openDesktop(bridge: ZenithDesktopBridge): Promise<void> {
  vi.stubGlobal("window", { zenithDesktop: bridge });
  const backend = new DesktopBackend(bridge, { root: ROOT, name: "repo" });
  openProject(await backend.open(), backend);
  const auto = loadAuto(JSON.parse(read(`autos/${FIRST}`)));
  openAuto(FIRST, auto, canonicalize("auto", auto));
}

const send = (event: DesktopSimEvent): void => {
  onSimEvent(event);
};

/** The fixture trace's poses, in batches of 25, as the server sends them. */
function batches(runId: string): DesktopSimEvent[] {
  const out: DesktopSimEvent[] = [];
  for (let at = 0; at < poses.length; at += 25) out.push({ runId, kind: "rows", rows: { poses: poses.slice(at, at + 25) } });
  out.push({ runId, kind: "rows", rows: { steps, truthPoses, structureContacts, ledger, events } });
  return out;
}

describe("a streamed Full sim run", () => {
  let fake: ReturnType<typeof fakeBridge>;
  beforeEach(async () => {
    resetSimStateForTests();
    fake = fakeBridge();
    await openDesktop(fake.bridge);
    setTrace(null);
    setPrefs({ playbackLevel: "ideal" });
    await runHighFidelitySim();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for the run at the project's speed, which is Basic for a project with no sim server", () => {
    expect(fake.started).toEqual([{ fileName: FIRST, speed: "basic" }]);
    expect(currentSimSpeed(getState())).toBe("basic");
    const link = JSON.parse(files["zenith.json"] as string) as { sim: Record<string, unknown> };
    const withServer = { ...getState().project, link: { ...link, sim: { ...link.sim, server: { prepare: "x", args: "a.args" } } } };
    const state = { prefs: withSetting(getState().prefs, "sim.speed", "ultrafast"), project: withServer } as unknown as Parameters<typeof currentSimSpeed>[0];
    expect(currentSimSpeed(state)).toBe("ultrafast");
    const off = { ...state, prefs: { ...state.prefs, features: { ...state.prefs.features, fullSim: false } } };
    expect(currentSimSpeed(off)).toBe("basic");
  });

  it("says on the sim panel why a faster speed runs Basic, and keeps saying it after the run", () => {
    const why = expect.stringContaining("runs Basic only") as unknown;
    expect(getPanel()).toMatchObject({ kind: "sim", speed: "basic", status: why });
    send({ runId: "run-1", kind: "done", trace: file, tracePath: "TeamCode/build/sim/first-auto.trace.json", elapsedS: 9 });
    expect(getPanel()).toMatchObject({ kind: "sim", phase: "done", status: why });
  });

  it("says nothing about Basic when Basic is the speed chosen", async () => {
    send({ runId: "run-1", kind: "done", trace: file, tracePath: "TeamCode/build/sim/first-auto.trace.json", elapsedS: 9 });
    setPrefs(settingsPatch(getState().prefs, { "sim.speed": "basic" }));
    await runHighFidelitySim();
    expect(fake.started).toHaveLength(2);
    expect(getPanel()).toMatchObject({ kind: "sim", speed: "basic", phase: "running", status: null });
    send({ runId: "run-2", kind: "done", trace: file, tracePath: "TeamCode/build/sim/first-auto.trace.json", elapsedS: 9 });
    setPrefs(settingsPatch(getState().prefs, { "sim.speed": "fast" }));
  });

  it("plays at the Full sim level from the first rows, and grows as more arrive", () => {
    send({ runId: "run-1", kind: "started", command: "java @server.args", autoName: "first-auto", speed: "fast" });
    send({ runId: "run-1", kind: "traceStart", header });
    const [first, second] = batches("run-1");
    send(first as DesktopSimEvent);
    expect(getState().traceStreaming).toBe(true);
    expect(getState().trace?.poses).toHaveLength(25);
    expect(getState().prefs.playbackLevel).toBe("full");
    expect(getState().playing).toBe(true);
    send(second as DesktopSimEvent);
    expect(getState().trace?.poses).toHaveLength(50);
    const panel = getPanel();
    expect(panel.kind === "sim" ? panel.receivedS : null).toBeCloseTo((poses[49] as number[])[0] as number, 9);
  });

  it("ends as the whole trace, settled as the file would be", () => {
    send({ runId: "run-1", kind: "traceStart", header });
    for (const event of batches("run-1")) send(event);
    expect(getState().trace).toEqual(settleTrace(whole).trace);
    send({ runId: "run-1", kind: "done", trace: file, tracePath: "TeamCode/build/sim/first-auto.trace.json", elapsedS: 3, streamed: true });
    expect(getState().traceStreaming).toBe(false);
    expect(getState().trace).toEqual(settleTrace(whole).trace);
    expect(getPanel().kind === "sim" && getPanel()).toMatchObject({ phase: "done" });
  });

  it("puts the earlier trace back when the run is cancelled part way", () => {
    const earlier: Trace = { ...whole, auto: "earlier" };
    setTrace(earlier);
    send({ runId: "run-1", kind: "traceStart", header });
    send(batches("run-1")[0] as DesktopSimEvent);
    expect(getState().trace?.auto).toBe("all-step-kinds");
    send({ runId: "run-1", kind: "failed", message: "The sim was cancelled.", tail: [], cancelled: true });
    expect(getState().trace).toBe(earlier);
    expect(getState().traceStreaming).toBe(false);
  });

  it("drops the streamed rows when the server gives up and Basic runs it again", () => {
    send({ runId: "run-1", kind: "traceStart", header });
    send(batches("run-1")[0] as DesktopSimEvent);
    send({ runId: "run-1", kind: "status", status: "fallback", message: "The sim server stopped during the run: it exited with code 1. Running the Basic sim instead." });
    expect(getState().trace).toBeNull();
    expect(getPanel()).toMatchObject({ kind: "sim", speed: "basic", phase: "running" });
    send({ runId: "run-1", kind: "done", trace: file, tracePath: "TeamCode/build/sim/first-auto.trace.json", elapsedS: 9 });
    expect(getState().trace).toEqual(settleTrace(whole).trace);
  });

  it("stops playing when it puts the earlier trace back", () => {
    send({ runId: "run-1", kind: "traceStart", header });
    send(batches("run-1")[0] as DesktopSimEvent);
    expect(getState().playing).toBe(true);
    send({ runId: "run-1", kind: "failed", message: "The sim was cancelled.", tail: [], cancelled: true });
    expect(getState().playing).toBe(false);
  });

  it("leaves another auto opened while the run streams alone", () => {
    const earlier: Trace = { ...whole, auto: "earlier" };
    setTrace(earlier);
    send({ runId: "run-1", kind: "traceStart", header });
    const [first, second] = batches("run-1");
    send(first as DesktopSimEvent);
    const auto = loadAuto(JSON.parse(read(`autos/${FIRST}`)));
    openAuto("other.auto.json", auto, canonicalize("auto", auto));
    send(second as DesktopSimEvent);
    expect(getState().trace).toBeNull();
    send({ runId: "run-1", kind: "failed", message: "The sim was cancelled.", tail: [], cancelled: true });
    expect(getState().trace).toBeNull();
  });

  it("never draws rows from another run id", () => {
    send({ runId: "run-1", kind: "traceStart", header });
    send({ runId: "run-0", kind: "rows", rows: { poses: poses.slice(0, 25) } });
    expect(getState().trace?.poses).toHaveLength(0);
  });

  it("fails the run, and keeps nothing, when a batch cannot be read", () => {
    send({ runId: "run-1", kind: "traceStart", header });
    send({ runId: "run-1", kind: "rows", rows: { poses: [[0, 1]] } });
    expect(getPanel()).toMatchObject({ kind: "sim", phase: "failed" });
    expect(getState().trace).toBeNull();
    expect(fake.bridge.sim.cancel).toHaveBeenCalledWith("run-1");
  });

  it("keeps the error of a batch that could not be read when the cancel it sends comes back, and a late done", () => {
    send({ runId: "run-1", kind: "traceStart", header });
    send({ runId: "run-1", kind: "rows", rows: { poses: [[0, 1]] } });
    const failed = getPanel();
    expect(failed).toMatchObject({ kind: "sim", phase: "failed", message: expect.stringContaining("could not be read") as unknown });
    send({ runId: "run-1", kind: "failed", message: "The sim was cancelled.", tail: [], cancelled: true });
    expect(getPanel()).toMatchObject({ kind: "sim", phase: "failed", message: expect.stringContaining("could not be read") as unknown });
    send({ runId: "run-1", kind: "done", trace: file, tracePath: "TeamCode/build/sim/first-auto.trace.json", elapsedS: 3, streamed: true });
    expect(getPanel()).toMatchObject({ kind: "sim", phase: "failed", message: expect.stringContaining("could not be read") as unknown });
    expect(getState().trace).toBeNull();
  });

  it("does not draw a finished run over another auto opened while it ran", () => {
    const auto = loadAuto(JSON.parse(read(`autos/${FIRST}`)));
    openAuto("other.auto.json", auto, canonicalize("auto", auto));
    setTrace(null);
    send({ runId: "run-1", kind: "done", trace: file, tracePath: "TeamCode/build/sim/first-auto.trace.json", elapsedS: 0, cached: true });
    expect(getState().trace).toBeNull();
    expect(getState().playing).toBe(false);
    expect(getPanel()).toMatchObject({ kind: "sim", phase: "done", cached: true });
  });

  it("plays a cached Ultrafast run at once", () => {
    send({ runId: "run-1", kind: "done", trace: file, tracePath: "TeamCode/build/sim/first-auto.trace.json", elapsedS: 0, cached: true });
    expect(getState().prefs.playbackLevel).toBe("full");
    expect(getState().playing).toBe(true);
    expect(getPanel()).toMatchObject({ kind: "sim", phase: "done", cached: true });
  });
});
