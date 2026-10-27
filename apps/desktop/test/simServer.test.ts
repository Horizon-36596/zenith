/**
 * The sim server behind Full sim speed (simServer.ts), against the fake server in
 * e2e/fixtures/fake-sim-server.cjs, which speaks protocol 1 for real over a child process's stdin
 * and stdout. Basic, which every server failure falls back to, is the fake sim command beside it.
 */
import { cpSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTrace } from "@horizon36596/zenith-core";
import type { DesktopSimEvent } from "../../web/src/project/desktopBridge.js";
import { SimRunner, defaultKillTree } from "../src/main/sim.js";
import { SimDispatcher, autoContentKey, buildServerPlan, isWatched, type ServerDeps } from "../src/main/simServer.js";
import { exampleProject, patchLink } from "./support.js";

const fixtures = fileURLToPath(new URL("../e2e/fixtures/", import.meta.url));
const AUTO = "first-auto.auto.json";

let root = "";
let cleanup: () => void = () => undefined;
let dispatcher: SimDispatcher | null = null;
let events: DesktopSimEvent[] = [];
let touch: (rel: string | null) => void = () => undefined;

beforeEach(() => {
  ({ root, cleanup } = exampleProject());
  for (const name of ["fake-sim-server.cjs", "fake-sim-prepare.cjs", "fake-sim.cjs", "fake-sim-trace.json"]) {
    cpSync(join(fixtures, name), join(root, name));
  }
  events = [];
});

afterEach(async () => {
  dispatcher?.shutdown();
  dispatcher = null;
  // Let the killed processes go before their folder is removed.
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    cleanup();
  } catch {
    // A process still holding a file on Windows; the folder is in the temp directory.
  }
});

/** zenith.json with a fake sim command and a fake sim server started with `serverArgs`. */
function linkServer(serverArgs: string[] = [], prepareFlags: string[] = [], server: Record<string, unknown> = {}): void {
  patchLink(root, (link) => {
    link["sim"] = {
      command: "node fake-sim.cjs {auto}",
      trace: "TeamCode/build/sim/{auto}.trace.json",
      server: {
        prepare: ["node", "fake-sim-prepare.cjs", "build/sim/server.args", "--log", "prepare.log", ...prepareFlags, "--", "--log", "server.log", ...serverArgs].join(" "),
        args: "build/sim/server.args",
        watch: ["TeamCode/src", "build.gradle"],
        ...server,
      },
    };
  });
}

function makeDispatcher(deps: ServerDeps = {}): SimDispatcher {
  const emit = (event: DesktopSimEvent) => {
    events.push(event);
  };
  dispatcher = new SimDispatcher(emit, new SimRunner(emit), {
    serverLaunch: (argsPath) => ({ file: process.execPath, args: [join(root, "fake-sim-server.cjs"), `@${argsPath}`] }),
    watchImpl: (_root, listener) => {
      touch = listener;
      return { close: () => undefined };
    },
    unthrottle: () => undefined,
    // No quiet time after prepare unless a test asks for it: the fake watch hears only what a test says.
    prepareSettleMs: 0,
    ...deps,
  });
  return dispatcher;
}

const lines = (name: string): string[] =>
  existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8").split(/\r?\n/).filter((line) => line !== "") : [];

async function until<T>(read: () => T | undefined | null | false, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Events: ${events.map((event) => event.kind).join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const ended = (runId: string) => () =>
  events.find((event) => event.runId === runId && (event.kind === "done" || event.kind === "failed"));
const of = (runId: string) => events.filter((event) => event.runId === runId);

describe("the sim server plan", () => {
  it("is null for a project with no sim.server, which then only has Basic", () => {
    expect(buildServerPlan(root)).toBeNull();
  });

  it("confines the args file, the working folder and the watched paths to the root", () => {
    linkServer([], [], { cwd: "TeamCode" });
    const plan = buildServerPlan(root);
    expect(plan?.argsRel).toBe("build/sim/server.args");
    expect(plan?.cwdRel).toBe("TeamCode");
    expect(plan?.watch).toEqual(["TeamCode/src", "build.gradle"]);
    expect(isWatched("TeamCode/src/main/Robot.java", plan?.watch ?? [])).toBe(true);
    expect(isWatched("TeamCode/srcs/x", plan?.watch ?? [])).toBe(false);
    expect(isWatched("build.gradle", plan?.watch ?? [])).toBe(true);
  });

  it("reads watched paths the same however they are written, and without case on Windows", () => {
    linkServer([], [], { watch: ["./TeamCode/./src/", "build.gradle"] });
    const plan = buildServerPlan(root);
    expect(plan?.watch).toEqual(["TeamCode/src", "build.gradle"]);
    expect(isWatched("TeamCode/src/A.java", ["./TeamCode/./src/"])).toBe(true);
    expect(isWatched("teamcode/SRC/A.java", plan?.watch ?? [], true)).toBe(true);
    expect(isWatched("teamcode/SRC/A.java", plan?.watch ?? [])).toBe(false);
    linkServer([], [], { watch: ["."] });
    expect(buildServerPlan(root)?.watch).toEqual([""]);
    expect(isWatched("TeamCode/src/A.java", [""])).toBe(true);
  });

  it("never counts the args file's folder, the trace output or the autos folder as robot code", () => {
    linkServer([], [], { args: "TeamCode/build/sim/server.args" });
    expect(buildServerPlan(root)?.ignore).toEqual(["TeamCode/build/sim", "autos"]);
    linkServer([], [], { args: "server.args" });
    expect(buildServerPlan(root)?.ignore).toEqual(["server.args", "TeamCode/build/sim", "autos"]);
  });
});

describe("Fast", { timeout: 60_000 }, () => {
  it("prepares and starts the server on the first run, streams the rows and ends with the whole trace", async () => {
    linkServer();
    const sim = makeDispatcher();
    sim.configure(root, "fast");
    expect(lines("prepare.log")).toEqual([]);
    const runId = sim.start(root, AUTO, "fast");
    const end = await until(ended(runId), "the run to end");
    expect(end.kind).toBe("done");
    const kinds = of(runId).map((event) => event.kind);
    expect(kinds[0]).toBe("started");
    expect(kinds.indexOf("status")).toBeLessThan(kinds.indexOf("traceStart"));
    expect(kinds.filter((kind) => kind === "rows").length).toBeGreaterThan(5);
    expect(of(runId).find((event) => event.kind === "line" && event.text.includes("prepareSimServer"))).toBeDefined();
    expect(of(runId).find((event) => event.kind === "line" && event.text.includes("fake-sim-server: running first-auto"))).toBeDefined();
    if (end.kind !== "done") return;
    expect(end.streamed).toBe(true);
    expect(end.tracePath).toBe("build/sim/first-auto.trace.json");
    // The concatenation of the header and every batch is the file the server wrote.
    const onDisk = JSON.parse(readFileSync(join(root, "build", "sim", "first-auto.trace.json"), "utf8")) as unknown;
    expect(parseTrace(end.trace)).toEqual(parseTrace(onDisk));
  });

  it("keeps the server warm: a second run neither prepares nor starts it again", async () => {
    linkServer();
    const sim = makeDispatcher();
    await until(ended(sim.start(root, AUTO, "fast")), "the first run");
    const second = sim.start(root, AUTO, "fast");
    await until(ended(second), "the second run");
    expect(of(second).some((event) => event.kind === "status")).toBe(false);
    expect(lines("prepare.log")).toHaveLength(1);
    expect(lines("server.log").filter((line) => line.startsWith("started"))).toHaveLength(1);
    expect(lines("server.log").filter((line) => line.startsWith("run"))).toEqual(["run r1 first-auto", "run r2 first-auto"]);
  });

  it("opts the JVM its ready message names out of power throttling, once per start", async () => {
    linkServer();
    const pids: number[] = [];
    const sim = makeDispatcher({ unthrottle: (pid) => pids.push(pid) });
    await until(ended(sim.start(root, AUTO, "fast")), "the first run");
    await until(ended(sim.start(root, AUTO, "fast")), "the second run");
    const started = lines("server.log").find((line) => line.startsWith("started"));
    expect(pids).toEqual([Number(started?.split(" ")[1])]);
  });

  it("cancels a run at the server and leaves the server up for the next", async () => {
    linkServer(["--row-delay-ms", "60"]);
    const sim = makeDispatcher();
    const runId = sim.start(root, AUTO, "fast");
    await until(() => of(runId).some((event) => event.kind === "rows"), "the first rows");
    sim.cancel(runId);
    const end = await until(ended(runId), "the cancel");
    expect(end).toMatchObject({ kind: "failed", cancelled: true });
    expect(lines("server.log")).toContain("cancel r1");
    const next = sim.start(root, AUTO, "fast");
    expect(await until(ended(next), "the next run")).toMatchObject({ kind: "done" });
    expect(lines("server.log").filter((line) => line.startsWith("started"))).toHaveLength(1);
  });

  it("reports a run that failed in the server as that run's failure, without falling back", async () => {
    linkServer(["--fail-auto", "first-auto"]);
    const sim = makeDispatcher();
    const runId = sim.start(root, AUTO, "fast");
    const end = await until(ended(runId), "the failure");
    expect(end).toMatchObject({ kind: "failed", cancelled: false, message: "first-auto threw in the sim: a fake failure." });
    expect(of(runId).some((event) => event.kind === "status" && event.status === "fallback")).toBe(false);
  });

  it("stops the server after the idle time", async () => {
    linkServer();
    const sim = makeDispatcher({ idleMs: 300 });
    await until(ended(sim.start(root, AUTO, "fast")), "the run");
    expect(sim.current?.running).toBe(true);
    await until(() => lines("server.log").includes("shutdown"), "the idle shutdown", 10_000);
    await until(() => sim.current?.running === false, "the server to go");
  });

  it("re-prepares and restarts a server whose watched code changed", async () => {
    linkServer();
    const sim = makeDispatcher();
    await until(ended(sim.start(root, AUTO, "fast")), "the first run");
    touch("TeamCode/src/main/java/Robot.java");
    await until(() => lines("server.log").includes("shutdown"), "the stale server to stop");
    const runId = sim.start(root, AUTO, "fast");
    await until(ended(runId), "the run after the change");
    expect(of(runId).find((event) => event.kind === "status" && event.status === "preparing")).toMatchObject({
      message: "Rebuilding the robot code for the sim server.",
    });
    expect(lines("prepare.log")).toHaveLength(2);
    expect(lines("server.log").filter((line) => line.startsWith("started"))).toHaveLength(2);
  });
});

describe("falling back to Basic", { timeout: 60_000 }, () => {
  const fellBack = (runId: string) => of(runId).find((event) => event.kind === "status" && event.status === "fallback");

  it("refuses a server that speaks another protocol, says why, and does not try it again until the code changes", async () => {
    linkServer(["--protocol", "2"]);
    const sim = makeDispatcher();
    const runId = sim.start(root, AUTO, "fast");
    const end = await until(ended(runId), "the Basic run");
    expect(fellBack(runId)).toMatchObject({ message: expect.stringContaining("speaks protocol 2, and this version of Zenith speaks protocol 1") as unknown });
    expect(end.kind).toBe("done");
    // The Basic run's own start, from the sim command, under the same run id.
    expect(of(runId).filter((event) => event.kind === "started")).toHaveLength(2);
    const again = sim.start(root, AUTO, "fast");
    await until(ended(again), "the second Basic run");
    expect(fellBack(again)).toBeDefined();
    expect(lines("prepare.log")).toHaveLength(1);
  });

  it("runs Basic when the prepare command fails", async () => {
    linkServer([], ["--fail"]);
    const sim = makeDispatcher();
    const runId = sim.start(root, AUTO, "fast");
    expect(await until(ended(runId), "the Basic run")).toMatchObject({ kind: "done" });
    const said = "The sim server's prepare command failed: it exited with code 1. Show the sim's output to see what it printed.";
    expect(fellBack(runId)).toMatchObject({ message: expect.stringContaining(said) as unknown });
  });

  it("runs Basic when the server crashes part way through a run, and starts it again next time", async () => {
    linkServer(["--crash-after", "2"]);
    const sim = makeDispatcher();
    const runId = sim.start(root, AUTO, "fast");
    expect(await until(ended(runId), "the Basic run")).toMatchObject({ kind: "done" });
    expect(fellBack(runId)).toMatchObject({ message: expect.stringContaining("stopped during the run") as unknown });
    expect(of(runId).filter((event) => event.kind === "rows").length).toBeGreaterThan(0);
    const next = sim.start(root, AUTO, "fast");
    await until(ended(next), "the next run");
    expect(lines("server.log").filter((line) => line.startsWith("started"))).toHaveLength(2);
  });

  it("runs Basic when the server never says it is ready", async () => {
    linkServer(["--never-ready"]);
    const sim = makeDispatcher({ readyTimeoutMs: 1_500 });
    const runId = sim.start(root, AUTO, "fast");
    expect(await until(ended(runId), "the Basic run")).toMatchObject({ kind: "done" });
    expect(fellBack(runId)).toMatchObject({ message: expect.stringContaining("did not say it was ready") as unknown });
  });

  it("runs Basic when the server says it cannot start", async () => {
    linkServer(["--fatal", "no-runner-named"]);
    const sim = makeDispatcher();
    const runId = sim.start(root, AUTO, "fast");
    expect(await until(ended(runId), "the Basic run")).toMatchObject({ kind: "done" });
    expect(fellBack(runId)).toMatchObject({ message: expect.stringContaining("could not start: no-runner-named") as unknown });
  });

  it("runs the sim command, with no server, for a project without sim.server and for Basic", async () => {
    patchLink(root, (link) => {
      (link["sim"] as Record<string, string>)["command"] = "node fake-sim.cjs {auto}";
    });
    const sim = makeDispatcher();
    const runId = sim.start(root, AUTO, "ultrafast");
    expect(await until(ended(runId), "the run")).toMatchObject({ kind: "done" });
    expect(of(runId)[0]).toMatchObject({ kind: "started", command: "node fake-sim.cjs first-auto" });
    linkServer();
    const basic = sim.start(root, AUTO, "basic");
    await until(ended(basic), "the Basic run");
    expect(lines("prepare.log")).toEqual([]);
  });
});

describe("Ultrafast", { timeout: 60_000 }, () => {
  it("starts the server with the project, runs a saved auto in the background, and plays it at once", async () => {
    linkServer();
    const sim = makeDispatcher({ debounceMs: 50 });
    sim.configure(root, "ultrafast");
    await until(() => lines("server.log").some((line) => line.startsWith("started")), "the server to start with the project");
    sim.autoSaved(root, AUTO);
    sim.autoSaved(root, AUTO);
    await until(() => existsSync(join(root, "build", "sim", "first-auto.trace.json")), "the background run");
    // Two saves inside the debounce are one run, and a background run emits nothing.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lines("server.log").filter((line) => line.startsWith("run"))).toEqual(["run r1 first-auto"]);
    expect(events).toEqual([]);
    const runId = sim.start(root, AUTO, "ultrafast");
    const end = of(runId).find((event) => event.kind === "done");
    expect(end).toMatchObject({ kind: "done", cached: true, elapsedS: 0 });
    expect(lines("server.log").filter((line) => line.startsWith("run"))).toHaveLength(1);
  });

  it("never plays a cached run for an auto file that changed since", async () => {
    linkServer();
    const sim = makeDispatcher({ debounceMs: 50 });
    sim.configure(root, "ultrafast");
    const before = autoContentKey(root, AUTO);
    sim.autoSaved(root, AUTO);
    await until(() => lines("server.log").some((line) => line.startsWith("run r1")), "the background run");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const path = join(root, "autos", AUTO);
    writeFileSync(path, readFileSync(path, "utf8").replace(/\n$/, " \n"));
    expect(autoContentKey(root, AUTO)).not.toBe(before);
    const runId = sim.start(root, AUTO, "ultrafast");
    const end = await until(ended(runId), "a fresh run");
    expect(end).toMatchObject({ kind: "done", streamed: true });
    expect(end.kind === "done" ? end.cached : null).toBeUndefined();
  });

  it("never plays a cached run made before the robot code changed", async () => {
    linkServer();
    const sim = makeDispatcher({ debounceMs: 50 });
    sim.configure(root, "ultrafast");
    sim.autoSaved(root, AUTO);
    await until(() => existsSync(join(root, "build", "sim", "first-auto.trace.json")), "the background run");
    await new Promise((resolve) => setTimeout(resolve, 300));
    touch("build.gradle");
    const runId = sim.start(root, AUTO, "ultrafast");
    const end = await until(ended(runId), "a fresh run");
    expect(end.kind === "done" ? end.cached : null).toBeUndefined();
    expect(lines("prepare.log")).toHaveLength(2);
  });

  it("hands a background run of the same file to a click that comes while it runs", async () => {
    linkServer(["--row-delay-ms", "40"]);
    const sim = makeDispatcher({ debounceMs: 20 });
    sim.configure(root, "ultrafast");
    sim.autoSaved(root, AUTO);
    await until(() => lines("server.log").some((line) => line.startsWith("run r1")), "the background run");
    const runId = sim.start(root, AUTO, "ultrafast");
    const end = await until(ended(runId), "the run");
    expect(end.kind).toBe("done");
    expect(of(runId).map((event) => event.kind)).toContain("traceStart");
    expect(lines("server.log").filter((line) => line.startsWith("run"))).toEqual(["run r1 first-auto"]);
    if (end.kind === "done") expect(parseTrace(end.trace).poses.length).toBe(664);
  });

  it("cancels a background run of another auto for a click, and runs the click next", async () => {
    linkServer(["--row-delay-ms", "40"]);
    const sim = makeDispatcher({ debounceMs: 20 });
    sim.configure(root, "ultrafast");
    sim.autoSaved(root, "cycle-and-park.auto.json");
    await until(() => lines("server.log").some((line) => line.startsWith("run r1")), "the background run");
    const runId = sim.start(root, AUTO, "ultrafast");
    expect(await until(ended(runId), "the click's run")).toMatchObject({ kind: "done" });
    const log = lines("server.log").filter((line) => !line.startsWith("started"));
    expect(log).toEqual(["run r1 cycle-and-park", "cancel r1", "run r2 first-auto"]);
  });

  it("stops the server when the speed goes back to Basic, and on shutdown", async () => {
    linkServer();
    const sim = makeDispatcher();
    sim.configure(root, "ultrafast");
    await until(() => sim.current?.running === true, "the server to start");
    sim.configure(root, "basic");
    expect(sim.current).toBeNull();
    await until(() => lines("server.log").includes("shutdown") || null, "the server to stop", 5_000).catch(() => undefined);
    sim.configure(root, "ultrafast");
    await until(() => sim.current?.running === true, "the server to start again");
    sim.shutdown();
    expect(sim.current).toBeNull();
  });
});

describe("closing, staleness and the getting ready", { timeout: 60_000 }, () => {
  const fellBack = (runId: string) => of(runId).find((event) => event.kind === "status" && event.status === "fallback");
  const status = (runId: string, which: string) => () => of(runId).find((event) => event.kind === "status" && event.status === which);
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const stampOf = (line: string | undefined): number => Number(line?.split(" ")[1]);

  it("cancels the click waiting on prepare when the manager closes, kills prepare and starts no server", async () => {
    linkServer([], ["--delay-ms", "5000"]);
    const killed: string[] = [];
    const sim = makeDispatcher({
      killTree: (child) => {
        killed.push(child.spawnargs.join(" "));
        defaultKillTree(child);
      },
    });
    const runId = sim.start(root, AUTO, "fast");
    await until(() => lines("prepare.log").length === 1, "prepare to run");
    sim.configure(root, "basic");
    expect(ended(runId)()).toMatchObject({ kind: "failed", cancelled: true });
    expect(killed.some((args) => args.includes("fake-sim-prepare.cjs"))).toBe(true);
    await wait(6_000);
    expect(existsSync(join(root, "build", "sim", "server.args"))).toBe(false);
    expect(lines("server.log")).toEqual([]);
    expect(fellBack(runId)).toBeUndefined();
    expect(of(runId).filter((event) => event.kind === "failed" || event.kind === "done")).toHaveLength(1);
  });

  it("runs no Basic fallback for a prepare that fails after the manager closed", async () => {
    linkServer([], ["--fail", "--delay-ms", "1500"]);
    const sim = makeDispatcher();
    const runId = sim.start(root, AUTO, "fast");
    await until(() => lines("prepare.log").length === 1, "prepare to run");
    sim.configure(root, "basic");
    await wait(2_500);
    expect(fellBack(runId)).toBeUndefined();
    expect(of(runId).filter((event) => event.kind === "started")).toHaveLength(1);
  });

  it("keys a trace on the robot file the runtime reads too", () => {
    const before = autoContentKey(root, AUTO);
    const path = join(root, "autos", "robot.json");
    writeFileSync(path, readFileSync(path, "utf8").replace(/\n$/, " \n"));
    expect(autoContentKey(root, AUTO)).not.toBe(before);
  });

  it("keeps no trace of an auto that changed between the click and the run", async () => {
    linkServer([], ["--delay-ms", "1500"]);
    const sim = makeDispatcher({ debounceMs: 60_000 });
    const path = join(root, "autos", AUTO);
    const original = readFileSync(path, "utf8");
    const runId = sim.start(root, AUTO, "ultrafast");
    await until(() => lines("prepare.log").length === 1, "prepare to run");
    writeFileSync(path, original.replace(/\n$/, " \n"));
    expect(await until(ended(runId), "the run")).toMatchObject({ kind: "done", streamed: true });
    writeFileSync(path, original);
    const again = sim.start(root, AUTO, "ultrafast");
    const end = await until(ended(again), "the second run");
    expect(end.kind === "done" ? end.cached : null).toBeUndefined();
  });

  it("waits for a server stopped in the background to go before preparing the next", async () => {
    linkServer(["--shutdown-delay-ms", "4000"]);
    const sim = makeDispatcher({ idleMs: 200, shutdownGraceMs: 6_000 });
    await until(ended(sim.start(root, AUTO, "fast")), "the first run");
    await until(() => lines("server.log").includes("shutdown"), "the idle stop");
    const runId = sim.start(root, AUTO, "fast");
    expect(await until(ended(runId), "the second run")).toMatchObject({ kind: "done" });
    const exited = stampOf(lines("server.log").find((line) => line.startsWith("exit")));
    expect(stampOf(lines("prepare.log")[1])).toBeGreaterThanOrEqual(exited);
  });

  it("does not let an old server going away end a run on the new one", async () => {
    linkServer(["--shutdown-delay-ms", "12000", "--row-delay-ms", "700"]);
    // A kill that does nothing, so the old server outlives the wait for it.
    const sim = makeDispatcher({ idleMs: 200, killTree: () => undefined, shutdownGraceMs: 200 });
    await until(ended(sim.start(root, AUTO, "fast")), "the first run", 60_000);
    await until(() => lines("server.log").includes("shutdown"), "the idle stop");
    const runId = sim.start(root, AUTO, "fast");
    expect(await until(ended(runId), "the second run", 60_000)).toMatchObject({ kind: "done", streamed: true });
    expect(fellBack(runId)).toBeUndefined();
    const log = lines("server.log");
    // The old server went while the new one ran.
    expect(log.findIndex((line) => line.startsWith("exit"))).toBeGreaterThan(log.findIndex((line) => line.startsWith("run r2")));
  }, 120_000);

  it("restarts, without falling back, a server whose watched code changed while it started", async () => {
    linkServer(["--ready-delay-ms", "1500"]);
    const sim = makeDispatcher();
    const runId = sim.start(root, AUTO, "fast");
    await until(() => lines("server.log").some((line) => line.startsWith("started")), "the server to start");
    touch("TeamCode/src/main/java/Robot.java");
    expect(await until(ended(runId), "the run")).toMatchObject({ kind: "done", streamed: true });
    expect(fellBack(runId)).toBeUndefined();
    expect(lines("prepare.log")).toHaveLength(2);
  });

  it("ignores every change heard while prepare runs, so prepare's own build cannot make the server stale", async () => {
    linkServer([], ["--delay-ms", "1500"]);
    const sim = makeDispatcher();
    const runId = sim.start(root, AUTO, "fast");
    await until(() => lines("prepare.log").length === 1, "prepare to run");
    touch("TeamCode/src/main/java/Robot.java");
    touch(null);
    expect(await until(ended(runId), "the run")).toMatchObject({ kind: "done", streamed: true });
    expect(lines("prepare.log")).toHaveLength(1);
  });

  it("hands the getting ready to the next click when the waiting one is cancelled", async () => {
    linkServer([], ["--delay-ms", "1500"]);
    const sim = makeDispatcher();
    const first = sim.start(root, AUTO, "fast");
    await until(status(first, "preparing"), "prepare to start");
    sim.cancel(first);
    const second = sim.start(root, AUTO, "fast");
    expect(status(second, "preparing")()).toBeDefined();
    expect(await until(ended(second), "the second run")).toMatchObject({ kind: "done" });
    expect(status(first, "starting")()).toBeUndefined();
    expect(status(second, "starting")()).toBeDefined();
  });

  it("stops a prepare that runs too long, and runs Basic", async () => {
    linkServer([], ["--delay-ms", "8000"]);
    const sim = makeDispatcher({ prepareTimeoutMs: 800 });
    const runId = sim.start(root, AUTO, "fast");
    expect(await until(ended(runId), "the Basic run")).toMatchObject({ kind: "done" });
    expect(fellBack(runId)).toMatchObject({ message: expect.stringContaining("did not finish within 1 s") as unknown });
  });

  it("treats a change the watch could not name as a change to the robot code", async () => {
    linkServer();
    const sim = makeDispatcher();
    await until(ended(sim.start(root, AUTO, "fast")), "the run");
    touch(null);
    await until(() => lines("server.log").includes("shutdown"), "the stale server to stop");
  });

  it("keeps a character split across two output chunks whole", async () => {
    linkServer([], ["--split-utf8"]);
    const sim = makeDispatcher();
    const runId = sim.start(root, AUTO, "fast");
    await until(ended(runId), "the run");
    expect(of(runId).find((event) => event.kind === "line" && event.text.startsWith("Built caf"))).toMatchObject({ text: "Built café" });
  });
});

describe("watched changes, zenith.json edits and a server that will not work", { timeout: 60_000 }, () => {
  const fellBack = (runId: string) => of(runId).find((event) => event.kind === "status" && event.status === "fallback");
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const started = () => lines("server.log").filter((line) => line.startsWith("started"));

  it("does not count the args file, the traces or the autos as a change to the robot code", async () => {
    linkServer([], [], { watch: ["build", "TeamCode", "autos"] });
    const sim = makeDispatcher();
    await until(ended(sim.start(root, AUTO, "fast")), "the first run");
    touch("build/sim/server.args");
    touch("build/sim/first-auto.trace.json");
    touch("TeamCode/build/sim/first-auto.trace.json");
    touch(`autos/${AUTO}`);
    expect(await until(ended(sim.start(root, AUTO, "fast")), "the second run")).toMatchObject({ kind: "done" });
    expect(lines("prepare.log")).toHaveLength(1);
    touch("TeamCode/src/main/java/Robot.java");
    await until(() => lines("server.log").includes("shutdown"), "the stale server to stop");
  });

  it("does not rebuild forever when watch covers the folder prepare builds into", async () => {
    linkServer([], ["--write", "build/classes/Robot.class"], { watch: ["build"] });
    // The real file system watch, so prepare's own writes are heard as they happen.
    const sim = makeDispatcher({ watchImpl: undefined, prepareSettleMs: undefined });
    const runId = sim.start(root, AUTO, "fast");
    expect(await until(ended(runId), "the run", 15_000)).toMatchObject({ kind: "done" });
    await wait(1_500);
    expect(await until(ended(sim.start(root, AUTO, "fast")), "the second run")).toMatchObject({ kind: "done" });
    expect(lines("prepare.log")).toHaveLength(1);
    expect(started()).toHaveLength(1);
  });

  it("uses the sim.server zenith.json has at each click, and stops the old server when it changed", async () => {
    linkServer();
    const sim = makeDispatcher();
    await until(ended(sim.start(root, AUTO, "fast")), "the first run");
    linkServer(["--batch", "50"]);
    const changed = sim.start(root, AUTO, "fast");
    expect(await until(ended(changed), "the run on the new server")).toMatchObject({ kind: "done", streamed: true });
    expect(lines("prepare.log")).toHaveLength(2);
    expect(started()).toHaveLength(2);
    expect(lines("server.log")).toContain("shutdown");
    patchLink(root, (link) => {
      delete (link["sim"] as Record<string, unknown>)["server"];
    });
    const basic = sim.start(root, AUTO, "fast");
    expect(await until(ended(basic), "the Basic run")).toMatchObject({ kind: "done" });
    expect(of(basic)[0]).toMatchObject({ kind: "started", command: "node fake-sim.cjs first-auto" });
    expect(sim.current).toBeNull();
    await until(() => lines("server.log").filter((line) => line === "shutdown").length === 2, "the second server to stop");
  });

  it("keeps the same server when zenith.json was saved with the same sim.server", async () => {
    linkServer();
    const sim = makeDispatcher();
    await until(ended(sim.start(root, AUTO, "fast")), "the first run");
    linkServer();
    await until(ended(sim.start(root, AUTO, "fast")), "the second run");
    expect(lines("prepare.log")).toHaveLength(1);
    expect(started()).toHaveLength(1);
  });

  it("tries a server that spoke another protocol again once some time has passed", async () => {
    linkServer(["--protocol", "2"]);
    const sim = makeDispatcher({ stuckRetryMs: 800 });
    await until(ended(sim.start(root, AUTO, "fast")), "the first Basic run");
    await until(ended(sim.start(root, AUTO, "fast")), "the second Basic run");
    expect(lines("prepare.log")).toHaveLength(1);
    await wait(1_000);
    const later = sim.start(root, AUTO, "fast");
    await until(ended(later), "the later run");
    expect(lines("prepare.log")).toHaveLength(2);
    expect(fellBack(later)).toBeDefined();
  });

  it("tries a server that spoke another protocol again once its args file changed", async () => {
    linkServer(["--protocol", "2"]);
    const sim = makeDispatcher();
    await until(ended(sim.start(root, AUTO, "fast")), "the first Basic run");
    const args = join(root, "build", "sim", "server.args");
    await wait(50);
    writeFileSync(args, readFileSync(args, "utf8").replace("--protocol\n2", "--protocol\n1"));
    const next = sim.start(root, AUTO, "fast");
    await until(ended(next), "the next run");
    expect(lines("prepare.log")).toHaveLength(2);
  });

  it("does not prepare again on every save after a prepare failed, until the robot code changes or a click", async () => {
    linkServer([], ["--fail"]);
    const sim = makeDispatcher({ debounceMs: 20 });
    sim.configure(root, "ultrafast");
    await until(() => lines("prepare.log").length === 1, "the first prepare");
    await wait(500);
    sim.autoSaved(root, AUTO);
    await wait(300);
    sim.autoSaved(root, AUTO);
    await wait(500);
    expect(lines("prepare.log")).toHaveLength(1);
    touch("TeamCode/src/main/java/Robot.java");
    sim.autoSaved(root, AUTO);
    await until(() => lines("prepare.log").length === 2, "a prepare after the code changed");
    await wait(500);
    const runId = sim.start(root, AUTO, "ultrafast");
    await until(ended(runId), "the Basic run");
    expect(lines("prepare.log")).toHaveLength(3);
    expect(fellBack(runId)).toBeDefined();
  });

  it("stops a server that does not stop a cancelled run in time, and starts a new one next time", async () => {
    linkServer(["--ignore-cancel", "--row-delay-ms", "100"]);
    const sim = makeDispatcher({ cancelGraceMs: 300 });
    const runId = sim.start(root, AUTO, "fast");
    await until(() => of(runId).some((event) => event.kind === "rows"), "the first rows");
    sim.cancel(runId);
    expect(await until(ended(runId), "the cancel")).toMatchObject({ kind: "failed", cancelled: true });
    expect(lines("server.log")).toContain("cancel r1");
    await until(() => lines("server.log").includes("shutdown"), "the server to be stopped");
    expect(await until(ended(sim.start(root, AUTO, "fast")), "the next run")).toMatchObject({ kind: "done" });
    expect(started()).toHaveLength(2);
  });

  it("kills a server that does not go when asked to shut down", async () => {
    linkServer(["--ignore-shutdown"]);
    const killed: string[] = [];
    const sim = makeDispatcher({
      idleMs: 100,
      shutdownGraceMs: 300,
      killTree: (child) => {
        killed.push(child.spawnargs.join(" "));
        defaultKillTree(child);
      },
    });
    await until(ended(sim.start(root, AUTO, "fast")), "the run");
    await until(() => lines("server.log").includes("shutdown"), "the idle stop");
    await until(() => killed.some((args) => args.includes("fake-sim-server.cjs")), "the kill");
    await until(() => sim.current?.running === false, "the server to go");
  });

  it("fails a run whose streamed trace cannot be read, and keeps no trace of it", async () => {
    linkServer(["--bad-row"]);
    const sim = makeDispatcher();
    const runId = sim.start(root, AUTO, "ultrafast");
    const end = await until(ended(runId), "the run");
    expect(end).toMatchObject({ kind: "failed", cancelled: false, message: expect.stringContaining("The sim server's trace could not be read") as unknown });
    const again = sim.start(root, AUTO, "ultrafast");
    await until(ended(again), "the second run");
    expect(lines("server.log").filter((line) => line.startsWith("run"))).toHaveLength(2);
  });
});
