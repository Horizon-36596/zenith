/**
 * Turns `zenith.json`'s `sim.command`, already split into argv, into an executable and arguments
 * that `spawn` can start with `shell: false` on this platform. `zenith sim` and the desktop app's
 * High-fidelity sim button both launch through this, so a command that runs in one runs in the other.
 *
 * The argv safety rule holds throughout:
 * nothing here ever builds a shell string from the command's words, except for the one case Node
 * leaves no choice about, a Windows batch file, and that is refused unless every word is one cmd.exe
 * reads literally.
 *
 * Windows is the platform that needs this. `./gradlew` is a POSIX script and Node refuses to spawn a
 * `.bat` or `.cmd` file without a shell, so on Windows a Gradle-wrapper command runs the wrapper the
 * way `gradlew.bat` itself does, `java -classpath gradle/wrapper/gradle-wrapper.jar
 * org.gradle.wrapper.GradleWrapperMain`, which needs no shell and lets a missing Java be reported in
 * plain words before anything starts.
 */
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { splitShellWords } from "./commands/sim.js";

/** A sim command that cannot be launched, with a message written for the person running it. */
export class LauncherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherError";
  }
}

/** What a missing tool is, so the message can say what to install. */
export class MissingToolError extends LauncherError {
  constructor(
    readonly tool: "java" | "gradle" | "command",
    message: string,
  ) {
    super(message);
    this.name = "MissingToolError";
  }
}

export interface SimLaunch {
  /** The executable, absolute where Zenith resolved it. */
  file: string;
  args: string[];
  /** The command as the team wrote it, with `{auto}` filled in, for a progress header. */
  display: string;
}

/** The host facts the launcher depends on, so tests can play Windows on Linux and the reverse. */
export interface Platform {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
}

export const hostPlatform = (): Platform => ({ platform: process.platform, env: process.env, exists: existsSync });

const JAVA_MISSING =
  "High-fidelity sim runs the robot code's own simulator, which needs Java, and no Java was found on this computer. Install a Java 17 or newer JDK (Eclipse Temurin is free), then try again.";

/** The `java` executable Gradle would use: `JAVA_HOME` first, then the `PATH`. */
export function findJava(host: Platform = hostPlatform()): string {
  const path = host.platform === "win32" ? win32 : posix;
  const exe = host.platform === "win32" ? "java.exe" : "java";
  const javaHome = host.env["JAVA_HOME"];
  if (javaHome !== undefined && javaHome.trim() !== "") {
    const candidate = path.join(javaHome.trim().replace(/^"|"$/g, ""), "bin", exe);
    if (host.exists(candidate)) return candidate;
    throw new MissingToolError(
      "java",
      `JAVA_HOME is set to ${javaHome}, but there is no ${exe} in its bin folder. Point JAVA_HOME at a Java 17 or newer JDK, or remove it, then try again.`,
    );
  }
  const pathVar = host.env["PATH"] ?? host.env["Path"] ?? "";
  for (const dir of pathVar.split(host.platform === "win32" ? ";" : ":")) {
    if (dir.trim() === "") continue;
    const candidate = path.join(dir.trim().replace(/^"|"$/g, ""), exe);
    if (host.exists(candidate)) return candidate;
  }
  throw new MissingToolError("java", JAVA_MISSING);
}

const GRADLEW = /^(?:\.[\\/])?gradlew(?:\.bat)?$/;

/** A word cmd.exe passes through untouched: no spaces, quotes, `%`, `!`, `^`, `&`, `|`, `<`, `>` or parentheses. */
const CMD_SAFE = /^[A-Za-z0-9_.:=/\\*+,@-]+$/;

/** Finds `name` on the PATH the way Windows does, trying each PATHEXT extension. */
function whichWindows(name: string, host: Platform): string | null {
  const exts = (host.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext !== "");
  const hasExt = /\.[A-Za-z0-9]+$/.test(name);
  const dirs = (host.env["PATH"] ?? host.env["Path"] ?? "").split(";").filter((dir) => dir.trim() !== "");
  for (const dir of dirs) {
    for (const ext of hasExt ? [""] : exts) {
      const candidate = win32.join(dir.trim().replace(/^"|"$/g, ""), name + ext.toLowerCase());
      if (host.exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Gradle skips a test task whose inputs have not changed since it last passed, and then no trace is
 * written: running the sim again on an unchanged auto would only ever report a stale trace. Gradle's
 * built-in `--rerun` task option (Gradle 7.6 and later) runs the task regardless. It is added last,
 * where it binds to the command's last task, unless the command already forces a rerun itself.
 */
export function withRerun(args: readonly string[]): string[] {
  return args.some((arg) => arg === "--rerun" || arg === "--rerun-tasks") ? [...args] : [...args, "--rerun"];
}

/**
 * Turns the command's argv into something `spawn` can start with `shell: false` on this platform,
 * and fails with a plain-language `LauncherError` when the tool it needs is missing or the command
 * cannot be started safely.
 */
export function resolveLauncher(argv: readonly string[], root: string, host: Platform = hostPlatform()): SimLaunch {
  const [command, ...rest] = argv;
  if (command === undefined) throw new LauncherError('zenith.json "sim.command" is empty.');
  const display = argv.join(" ");

  if (GRADLEW.test(command)) {
    const gradleArgs = withRerun(rest);
    const path = host.platform === "win32" ? win32 : posix;
    const jar = path.join(root, "gradle", "wrapper", "gradle-wrapper.jar");
    if (!host.exists(jar)) {
      throw new MissingToolError(
        "gradle",
        "This robot repository has no Gradle wrapper (gradle/wrapper/gradle-wrapper.jar), so the sim cannot start. Check that the whole repository was cloned, or open it once in Android Studio.",
      );
    }
    const java = findJava(host);
    if (host.platform !== "win32") {
      const script = path.join(root, "gradlew");
      if (!host.exists(script)) {
        throw new MissingToolError("gradle", "This robot repository has no gradlew script, so the sim cannot start.");
      }
      return { file: script, args: gradleArgs, display };
    }
    // The same launch gradlew.bat performs, minus cmd.exe: its default JVM options, the app name
    // Gradle prints in its help, the wrapper jar on the classpath, then the command's own arguments.
    const extra = [host.env["JAVA_OPTS"], host.env["GRADLE_OPTS"]]
      .filter((value): value is string => value !== undefined && value.trim() !== "")
      .flatMap((value) => splitShellWords(value));
    return {
      file: java,
      args: [
        "-Xmx64m",
        "-Xms64m",
        ...extra,
        "-Dorg.gradle.appname=gradlew",
        "-classpath",
        jar,
        "org.gradle.wrapper.GradleWrapperMain",
        ...gradleArgs,
      ],
      display,
    };
  }

  if (host.platform !== "win32") return { file: command, args: rest, display };

  const resolved = /[\\/]/.test(command) ? win32.resolve(root, command) : whichWindows(command, host);
  if (resolved === null || !host.exists(resolved)) {
    throw new MissingToolError(
      command.toLowerCase().startsWith("gradle") ? "gradle" : "command",
      `The sim command starts with "${command}", which is not installed or not on the PATH.${
        command.toLowerCase().startsWith("gradle")
          ? " Install Gradle, or change zenith.json's sim.command to use the repository's ./gradlew."
          : ""
      }`,
    );
  }
  if (/\.(?:bat|cmd)$/i.test(resolved)) {
    // Node cannot start a batch file without cmd.exe. Allow it only when every word is one cmd.exe
    // reads literally, so nothing in the command can be taken as an operator.
    const bad = rest.find((word) => !CMD_SAFE.test(word));
    if (bad !== undefined || /[\s"%!^&|<>()]/.test(resolved)) {
      throw new LauncherError(
        `The sim command runs a batch file, and "${bad ?? resolved}" is not safe to pass through cmd.exe. Use ./gradlew in zenith.json's sim.command instead.`,
      );
    }
    return {
      file: host.env["ComSpec"] ?? "cmd.exe",
      args: ["/d", "/s", "/c", [resolved, ...rest].join(" ")],
      display,
    };
  }
  return { file: resolved, args: rest, display };
}
