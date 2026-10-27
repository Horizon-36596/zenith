import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalize } from "@horizon36596/zenith-core";
import { parseRobot, type Robot } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProject, simpleAuto } from "../testSupport.js";
import { importCommands, runImportCommands } from "./importCommands.js";
import { runValidate } from "./validate.js";

let root = "";
let out: string[] = [];

const ROBOT_JAVA = `package org.firstinspires.ftc.teamcode.zenith;

import org.horizon36596.zenith.solverslib.NamedCommands;

public class TestRobot {
    enum Side { FRONT, BACK, BOTH }

    public void registerCommands() {
        NamedCommands.register("shootAll", (args, ctx) -> shoot(NamedCommands.argInt(args, "shootAll", "count")));
        NamedCommands.register("setIntake", (args, ctx) ->
                intake(NamedCommands.argEnum(args, "setIntake", "side", Side.class, Side.BOTH)));
        NamedCommands.register("park", (args, ctx) -> park(NamedCommands.argString(args, "park", "zone")));
        NamedCommands.registerCondition("hopperFull", intake::isFull);
        NamedCommands.registerCondition("tipSeen", () -> false);
    }
}
`;

const FAKE_JAVA = `import org.horizon36596.zenith.solverslib.NamedCommands;
class FakeRobot {
    void registerCommands() {
        NamedCommands.register("fakeOnly", (args, ctx) -> null);
    }
}
`;

const write = (path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, "utf8");
};
const robotText = (): string => readFileSync(join(root, "autos/robot.json"), "utf8");
const robot = (): Robot => parseRobot(JSON.parse(robotText()));
const lastJson = (): Record<string, unknown> => JSON.parse(out.join("")) as Record<string, unknown>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zenith-import-commands-"));
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  makeProject(root);
  write("TeamCode/src/main/java/org/firstinspires/ftc/teamcode/zenith/TestRobot.java", ROBOT_JAVA);
  write("TeamCode/src/test/java/FakeRobot.java", FAKE_JAVA);
  write("TeamCode/build/generated/Generated.java", FAKE_JAVA);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("zenith import-commands --check", () => {
  it("lists what robot.json is missing, writes nothing, and exits 1", () => {
    const before = robotText();
    expect(runImportCommands(["TeamCode"], { cwd: root, check: true, json: true })).toBe(1);
    expect(robotText()).toBe(before);
    const result = lastJson();
    expect(result["written"]).toBeNull();
    expect((result["changes"] as Array<{ kind: string; name: string; key?: string }>).map((change) => [change.kind, change.name, change.key])).toEqual([
      ["addParam", "setIntake", "side"],
      ["addCommand", "park", undefined],
      ["addCondition", "tipSeen", undefined],
    ]);
    expect(result["filesScanned"]).toBe(1);
  });

  it("skips test sources and build output", () => {
    const result = importCommands(["TeamCode"], { cwd: root, check: true });
    expect(result.commands.map((command) => command.name)).not.toContain("fakeOnly");
  });

  it("exits 0 once robot.json agrees", () => {
    expect(runImportCommands(["TeamCode"], { cwd: root })).toBe(0);
    out = [];
    expect(runImportCommands(["TeamCode"], { cwd: root, check: true })).toBe(0);
    expect(out.join("")).toContain("already declares everything the Java registers");
  });
});

describe("zenith import-commands", () => {
  it("adds what is missing, canonically, and keeps what a person wrote", () => {
    expect(runImportCommands([], { cwd: root })).toBe(0);
    const text = robotText();
    expect(canonicalize("robot", parseRobot(JSON.parse(text)))).toBe(text);
    const written = robot();
    const shootAll = written.commands.find((command) => command.name === "shootAll");
    expect(shootAll).toEqual({
      name: "shootAll",
      params: { count: { type: "integer", min: 1, max: 4 } },
      estimateS: "0.6 + count",
      stationary: true,
      ledger: { launches: "count" },
    });
    expect(written.commands.find((command) => command.name === "setIntake")).toEqual({
      name: "setIntake",
      params: {
        side: {
          type: "enum",
          values: ["FRONT", "BACK", "BOTH"],
          default: "BOTH",
          provenance: "SET FROM TeamCode/src/main/java/org/firstinspires/ftc/teamcode/zenith/TestRobot.java",
        },
      },
      estimateS: "0",
    });
    expect(written.commands.find((command) => command.name === "park")).toEqual({
      name: "park",
      params: { zone: { type: "string" } },
      estimateS: "unknown",
      provenance: "SET FROM TeamCode/src/main/java/org/firstinspires/ftc/teamcode/zenith/TestRobot.java; estimateS NEEDS MEASUREMENT",
    });
    expect(written.conditions?.map((condition) => condition.name)).toEqual(["hopperFull", "tipSeen"]);
  });

  it("prints the changes and, with --diff, the lines of robot.json they touch", () => {
    runImportCommands(["TeamCode"], { cwd: root, check: true, diff: true });
    const text = out.join("");
    expect(text).toContain("autos/robot.json is missing:");
    expect(text).toContain("Add the command park with zone, estimate \"unknown\"");
    expect(text).toContain('+      "name": "park",');
    expect(text).toContain("Run zenith import-commands without --check to add them.");
  });

  it("exits 1 when robot.json declares a command the Java does not register, and removes nothing", () => {
    write(
      "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/zenith/TestRobot.java",
      ROBOT_JAVA.replace(/\s+NamedCommands\.register\("setIntake"[\s\S]*?Side\.BOTH\)\)\);/, ""),
    );
    expect(runImportCommands(["TeamCode"], { cwd: root, json: true })).toBe(1);
    const findings = lastJson()["findings"] as Array<{ severity: string; name?: string }>;
    expect(findings.filter((finding) => finding.severity === "error").map((finding) => finding.name)).toEqual(["setIntake"]);
    expect(robot().commands.map((command) => command.name)).toContain("setIntake");
  });

  it("refuses a directory outside the project", () => {
    expect(() => importCommands([tmpdir()], { cwd: root })).toThrow(/outside the project root/);
  });
});

describe("zenith validate --java", () => {
  it("checks robot.json against the Java as one more file, with REGISTRY findings", () => {
    expect(runValidate([], { cwd: root, java: ["TeamCode"], json: true })).toBe(0);
    const body = lastJson() as { files: Array<{ path: string; findings: Array<{ code: string; severity: string; stepId: string }> }> };
    expect(body.files.map((file) => file.path)).toEqual(["autos/robot.json"]);
    const findings = body.files[0]?.findings ?? [];
    expect(findings.every((finding) => finding.code === "REGISTRY")).toBe(true);
    expect(findings.map((finding) => [finding.severity, finding.stepId])).toEqual([
      ["warning", "command:setIntake.side"],
      ["warning", "command:park"],
      ["warning", "condition:tipSeen"],
    ]);
  });

  it("fails on a declared command the Java does not register", () => {
    write("TeamCode/src/main/java/org/firstinspires/ftc/teamcode/zenith/TestRobot.java", ROBOT_JAVA.replace('"shootAll", (args', '"shoot", (args'));
    expect(runValidate([], { cwd: root, java: ["TeamCode"] })).toBe(1);
    expect(out.join("")).toMatch(/error\s+REGISTRY\s+command:shootAll/);
  });

  it("still needs an auto or --java", () => {
    expect(() => runValidate([], { cwd: root })).toThrow(/at least one auto/);
  });
});

describe("zenith import-commands on a robot.json that is not canonical", () => {
  it("says that writing it also reformats it", () => {
    writeFileSync(join(root, "autos/robot.json"), JSON.stringify(JSON.parse(robotText())), "utf8");
    expect(importCommands(["TeamCode"], { cwd: root, check: true }).reformats).toBe(true);
    runImportCommands(["TeamCode"], { cwd: root });
    expect(importCommands(["TeamCode"], { cwd: root, check: true }).reformats).toBe(false);
  });
});

describe("zenith.json's javaDir", () => {
  const simple = () => simpleAuto("demo");
  const setJavaDir = (javaDir: unknown): void => {
    const link = JSON.parse(readFileSync(join(root, "zenith.json"), "utf8")) as Record<string, unknown>;
    link["javaDir"] = javaDir;
    writeFileSync(join(root, "zenith.json"), JSON.stringify(link), "utf8");
  };
  const registry = () => {
    const body = lastJson() as {
      files: Array<{ path: string; findings: Array<{ code: string; severity: string; stepId: string; message: string }> }>;
    };
    return body.files.find((file) => file.path === "autos/robot.json");
  };

  it("changes nothing when it is not set: validate checks only the autos", () => {
    write("autos/demo.auto.json", JSON.stringify(simple()));
    runValidate(["autos/demo.auto.json"], { cwd: root, json: true });
    expect(registry()).toBeUndefined();
  });

  it("makes validate check robot.json against the Java with no --java flag", () => {
    setJavaDir("TeamCode/src/main/java");
    write("autos/demo.auto.json", JSON.stringify(simple()));
    runValidate(["autos/demo.auto.json"], { cwd: root, json: true });
    expect(registry()?.findings.map((finding) => finding.stepId)).toEqual(["command:setIntake.side", "command:park", "condition:tipSeen"]);
  });

  it("takes a list, and --java wins over it", () => {
    setJavaDir(["nowhere", "TeamCode/src/main/java"]);
    write("autos/demo.auto.json", JSON.stringify(simple()));
    runValidate(["autos/demo.auto.json"], { cwd: root, json: true });
    const findings = registry()?.findings ?? [];
    expect(findings[0]).toMatchObject({ severity: "warning", stepId: "(javaDir)" });
    expect(findings[0]?.message).toContain("nowhere");
    out = [];
    runValidate(["autos/demo.auto.json"], { cwd: root, java: ["TeamCode/src/test"], json: true });
    // The test sources are skipped, so the flag's directory has no registrations: every declared name is missing.
    expect(registry()?.findings.filter((finding) => finding.severity === "error").map((finding) => finding.stepId)).toEqual([
      "command:shootAll",
      "command:setIntake",
      "condition:hopperFull",
    ]);
  });

  it("warns, and does not fail validate, when the directory is not there", () => {
    setJavaDir("../robot-code/TeamCode");
    write("autos/demo.auto.json", JSON.stringify(simple()));
    expect(runValidate(["autos/demo.auto.json"], { cwd: root, json: true })).toBe(0);
    expect(registry()?.findings).toEqual([expect.objectContaining({ severity: "warning", code: "REGISTRY", stepId: "(javaDir)" })]);
  });

  it("may point outside the project, since it is only read", () => {
    const outside = mkdtempSync(join(tmpdir(), "zenith-java-outside-"));
    try {
      mkdirSync(join(outside, "src/main/java"), { recursive: true });
      writeFileSync(join(outside, "src/main/java/TestRobot.java"), ROBOT_JAVA, "utf8");
      setJavaDir(outside);
      write("autos/demo.auto.json", JSON.stringify(simple()));
      runValidate(["autos/demo.auto.json"], { cwd: root, json: true });
      expect(registry()?.findings.map((finding) => finding.stepId)).toContain("command:park");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("is what import-commands scans by default, and a missing one is a usage error there", () => {
    setJavaDir("TeamCode/src/main/java");
    expect(importCommands([], { cwd: root, check: true }).changes.map((change) => change.name)).toEqual(["setIntake", "park", "tipSeen"]);
    setJavaDir("nowhere");
    expect(() => importCommands([], { cwd: root, check: true })).toThrow(/javaDir names nowhere/);
  });
});
