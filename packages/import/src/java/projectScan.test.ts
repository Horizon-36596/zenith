import { describe, expect, it } from "vitest";
import { commandLibraryImports, importedCommandLibrary, zenithRobotClasses } from "./projectScan.js";

const java = (path: string, text: string) => ({ path, text });

describe("zenithRobotClasses", () => {
  it("finds a public top-level class that implements ZenithRobot in the file named after it", () => {
    const sources = [
      java(
        "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/robot/TeamRobot.java",
        "package org.firstinspires.ftc.teamcode.robot;\n\npublic final class TeamRobot implements ZenithRobot {\n}\n",
      ),
      java("TeamCode/src/main/java/a/Base.java", "package a;\n\npublic abstract class Base implements ZenithRobot {\n}\n"),
      java("TeamCode/src/main/java/a/Helpers.java", "package a;\n\nclass Helpers implements ZenithRobot {\n}\n"),
      java("TeamCode/src/main/java/a/Elsewhere.java", "package a;\n\npublic class Other implements ZenithRobot {\n}\n"),
      java("TeamCode/src/main/java/NoPackage.java", "public class NoPackage implements ZenithRobot {\n}\n"),
      java("TeamCode/src/main/java/a/Commented.java", "package a;\n// public class Commented implements ZenithRobot {\n"),
    ];
    expect(zenithRobotClasses(sources)).toEqual(["org.firstinspires.ftc.teamcode.robot.TeamRobot"]);
  });

  it("sorts what it finds and lists each class once", () => {
    const one = java("a/B.java", "package a;\npublic class B implements ZenithRobot {}\n");
    const two = java("a/A.java", "package a;\npublic class A implements Runnable, ZenithRobot {}\n");
    expect(zenithRobotClasses([one, two, one])).toEqual(["a.A", "a.B"]);
  });
});

describe("importedCommandLibrary", () => {
  it("names SolversLib from an import of the Zenith SolversLib runtime or of SolversLib itself", () => {
    const runtime = java("T/MyRobot.java", "package t;\n\nimport org.horizon36596.zenith.solverslib.ZenithRobot;\n");
    expect(importedCommandLibrary([runtime])).toMatchObject({ library: "solverslib" });
    const library = java("T/Intake.java", "package t;\nimport com.seattlesolvers.solverslib.command.InstantCommand;\n");
    expect(importedCommandLibrary([library])).toMatchObject({ library: "solverslib" });
  });

  it("names Ivy from an import of the Zenith Ivy runtime or of Ivy itself, in Java or Kotlin", () => {
    const kotlin = java("T/Robot.kt", "package t\n\nimport org.horizon36596.zenith.ivy.ZenithRobot\n");
    expect(importedCommandLibrary([kotlin])).toMatchObject({ library: "ivy" });
    const staticImport = java("T/Commands.java", "package t;\nimport static com.pedropathing.ivy.Commands.*;\n");
    expect(importedCommandLibrary([staticImport])).toMatchObject({ library: "ivy" });
  });

  it("says where it found the import", () => {
    const runtime = java("T/MyRobot.java", "package t;\n\nimport org.horizon36596.zenith.ivy.NamedCommands;\n");
    expect(commandLibraryImports([runtime])).toEqual([
      { library: "ivy", name: "org.horizon36596.zenith.ivy.NamedCommands", at: { path: "T/MyRobot.java", line: 3 } },
    ]);
  });

  it("names none when no import names a library, so nothing is ever a default", () => {
    const plain = java(
      "T/TeamRobot.java",
      "package t;\n\nimport org.horizon36596.zenith.Args;\nimport com.qualcomm.robotcore.hardware.DcMotor;\n// import com.seattlesolvers.solverslib.command.Command;\n",
    );
    expect(importedCommandLibrary([plain])).toEqual({ library: null, found: [] });
    expect(importedCommandLibrary([])).toEqual({ library: null, found: [] });
  });

  it("names none when the imports name both libraries, and lists both", () => {
    const both = [
      java("T/A.java", "package t;\nimport org.horizon36596.zenith.solverslib.ZenithRobot;\n"),
      java("T/B.java", "package t;\nimport com.pedropathing.ivy.Command;\n"),
    ];
    const found = importedCommandLibrary(both);
    expect(found.library).toBeNull();
    expect(found.found.map((entry) => entry.library)).toEqual(["solverslib", "ivy"]);
  });

  it("does not take a package that only starts with the same letters", () => {
    const near = java("T/A.java", "package t;\nimport com.pedropathing.ivyx.Thing;\nimport org.horizon36596.zenith.solverslibs.X;\n");
    expect(importedCommandLibrary([near]).library).toBeNull();
  });
});
