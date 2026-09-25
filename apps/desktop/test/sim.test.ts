import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { posix, win32 } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopSimEvent } from "../../web/src/project/desktopBridge.js";
import { BridgeError } from "../src/main/confine.js";
import {
  MissingToolError,
  SimRunner,
  buildSimPlan,
  explainFailure,
  findJava,
  resolveLauncher,
  withRerun,
  type Platform,
  type SimPlan,
} from "../src/main/sim.js";
import { exampleProject, patchAuto, patchLink } from "./support.js";

let root = "";
let cleanup: () => void = () => undefined;

beforeEach(() => {
  ({ root, cleanup } = exampleProject());
});

afterEach(() => {
  cleanup();
});

/** A Windows host with Java on the PATH and the robot repository's Gradle wrapper jar present. */
function windowsHost(overrides: Partial<Platform> & { files?: string[] } = {}): Platform {
  const files = new Set(
    (overrides.files ?? [win32.join("C:\\Java\\bin", "java.exe"), win32.join(root, "gradle", "wrapper", "gradle-wrapper.jar")]).map((f) =>
      f.toLowerCase(),
    ),
  );
  return {
    platform: "win32",
    env: overrides.env ?? { PATH: "C:\\Windows;C:\\Java\\bin" },
    exists: overrides.exists ?? ((path) => files.has(path.toLowerCase())),
  };
}

describe("buildSimPlan", () => {
  it("builds the zenith.json command with the validated auto name, as argv and never a shell string", () => {
    const plan = buildSimPlan(root, "first-auto.auto.json", windowsHost());
    expect(plan.autoName).toBe("first-auto");
    expect(plan.launch.file).toBe(win32.join("C:\\Java\\bin", "java.exe"));
    expect(plan.launch.args).toEqual([
      "-Xmx64m",
      "-Xms64m",
      "-Dorg.gradle.appname=gradlew",
      "-classpath",
      win32.join(root, "gradle", "wrapper", "gradle-wrapper.jar"),
      "org.gradle.wrapper.GradleWrapperMain",
      ":TeamCode:testDebugUnitTest",
      "--tests",
      "*ZenithAutoHeadlessTest*",
      "-Dzenith.auto=first-auto",
      // Without it, a second run of an unchanged auto is UP-TO-DATE and writes no trace.
      "--rerun",
    ]);
    expect(plan.traceRel).toBe("TeamCode/build/sim/first-auto.trace.json");
    expect(plan.launch.display).toContain("-Dzenith.auto=first-auto");
  });

  it("runs ./gradlew itself on macOS and Linux", () => {
    const host: Platform = {
      platform: "linux",
      env: { PATH: "/usr/bin" },
      exists: (path) =>
        path === "/usr/bin/java" ||
        path === posix.join(root, "gradle", "wrapper", "gradle-wrapper.jar") ||
        path === posix.join(root, "gradlew"),
    };
    const plan = buildSimPlan(root, "first-auto.auto.json", host);
    expect(plan.launch.file).toBe(posix.join(root, "gradlew"));
    expect(plan.launch.args.slice(-2)).toEqual(["-Dzenith.auto=first-auto", "--rerun"]);
  });

  it("adds Gradle's --rerun once, and not when the command already forces a rerun", () => {
    expect(withRerun([":TeamCode:testDebugUnitTest"])).toEqual([":TeamCode:testDebugUnitTest", "--rerun"]);
    expect(withRerun([":TeamCode:testDebugUnitTest", "--rerun"])).toEqual([":TeamCode:testDebugUnitTest", "--rerun"]);
    expect(withRerun(["--rerun-tasks", "test"])).toEqual(["--rerun-tasks", "test"]);
  });

  it("refuses an auto whose name could reach the command line as anything but a plain word", () => {
    patchAuto(root, "collect-and-score.auto.json", (auto) => {
      auto["name"] = "collect-and-score & calc.exe";
    });
    expect(() => buildSimPlan(root, "collect-and-score.auto.json", windowsHost())).toThrow(/does not load/);
  });

  it("refuses a file name that is not a bare auto file", () => {
    expect(() => buildSimPlan(root, "../first-auto.auto.json", windowsHost())).toThrow(BridgeError);
  });

  it("refuses a trace path that leaves the project", () => {
    patchLink(root, (link) => {
      (link["sim"] as Record<string, string>)["trace"] = "../../{auto}.trace.json";
    });
    expect(() => buildSimPlan(root, "first-auto.auto.json", windowsHost())).toThrow(/outside the project root/);
  });

  it("says plainly when there is no sim section", () => {
    patchLink(root, (link) => {
      delete link["sim"];
    });
    expect(() => buildSimPlan(root, "first-auto.auto.json", windowsHost())).toThrow(/no "sim" section/);
  });
});

describe("missing tools", () => {
  it("says Java is missing in words someone new can act on", () => {
    const host = windowsHost({ files: [win32.join(root, "gradle", "wrapper", "gradle-wrapper.jar")] });
    const error = (() => {
      try {
        buildSimPlan(root, "first-auto.auto.json", host);
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(MissingToolError);
    expect((error as MissingToolError).tool).toBe("java");
    expect((error as Error).message).toMatch(/needs Java/);
  });

  it("names a JAVA_HOME that points nowhere", () => {
    expect(() => findJava(windowsHost({ env: { JAVA_HOME: "C:\\Nowhere", PATH: "C:\\Java\\bin" } }))).toThrow(/JAVA_HOME is set to C:\\Nowhere/);
  });

  it("prefers JAVA_HOME over the PATH", () => {
    const host = windowsHost({
      env: { JAVA_HOME: "C:\\Jdk17", PATH: "C:\\Java\\bin" },
      files: ["C:\\Jdk17\\bin\\java.exe", "C:\\Java\\bin\\java.exe"],
    });
    expect(findJava(host)).toBe("C:\\Jdk17\\bin\\java.exe");
  });

  it("says the Gradle wrapper is missing", () => {
    const host = windowsHost({ files: ["C:\\Java\\bin\\java.exe"] });
    expect(() => buildSimPlan(root, "first-auto.auto.json", host)).toThrow(/no Gradle wrapper/);
  });

  it("says a command that is not installed is not installed", () => {
    expect(() => resolveLauncher(["gradle", "simRun"], root, windowsHost())).toThrow(/not installed or not on the PATH/);
  });

  it("runs a batch file through cmd.exe only when every word is literal to it", () => {
    const host = windowsHost({ files: ["C:\\Tools\\sim.bat"], env: { PATH: "C:\\Tools", PATHEXT: ".EXE;.BAT" } });
    const safe = resolveLauncher(["sim", "--auto=first-auto"], root, host);
    expect(safe.args).toEqual(["/d", "/s", "/c", "C:\\Tools\\sim.bat --auto=first-auto"]);
    expect(() => resolveLauncher(["sim", "a&calc"], root, host)).toThrow(/not safe to pass through cmd.exe/);
    expect(() => resolveLauncher(["sim", "%PATH%"], root, host)).toThrow(/not safe/);
  });
});

/* ---- The runner, with a fake child process ------------------------------- */

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  kill = vi.fn();
}

function runnerHarness(options: { trace?: { text: string; mtimeMs: number } | null; now?: number } = {}) {
  const events: DesktopSimEvent[] = [];
  const child = new FakeChild();
  const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
  const killTree = vi.fn();
  let clock = options.now ?? 1_000_000;
  const runner = new SimRunner((event) => events.push(event), {
    spawnImpl: spawnImpl as never,
    killTree,
    now: () => clock,
    readTrace: () => (options.trace === undefined ? { text: JSON.stringify(traceJson()), mtimeMs: clock } : options.trace),
  });
  const plan: SimPlan = {
    root,
    autoName: "first-auto",
    launch: { file: "java.exe", args: ["-classpath", "w.jar", "org.gradle.wrapper.GradleWrapperMain", "-Dzenith.auto=first-auto"], display: "./gradlew ..." },
    tracePath: "unused",
    traceRel: "TeamCode/build/sim/first-auto.trace.json",
  };
  return {
    events,
    child,
    spawnImpl,
    killTree,
    runner,
    plan,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

function traceJson() {
  return {
    formatVersion: 1,
    auto: "first-auto",
    simTimeS: 3,
    tickS: 0.02,
    capabilities: ["steps", "poses"],
    steps: [{ id: "drive", startS: 0, endS: 2, interrupted: false }],
    poses: [
      [0, -40, -60, 1.5708],
      [2, -30, -40, 0],
    ],
    structureContacts: [],
    ledger: [],
    events: [],
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("SimRunner", () => {
  it("spawns without a shell, streams each line, and hands back the trace", async () => {
    const h = runnerHarness();
    const runId = h.runner.start(h.plan);
    expect(h.spawnImpl).toHaveBeenCalledWith("java.exe", h.plan.launch.args, expect.objectContaining({ shell: false, cwd: root }));
    h.child.stdout.write("> Task :TeamCode:compile\r\n> Task :TeamCode:test");
    h.child.stdout.write("DebugUnitTest\nBUILD SUCCESSFUL\n");
    h.child.stderr.write("\u001b[33mwarning\u001b[0m\n");
    await flush();
    h.tick(42_000);
    h.child.emit("close", 0);
    const lines = h.events.filter((event) => event.kind === "line").map((event) => (event as { text: string }).text);
    expect(lines).toEqual(["> Task :TeamCode:compile", "> Task :TeamCode:testDebugUnitTest", "BUILD SUCCESSFUL", "warning"]);
    const done = h.events.at(-1);
    expect(done).toMatchObject({ runId, kind: "done", tracePath: "TeamCode/build/sim/first-auto.trace.json", elapsedS: 42 });
    expect((done as { trace: { auto: string } }).trace.auto).toBe("first-auto");
    expect(h.runner.running).toBe(false);
  });

  it("cancels by killing the whole process tree", async () => {
    const h = runnerHarness();
    const runId = h.runner.start(h.plan);
    h.runner.cancel(runId);
    expect(h.killTree).toHaveBeenCalledWith(h.child);
    h.child.emit("close", null);
    await flush();
    expect(h.events.at(-1)).toMatchObject({ kind: "failed", cancelled: true });
  });

  it("allows one sim at a time", () => {
    const h = runnerHarness();
    h.runner.start(h.plan);
    expect(() => h.runner.start(h.plan)).toThrow(/already running/);
  });

  it("explains a failed build instead of only printing an exit code", async () => {
    const h = runnerHarness();
    h.runner.start(h.plan);
    h.child.stdout.write("FAILURE: Build failed with an exception.\nSDK location not found. Define ANDROID_HOME\n");
    await flush();
    h.child.emit("close", 1);
    expect(h.events.at(-1)).toMatchObject({ kind: "failed", cancelled: false, message: expect.stringMatching(/Android SDK/) });
  });

  it("refuses to overlay a trace older than the run", () => {
    const h = runnerHarness({ trace: { text: JSON.stringify(traceJson()), mtimeMs: 1 } });
    h.runner.start(h.plan);
    h.child.emit("close", 0);
    expect(h.events.at(-1)).toMatchObject({ kind: "failed", message: expect.stringMatching(/earlier run/) });
  });

  it("reports a missing trace and a malformed one", () => {
    const missing = runnerHarness({ trace: null });
    missing.runner.start(missing.plan);
    missing.child.emit("close", 0);
    expect(missing.events.at(-1)).toMatchObject({ kind: "failed", message: expect.stringMatching(/wrote no trace/) });

    const bad = runnerHarness({ trace: { text: JSON.stringify({ ...traceJson(), steps: "no" }), mtimeMs: 2_000_000 } });
    bad.runner.start(bad.plan);
    bad.child.emit("close", 0);
    expect(bad.events.at(-1)).toMatchObject({ kind: "failed", message: expect.stringMatching(/could not be read/) });
  });

  it("says when the command cannot start at all", () => {
    const h = runnerHarness();
    h.runner.start(h.plan);
    h.child.emit("error", Object.assign(new Error("spawn java.exe ENOENT"), { code: "ENOENT" }));
    expect(h.events.at(-1)).toMatchObject({ kind: "failed", message: expect.stringMatching(/not installed or not on the PATH/) });
  });
});

describe("explainFailure", () => {
  it("recognises a Java version mismatch", () => {
    expect(explainFailure(1, ["Unsupported class file major version 67"])).toMatch(/different Java version/);
  });

  it("falls back to the exit code", () => {
    expect(explainFailure(3, ["something else"])).toMatch(/exit code 3/);
  });
});
