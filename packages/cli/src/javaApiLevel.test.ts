import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAuto, parseField, parseRobot, parseWaypoints, SCHEMA_ID } from "@horizon36596/zenith-schema";
import { plan as corePlan, resolve } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { generateAutoJava } from "./javaCodegen.js";
import { TEST_FIELD, TEST_ROBOT, TEST_WAYPOINTS } from "./testSupport.js";

/**
 * A Control Hub runs Android API 24. The robot runtime's own build enforces that with Android lint's
 * NewApi check, but lint accepts calls that the Android build tools' D8 backports (Map.of, List.of,
 * String.join and more), and whether a team's build backports them depends on its Android Gradle Plugin.
 * Generated code is compiled by the team's build, not the runtime's, so neither it nor the runtime may
 * depend on a backport. This list is the calls that need API 25 or later, or Java 9 or later.
 */
const DENYLIST: ReadonlyArray<readonly [string, RegExp]> = [
  ["Map.of / Map.ofEntries / Map.entry / Map.copyOf (API 30)", /\bMap\s*\.\s*(?:<[^>]*>\s*)?(?:of|ofEntries|entry|copyOf)\s*\(/],
  ["List.of / List.copyOf (API 30)", /\bList\s*\.\s*(?:<[^>]*>\s*)?(?:of|copyOf)\s*\(/],
  ["Set.of / Set.copyOf (API 30)", /\bSet\s*\.\s*(?:<[^>]*>\s*)?(?:of|copyOf)\s*\(/],
  ["String.join (API 26)", /\bString\s*\.\s*join\s*\(/],
  ["String.repeat / isBlank / strip / lines (Java 11)", /\.\s*(?:repeat|isBlank|strip|stripLeading|stripTrailing|lines)\s*\(/],
  ["Optional.orElseThrow() / ifPresentOrElse / isEmpty (Java 10+)", /\.\s*(?:orElseThrow\s*\(\s*\)|ifPresentOrElse\s*\()/],
  ["Stream.toList / takeWhile / dropWhile (Java 9+)", /\.\s*(?:toList\s*\(\s*\)|takeWhile\s*\(|dropWhile\s*\()/],
  ["Collectors.toUnmodifiable* (Java 10)", /\bCollectors\s*\.\s*toUnmodifiable/],
  ["readAllBytes / transferTo (Java 9)", /\.\s*(?:readAllBytes|transferTo)\s*\(/],
  ["Objects.requireNonNullElse* / checkIndex (Java 9+)", /\bObjects\s*\.\s*(?:requireNonNullElse|requireNonNullElseGet|checkIndex)\s*\(/],
  ["java.time (API 26)", /\bjava\s*\.\s*time\b/],
  ["java.nio.file (API 26)", /\bjava\s*\.\s*nio\s*\.\s*file\b/],
  ["java.util.Base64 (API 26)", /\bjava\s*\.\s*util\s*\.\s*Base64\b/],
  ["var declarations (Java 10)", /(?:^|[;{(\s])var\s+[A-Za-z_]\w*\s*=/m],
];

/** Java source with comments and string literals blanked, so a javadoc that names Map.of is not a hit. */
function codeOnly(java: string): string {
  return java
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

function hits(java: string): string[] {
  const code = codeOnly(java);
  return DENYLIST.filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
}

const here = dirname(fileURLToPath(import.meta.url));
/** The three source trees of the robot runtime (robot/README.md), and how many files each has at least. */
const runtimeDirs: ReadonlyArray<readonly [string, number]> = [
  [join(here, "../../../robot/auto-runtime/src/main/java/org/horizon36596/zenith/solverslib"), 10],
  [join(here, "../../../robot/auto-runtime/src/shared/java/org/horizon36596/zenith"), 8],
  [join(here, "../../../robot/ivy-runtime/src/main/java/org/horizon36596/zenith/ivy"), 10],
];

/** Every step kind codegen emits: path with a marker and a timeout, commands with and without args,
 * both waits, all three parallel modes, a sequence and a branch. */
function everyStepKind(commandLibrary: "solverslib" | "ivy" = "solverslib") {
  const auto = parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 2,
    name: "every-kind",
    alliance: "RED",
    start: { pose: { ref: "start" } },
    steps: [
      {
        id: "toShoot",
        kind: "path",
        timeoutS: 3,
        segments: [{ kind: "line", from: { ref: "start" }, to: { ref: "shoot" } }],
        heading: { mode: "tangent" },
        markers: [{ at: { t: 0.5 }, command: { name: "setIntake", args: { side: "BACK", state: "FORWARD" } } }],
      },
      { id: "volley", kind: "command", name: "shootAll", args: { count: 3 } },
      { id: "bare", kind: "command", name: "stopAll" },
      { id: "settle", kind: "wait", seconds: 0.25 },
      { id: "untilFull", kind: "wait", until: "hopperFull" },
      {
        id: "together",
        kind: "parallel",
        mode: "all",
        steps: [
          { id: "a", kind: "wait", seconds: 0.1 },
          { id: "b", kind: "command", name: "stopAll" },
        ],
      },
      {
        id: "first",
        kind: "parallel",
        mode: "race",
        steps: [
          { id: "c", kind: "wait", seconds: 0.1 },
          { id: "d", kind: "wait", until: "hopperFull" },
        ],
      },
      {
        id: "park",
        kind: "parallel",
        mode: "deadline",
        deadline: "drive",
        steps: [
          {
            id: "drive",
            kind: "path",
            segments: [{ kind: "line", from: "current", to: { ref: "start" } }],
            heading: { mode: "tangent" },
          },
          {
            id: "cycle",
            kind: "sequence",
            steps: [{ id: "e", kind: "command", name: "stopAll" }],
          },
        ],
      },
      {
        id: "check",
        kind: "branch",
        condition: "hopperFull",
        then: [{ id: "f", kind: "command", name: "shootAll", args: { count: 1 } }],
        else: [{ id: "g", kind: "wait", seconds: 0.1 }],
      },
    ],
  });
  const planned = corePlan(
    resolve(auto, parseWaypoints(TEST_WAYPOINTS)),
    parseRobot(TEST_ROBOT),
    parseField(TEST_FIELD),
  );
  return generateAutoJava(planned, {
    packageName: "org.example.teamcode.opmode.Auto",
    shaHex: "deadbeef",
    sourcePath: "autos/every-kind.auto.json",
    commandLibrary,
  });
}

describe("Java for a Control Hub (Android API 24)", () => {
  it("the denylist itself catches what it is for, and ignores comments and strings", () => {
    expect(hits('Map<String, Object> m = Map.<String, Object>of("a", 1);')).toHaveLength(1);
    expect(hits("List<Integer> l = List.of(1, 2);")).toHaveLength(1);
    expect(hits('String s = String.join(",", parts);')).toHaveLength(1);
    expect(hits('String s = "-".repeat(3);')).toHaveLength(1);
    expect(hits("/** Not Map.of: it is API 30. */ int x = 1; // List.of too")).toEqual([]);
    expect(hits('String s = "Map.of(";')).toEqual([]);
  });

  it("generated code covering every step kind uses no API above 24", () => {
    const java = everyStepKind();
    expect(java).toContain("Parallel.all(");
    expect(java).toContain("Parallel.race(");
    expect(java).toContain("Parallel.deadline(");
    expect(java).toContain("Args.of()");
    expect(java).toContain('Args.of("count", 3.0)');
    expect(hits(java)).toEqual([]);
  });

  it("generated Ivy code covering every step kind uses no API above 24", () => {
    const java = everyStepKind("ivy");
    expect(java).toContain("import org.horizon36596.zenith.ivy.AutoFromFile;");
    expect(java).toContain("Parallel.deadline(");
    expect(java).toContain("Branch.of(");
    expect(hits(java)).toEqual([]);
  });

  it.each(runtimeDirs)("the robot runtime's sources in %s use no API above 24", (dir, atLeast) => {
    const files = readdirSync(dir).filter((name) => name.endsWith(".java"));
    expect(files.length).toBeGreaterThan(atLeast);
    const found = files.flatMap((name) =>
      hits(readFileSync(join(dir, name), "utf8")).map((hit) => `${name}: ${hit}`),
    );
    expect(found).toEqual([]);
  });
});
