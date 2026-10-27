import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isScannableSource, isSkippedSourcePath, scanCommands, type SourceFile } from "./scanCommands.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const fixtureRoot = fileURLToPath(new URL("../../fixtures/java/", import.meta.url));

/** Every scannable file under `dir`, with its path relative to `base`, the way the CLI reads a tree. */
function readTree(dir: string, base: string, skip = true): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const path = relative(base, full).split("\\").join("/");
        if (isScannableSource(path) && !(skip && isSkippedSourcePath(path))) out.push({ path, text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(dir);
  return out;
}

const fixture = (dir: string): SourceFile[] => readTree(join(fixtureRoot, dir), fixtureRoot);

describe("scanCommands: the robot/README.md pattern", () => {
  const scan = scanCommands(fixture("readme"));

  it("finds each command and condition with its line", () => {
    expect(scan.commands.map((command) => [command.name, command.at])).toEqual([
      ["intakeOn", [{ path: "readme/MyRobot.java", line: 17 }]],
      ["score", [{ path: "readme/MyRobot.java", line: 18 }]],
    ]);
    expect(scan.conditions).toEqual([{ name: "holdingPiece", at: [{ path: "readme/MyRobot.java", line: 20 }] }]);
  });

  it("reads the argument score's factory needs, as required", () => {
    const score = scan.commands.find((command) => command.name === "score");
    expect(score?.params).toEqual([{ key: "count", type: "integer", required: true, at: { path: "readme/MyRobot.java", line: 19 } }]);
    expect(score?.complete).toBe(true);
    expect(scan.commands.find((command) => command.name === "intakeOn")?.params).toEqual([]);
  });

  it("has nothing to report", () => {
    expect(scan.issues).toEqual([]);
    expect(scan.unresolvedRegistrations).toBe(0);
    expect(scan.filesScanned).toBe(1);
  });
});

describe("scanCommands: BIOBUZZ-style registrations", () => {
  const scan = scanCommands(fixture("biobuzz"));
  const command = (name: string) => scan.commands.find((entry) => entry.name === name);

  it("finds every command the BIOBUZZ robot.json names, however it is registered", () => {
    expect(scan.commands.map((entry) => entry.name)).toEqual([
      "assumeTipped",
      "cancelAll",
      "launcherIdle",
      "relocalize",
      "setIntake",
      "shootAll",
    ]);
    expect(scan.conditions.map((entry) => entry.name)).toEqual(["hopperEmpty", "hopperFull", "tipSeen"]);
  });

  it("reads a block lambda's required and optional arguments", () => {
    expect(command("shootAll")?.params.map(({ at, ...param }) => param)).toEqual([
      { key: "count", type: "integer", required: true },
      { key: "cadence", type: "string", required: false, default: "precise" },
    ]);
  });

  it("reads enum arguments with their constants, a null fallback and a constant fallback", () => {
    expect(command("setIntake")?.params.map(({ at, ...param }) => param)).toEqual([
      { key: "side", type: "enum", required: false, values: ["FRONT", "BACK", "BOTH"], enumType: "Intake.Side" },
      { key: "state", type: "enum", required: false, default: "STOP", values: ["STOP", "FORWARD", "REVERSE"], enumType: "Intake.MotorState" },
    ]);
  });

  it("follows a method reference and an anonymous factory, and marks them complete", () => {
    expect(command("launcherIdle")).toMatchObject({ params: [], complete: true });
    expect(command("cancelAll")).toMatchObject({ params: [], complete: true });
  });

  it("reads a name given as a constant", () => {
    expect(command("relocalize")?.at).toEqual([{ path: "biobuzz/BiobuzzRobot.java", line: 46 }]);
    expect(scan.conditions.find((entry) => entry.name === "tipSeen")?.at).toEqual([{ path: "biobuzz/BiobuzzRobot.java", line: 56 }]);
  });

  it("has nothing to report", () => {
    expect(scan.issues).toEqual([]);
  });
});

describe("scanCommands: code a scanner must read carefully", () => {
  const scan = scanCommands(fixture("tricky"));
  const command = (name: string) => scan.commands.find((entry) => entry.name === name);
  const issuesOf = (name: string) => scan.issues.filter((entry) => entry.command === name).map((entry) => entry.code);

  it("ignores registrations in comments and strings", () => {
    const names = scan.commands.map((entry) => entry.name);
    expect(names).not.toContain("commentedOut");
    expect(names).not.toContain("blockCommented");
    expect(names).not.toContain("inAString");
  });

  it("reads names built from constants in another class and from concatenation", () => {
    expect(scan.commands.map((entry) => entry.name)).toEqual([
      "delegated",
      "driveForward",
      "lift",
      "offset",
      "park",
      "raw",
      "spinUp",
      "twiceA",
      "twiceB",
      "waitFor",
    ]);
  });

  it("reads keys and fallbacks given as constants, and follows a helper method", () => {
    expect(command("driveForward")?.params.map(({ at, ...param }) => param)).toEqual([
      { key: "distanceIn", type: "number", required: true },
      { key: "speed", type: "number", required: false, default: 0.8 },
    ]);
    expect(command("park")?.params.map(({ at, ...param }) => param)).toEqual([{ key: "zone", type: "string", required: true }]);
    expect(command("offset")?.params[0]).toMatchObject({ key: "byIn", default: -2.5 });
  });

  it("follows a factory held in a field", () => {
    expect(command("waitFor")?.params.map(({ at, ...param }) => param)).toEqual([
      { key: "seconds", type: "number", required: false, default: 0.5 },
    ]);
  });

  it("follows a wrapper method to each call, with the name it is given", () => {
    expect(command("twiceA")?.at).toEqual([{ path: "tricky/TrickyRobot.java", line: 38 }]);
    expect(command("twiceB")?.params.map((param) => param.key)).toEqual(["label"]);
    expect(issuesOf("twiceA")).toEqual([]);
  });

  it("reports a name it cannot read instead of guessing", () => {
    const unresolved = scan.issues.filter((entry) => entry.code === "NAME_UNRESOLVED");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.at).toEqual({ path: "tricky/TrickyRobot.java", line: 36 });
    expect(unresolved[0]?.message).toContain("name is a parameter or a loop variable");
    expect(scan.unresolvedRegistrations).toBe(1);
  });

  it("says when a helper is told a different command name", () => {
    expect(issuesOf("lift")).toEqual(["COMMAND_ARG_MISMATCH"]);
    expect(command("lift")?.params[0]).toMatchObject({ key: "level", type: "integer" });
  });

  it("says when the argument map is read directly or handed on, and marks the command incomplete", () => {
    expect(issuesOf("raw")).toEqual(["RAW_ARG_READ"]);
    expect(scan.issues.find((entry) => entry.command === "raw")?.message).toContain('"power"');
    expect(command("raw")?.complete).toBe(false);
    expect(issuesOf("delegated")).toEqual(["ARGS_PASSED_ON"]);
    expect(command("delegated")?.complete).toBe(false);
    expect(command("spinUp")?.complete).toBe(true);
  });
});

describe("scanCommands: Kotlin", () => {
  const scan = scanCommands(fixture("kotlin"));

  it("reads trailing lambdas, const vals and enum classes, and skips nested comments", () => {
    expect(scan.commands.map((entry) => [entry.name, entry.params.map(({ at, ...param }) => param)])).toEqual([
      ["feed", [{ key: "count", type: "integer", required: true }]],
      ["gate", [{ key: "position", type: "enum", required: false, default: "CLOSED", values: ["OPEN", "CLOSED"], enumType: "Gate" }]],
    ]);
    expect(scan.conditions.map((entry) => entry.name)).toEqual(["gateOpen"]);
  });

  it("refuses a string template as a name", () => {
    expect(scan.issues.map((entry) => [entry.code, entry.at.line])).toEqual([["NAME_UNRESOLVED", 20]]);
    expect(scan.issues[0]?.message).toContain("string template");
  });
});

describe("scanCommands: the repository's own Java", () => {
  it("reads the runtimes' test robots and skips the runtimes' own declarations and javadoc", () => {
    const scan = scanCommands(readTree(join(repoRoot, "robot"), repoRoot, false));
    const names = scan.commands.map((entry) => entry.name);
    expect(names).toContain("intakeOn");
    expect(names).toContain("score");
    const score = scan.commands.find((entry) => entry.name === "score");
    expect(score?.params.map(({ at, ...param }) => param)).toEqual([{ key: "level", type: "integer", required: true }]);
    expect(scan.conditions.map((entry) => entry.name)).toContain("holdingPiece");
    // The conformance runs register every name of a scripted world in a loop: reported, not guessed.
    expect(scan.unresolvedRegistrations).toBeGreaterThan(0);
    expect(scan.issues.filter((entry) => entry.code === "NAME_UNRESOLVED").every((entry) => entry.at.path.includes("/src/test/"))).toBe(true);
  });

  it("finds nothing in the runtimes' main sources, which only declare the API", () => {
    const scan = scanCommands(readTree(join(repoRoot, "robot"), repoRoot, true));
    expect(scan.commands).toEqual([]);
    expect(scan.conditions).toEqual([]);
    expect(scan.issues).toEqual([]);
  });

  it("gives the same result whatever order the files come in", () => {
    const files = fixture("tricky");
    expect(scanCommands([...files].reverse())).toEqual(scanCommands(files));
  });
});

describe("isSkippedSourcePath", () => {
  it("skips build output, dot directories and test sources, and keeps main sources", () => {
    expect(isSkippedSourcePath("TeamCode/src/main/java/org/x/MyRobot.java")).toBe(false);
    expect(isSkippedSourcePath("TeamCode/build/generated/Foo.java")).toBe(true);
    expect(isSkippedSourcePath(".git/x/Foo.java")).toBe(true);
    expect(isSkippedSourcePath("TeamCode/src/test/java/Foo.java")).toBe(true);
    expect(isSkippedSourcePath("TeamCode/src/androidTest/java/Foo.java")).toBe(true);
    expect(isSkippedSourcePath("./TeamCode/src/main/java/Foo.java")).toBe(false);
    expect(isScannableSource("A.kt")).toBe(true);
    expect(isScannableSource("A.kts")).toBe(false);
  });
});

describe("scanCommands: scope, found in review", () => {
  const scan = (files: SourceFile[]) => scanCommands(files);

  it("reads a bare helper after a Java ternary, which is a call and not a nullable type", () => {
    const result = scan([
      {
        path: "A.java",
        text: `import static org.horizon36596.zenith.solverslib.NamedCommands.argDouble;
import org.horizon36596.zenith.solverslib.NamedCommands;
class A { void r() {
  NamedCommands.register("shoot", (args, ctx) -> fire(fast ? argDouble(args, "shoot", "rpm") : 0));
} }`,
      },
    ]);
    expect(result.commands[0]?.params.map((param) => param.key)).toEqual(["rpm"]);
  });

  it("does not read a field set in a constructor as another class's constant of the same name", () => {
    const result = scan([
      { path: "Other.java", text: `class Other { static final String name = "foo"; }` },
      {
        path: "Robot.java",
        text: `import org.horizon36596.zenith.solverslib.NamedCommands;
class Robot {
  private final String name;
  Robot(String name) { this.name = name; }
  void r() { NamedCommands.register(name, (args, ctx) -> null); }
}`,
      },
    ]);
    expect(result.commands).toEqual([]);
    expect(result.issues.map((entry) => entry.code)).toEqual(["NAME_UNRESOLVED"]);
  });

  it("reads another class's constant when the file imports it statically", () => {
    const result = scan([
      { path: "org/team/Names.java", text: `package org.team; public final class Names { public static final String PARK = "park"; }` },
      {
        path: "org/team/Robot.java",
        text: `package org.team;
import static org.team.Names.PARK;
import org.horizon36596.zenith.solverslib.NamedCommands;
class Robot { void r() { NamedCommands.register(PARK, (args, ctx) -> null); } }`,
      },
      {
        path: "org/team/NamesLookalike.java",
        text: `package org.team; final class MyNames { static final String PARK = "other"; }`,
      },
    ]);
    expect(result.commands.map((entry) => entry.name)).toEqual(["park"]);
  });

  it("does not let a local of one method name a registration in a Kotlin init block", () => {
    const result = scan([
      {
        path: "Robot.kt",
        text: `import org.horizon36596.zenith.ivy.NamedCommands
class Robot(label: String) {
    fun other() {
        val label = "x"
    }
    init {
        NamedCommands.register(label) { _, _ -> Nothing() }
    }
}`,
      },
    ]);
    expect(result.commands).toEqual([]);
    expect(result.unresolvedRegistrations).toBe(1);
  });

  it("keeps a package called build inside a source set", () => {
    expect(isSkippedSourcePath("TeamCode/src/main/java/org/team/build/Robot.java")).toBe(false);
    expect(isSkippedSourcePath("TeamCode/build/intermediates/Robot.java")).toBe(true);
  });
});
