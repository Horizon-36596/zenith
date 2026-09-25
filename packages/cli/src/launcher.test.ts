import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { findJava, LauncherError, MissingToolError, resolveLauncher, withRerun, type Platform } from "./launcher.js";

const WIN_ROOT = "C:\\robot";
const POSIX_ROOT = "/home/team/robot";

/** A fake host that has exactly `files` (compared case-insensitively on Windows, as NTFS does). */
function host(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, files: string[]): Platform {
  const fold = (path: string) => (platform === "win32" ? path.toLowerCase() : path);
  const set = new Set(files.map(fold));
  return { platform, env, exists: (path) => set.has(fold(path)) };
}

const WIN_ENV: NodeJS.ProcessEnv = { PATH: "C:\\Tools;C:\\Java\\bin", PATHEXT: ".EXE;.BAT;.CMD" };
const windows = (files: string[], env: NodeJS.ProcessEnv = WIN_ENV) => host("win32", env, files);
const linux = (files: string[], env: NodeJS.ProcessEnv = { PATH: "/usr/bin" }) => host("linux", env, files);

describe("resolveLauncher on Windows", () => {
  it("runs a .bat target through cmd.exe with /d /s /c, and only with words cmd.exe reads literally", () => {
    const launch = resolveLauncher(["sim", "--auto=close", "-Pfast"], WIN_ROOT, windows(["C:\\Tools\\sim.bat"]));
    expect(launch.file).toBe("cmd.exe");
    expect(launch.args).toEqual(["/d", "/s", "/c", "C:\\Tools\\sim.bat --auto=close -Pfast"]);
  });

  it("does the same for a .cmd target, and uses ComSpec when it is set", () => {
    const env = { PATH: "C:\\Tools", PATHEXT: ".EXE;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
    const launch = resolveLauncher(["run-sim", "close"], WIN_ROOT, windows(["C:\\Tools\\run-sim.cmd"], env));
    expect(launch.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(launch.args).toEqual(["/d", "/s", "/c", "C:\\Tools\\run-sim.cmd close"]);
  });

  it("refuses a batch file whose words cmd.exe would read as operators or variables", () => {
    const h = windows(["C:\\Tools\\sim.bat"]);
    for (const word of ["a&calc", "%PATH%", "x|y", "a b", '"q"', "!v!", "^", "(x)", "a>b"]) {
      expect(() => resolveLauncher(["sim", word], WIN_ROOT, h), word).toThrow(LauncherError);
      expect(() => resolveLauncher(["sim", word], WIN_ROOT, h), word).toThrow(/not safe to pass through cmd.exe/);
    }
  });

  it("refuses a batch file whose own path has a space in it", () => {
    const h = windows(["C:\\My Tools\\sim.bat"], { PATH: "C:\\My Tools", PATHEXT: ".BAT" });
    expect(() => resolveLauncher(["sim"], WIN_ROOT, h)).toThrow(/not safe/);
  });

  it("starts a Gradle wrapper as java on the wrapper jar, never through gradlew.bat", () => {
    const jar = win32.join(WIN_ROOT, "gradle", "wrapper", "gradle-wrapper.jar");
    const h = windows(["C:\\Java\\bin\\java.exe", jar]);
    const launch = resolveLauncher(["./gradlew", ":TeamCode:test", "-Dzenith.auto=close"], WIN_ROOT, h);
    expect(launch.file).toBe("C:\\Java\\bin\\java.exe");
    expect(launch.args).toEqual([
      "-Xmx64m",
      "-Xms64m",
      "-Dorg.gradle.appname=gradlew",
      "-classpath",
      jar,
      "org.gradle.wrapper.GradleWrapperMain",
      ":TeamCode:test",
      "-Dzenith.auto=close",
      "--rerun",
    ]);
    expect(launch.display).toBe("./gradlew :TeamCode:test -Dzenith.auto=close");
  });

  it("starts an .exe directly with its words as separate arguments", () => {
    const launch = resolveLauncher(["node", "fake sim.js", "a&b"], WIN_ROOT, windows(["C:\\Tools\\node.exe"]));
    expect(launch).toEqual({ file: "C:\\Tools\\node.exe", args: ["fake sim.js", "a&b"], display: "node fake sim.js a&b" });
  });

  it("says a command that is not installed is not installed", () => {
    expect(() => resolveLauncher(["gradle", "test"], WIN_ROOT, windows([]))).toThrow(MissingToolError);
    expect(() => resolveLauncher(["gradle", "test"], WIN_ROOT, windows([]))).toThrow(/not installed or not on the PATH/);
  });
});

describe("resolveLauncher elsewhere", () => {
  it("starts a plain executable as itself, every word one argument, with no shell string", () => {
    const argv = ["python3", "sim.py", "--auto", "close; rm -rf /", "$HOME"];
    const launch = resolveLauncher(argv, POSIX_ROOT, linux([]));
    expect(launch.file).toBe("python3");
    expect(launch.args).toEqual(["sim.py", "--auto", "close; rm -rf /", "$HOME"]);
    expect(launch.file).not.toMatch(/(^|[\\/])(sh|bash|cmd)(\.exe)?$/);
  });

  it("starts the gradlew script itself, with --rerun added once", () => {
    const jar = posix.join(POSIX_ROOT, "gradle", "wrapper", "gradle-wrapper.jar");
    const script = posix.join(POSIX_ROOT, "gradlew");
    const launch = resolveLauncher(["./gradlew", "test", "--rerun"], POSIX_ROOT, linux(["/usr/bin/java", jar, script]));
    expect(launch).toEqual({ file: script, args: ["test", "--rerun"], display: "./gradlew test --rerun" });
  });

  it("refuses an empty command", () => {
    expect(() => resolveLauncher([], POSIX_ROOT, linux([]))).toThrow(/is empty/);
  });
});

describe("findJava and withRerun", () => {
  it("prefers JAVA_HOME and names one that points nowhere", () => {
    const h = windows(["C:\\Jdk\\bin\\java.exe", "C:\\Java\\bin\\java.exe"], { JAVA_HOME: "C:\\Jdk", PATH: "C:\\Java\\bin" });
    expect(findJava(h)).toBe("C:\\Jdk\\bin\\java.exe");
    expect(() => findJava(linux([], { JAVA_HOME: "/nowhere", PATH: "/usr/bin" }))).toThrow(/JAVA_HOME is set to \/nowhere/);
    expect(() => findJava(linux([]))).toThrow(/needs Java/);
  });

  it("adds --rerun unless the command already forces a rerun", () => {
    expect(withRerun(["test"])).toEqual(["test", "--rerun"]);
    expect(withRerun(["test", "--rerun-tasks"])).toEqual(["test", "--rerun-tasks"]);
  });
});
