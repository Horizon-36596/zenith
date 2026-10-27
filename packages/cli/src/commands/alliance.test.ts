import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allianceFixes,
  allianceRobotFromProjection,
  alliancePoseAt,
  canonicalize,
  checkAlliance,
  mirrorForField,
  newProposal,
  ownAllianceRobot,
  projectShare,
  runLedger,
  simulate,
  type AllianceProjection,
  type AllianceRobot,
  type Finding,
} from "@horizon36596/zenith-core";
import { parseProjection, SCHEMA_ID } from "@horizon36596/zenith-schema";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAutoAndPlan, resolveAutoPath } from "../autoLoad.js";
import { loadProject } from "../project.js";
import { runAlliance, type AllianceReport } from "./alliance.js";
import { main } from "../index.js";
import { runValidate } from "./validate.js";
import { runCodegen } from "./codegen.js";
import { planDeploy } from "./deploy.js";
import { runProposalApply, runProposalValidate } from "./proposal.js";
import { runProposeDryRun } from "./propose.js";

const STARTER = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));

let dir = "";
let out: string[] = [];
let errOut: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zenith-alliance-"));
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

/** The starter first-auto, planned the way the CLI plans it, and the user's robot from it. */
function firstAuto() {
  const project = loadProject(STARTER, STARTER);
  const result = loadAutoAndPlan(resolveAutoPath(STARTER, project, "first-auto"), project);
  if (!result.ok) throw new Error("the starter first-auto does not load");
  const { plan, field } = result.loaded;
  const season = resolveSeason(field).rules;
  return { plan, field, season, waypoints: project.waypoints, own: ownAllianceRobot(plan, field, season) };
}

/** A projection that drives between poses every 0.1 s, in the starter robot's 18 in box. */
function projection(
  alliance: "RED" | "BLUE",
  title: string,
  poses: [number, number, number][],
): AllianceProjection {
  const totalS = (poses.length - 1) / 10;
  const [xIn, yIn, headingRad] = poses[0] as [number, number, number];
  return {
    $schema: SCHEMA_ID.projection,
    formatVersion: 1,
    kind: "projection",
    level: "view",
    season: "biobuzz",
    alliance,
    title,
    startPose: { xIn, yIn, headingRad },
    boundingBox: { lengthIn: 18, widthIn: 18, centreOffsetIn: { xIn: 0, yIn: 0 } },
    trajectory: { rateHz: 10, positionQuantumIn: 0.5, headingQuantumRad: 0.0175, poses },
    phases: [{ startS: 0, endS: totalS, label: "drive" }],
    claims: [],
    envelopes: [],
    totalS,
  };
}

/** Straight-line poses every 0.1 s for `ticks` ticks. */
function leg(from: [number, number], to: [number, number], ticks: number): [number, number, number][] {
  const poses: [number, number, number][] = [];
  for (let tick = 0; tick <= ticks; tick += 1) {
    const u = tick / ticks;
    poses.push([from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u, 0]);
  }
  return poses;
}

/**
 * A partner that waits 30 in west of where our robot is at 1.0 s, reaches that spot at 50 in/s
 * exactly at 1.0 s, and turns north ahead of our robot and out of its way.
 */
function crossingPoses(own: AllianceRobot): [number, number, number][] {
  const at = alliancePoseAt(own, 1);
  return [
    ...leg([at.xIn - 30, at.yIn], [at.xIn - 30, at.yIn], 4),
    ...leg([at.xIn - 30, at.yIn], [at.xIn, at.yIn], 6).slice(1),
    ...leg([at.xIn, at.yIn], [at.xIn, at.yIn + 60], 12).slice(1),
  ];
}

const writeJson = (name: string, value: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
};

const parsedReport = (): AllianceReport => JSON.parse(out.join("")) as AllianceReport;
const jsonRoundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("zenith alliance", () => {
  it("prints, as JSON, exactly the findings core computes, and exits 1 on a predicted collision", () => {
    const { plan, field, season, own } = firstAuto();
    const partnerFile = writeJson("crossing.json", projection("RED", "Team Partner", crossingPoses(own)));

    const code = runAlliance("first-auto", [partnerFile], { cwd: dir, project: STARTER, json: true });
    expect(code).toBe(1);
    const report = parsedReport();

    const partner = allianceRobotFromProjection(
      parseProjection(projection("RED", "Team Partner", crossingPoses(own))),
    );
    const mirrorId = season.mirrorId;
    const expected: Finding[] = checkAlliance(own, [partner], {
      mirror: mirrorForField(field),
      ...(mirrorId === undefined ? {} : { mirrorId: (id: string) => mirrorId.call(season, id) }),
    });
    expect(report.findings).toEqual(jsonRoundTrip(expected));
    expect(report.findings.map((finding) => finding.code)).toContain("ALLIANCE_COLLISION");
    expect(report.errors).toBeGreaterThan(0);
    expect(report.auto).toBe("autos/first-auto.auto.json");
    expect(report.alliance).toBe(plan.auto.alliance);
    expect(report.partners).toEqual([{ path: "crossing.json", label: "Team Partner", alliance: "RED", mirrored: false }]);
    expect(report.clearingOffset?.offsetS).toBeGreaterThan(0);
    expect(report.clearingOffset?.offsetS).toBeLessThanOrEqual(1);
    expect(report.help.ALLIANCE_COLLISION?.title).toBe("Predicted crash with partner");
  });

  it("reports both of the editor's fixes for every finding that has them, from core's allianceFixes", () => {
    const { plan, field, season, waypoints, own } = firstAuto();
    const partnerFile = writeJson("crossing.json", projection("RED", "Team Partner", crossingPoses(own)));
    expect(runAlliance("first-auto", [partnerFile], { cwd: dir, project: STARTER, json: true })).toBe(1);
    const report = parsedReport();

    const partner = allianceRobotFromProjection(parseProjection(projection("RED", "Team Partner", crossingPoses(own))));
    const mirrorId = season.mirrorId;
    const options = {
      ownStartOffsetS: 0,
      mirror: mirrorForField(field),
      ...(mirrorId === undefined ? {} : { mirrorId: (id: string) => mirrorId.call(season, id) }),
    };
    const findings = checkAlliance(own, [partner], options);
    const fixes = allianceFixes({ plan, ...(waypoints === undefined ? {} : { waypoints }), field, season }, own, [partner], findings, options);
    expect(report.clearingOffsets).toEqual(jsonRoundTrip(fixes.clearingOffsets));
    expect(report.clearingWaits).toEqual(jsonRoundTrip(fixes.clearingWaits));
    expect(report.clearingOffsets.ALLIANCE_COLLISION).toEqual(report.clearingOffset);
    const collisionWait = report.clearingWaits.find((entry) => entry.code === "ALLIANCE_COLLISION");
    // The collision is in the first step, so a wait before it is the same as a later start.
    expect(collisionWait?.wait).toEqual({ stepId: "driveOut", seconds: report.clearingOffset?.offsetS });
    expect(report.findings[collisionWait?.findingIndex ?? -1]?.code).toBe("ALLIANCE_COLLISION");
  });

  it("offers the fixes for an envelope entry, where there is no collision to clear", () => {
    // A 12 in square just west of where first-auto parks, reserved until 5.5 s by a partner far away.
    const still = projection("RED", "Team Partner", [[0, 40, 0]]);
    still.envelopes = [
      {
        startS: 0,
        endS: 5.5,
        polygon: [
          { xIn: -58, yIn: -48 },
          { xIn: -46, yIn: -48 },
          { xIn: -46, yIn: -36 },
          { xIn: -58, yIn: -36 },
        ],
      },
    ];
    const partnerFile = writeJson("envelope.json", still);
    expect(runAlliance("first-auto", [partnerFile], { cwd: dir, project: STARTER, json: true })).toBe(0);
    const report = parsedReport();
    const index = report.findings.findIndex((finding) => finding.code === "ALLIANCE_ENVELOPE");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(report.clearingOffset).toBeUndefined();
    expect(report.clearingOffsets.ALLIANCE_ENVELOPE?.offsetS).toBeGreaterThan(0);
    const entry = report.clearingWaits.find((wait) => wait.findingIndex === index);
    expect(entry?.code).toBe("ALLIANCE_ENVELOPE");
    expect(entry?.wait?.stepId).toBe("park");
    expect(entry?.wait?.seconds).toBeGreaterThan(0);

    out = [];
    expect(runAlliance("first-auto", [partnerFile], { cwd: dir, project: STARTER })).toBe(0);
    const text = out.join("");
    expect(text).toContain(
      `Delaying your start by ${(report.clearingOffsets.ALLIANCE_ENVELOPE?.offsetS ?? 0).toFixed(1)} s clears every predicted entry into a partner's envelope without a collision.`,
    );
    expect(text).toMatch(
      /For the envelope entry at \d+\.\d s: a \d+\.\d s wait before park clears every predicted entry into a partner's envelope without a collision\./,
    );
  });

  it("offers no fix for an element conflict", () => {
    const far = { ...projection("RED", "Team Partner", leg([60, 60], [60, 40], 5)) };
    far.claims = [{ elementId: "hiveRedUpCell", action: "score", atS: 2 }];
    expect(runAlliance("first-auto", [writeJson("far.json", far)], { cwd: dir, project: STARTER, json: true })).toBe(0);
    const report = parsedReport();
    expect(report.findings.map((finding) => finding.code)).toEqual(["ALLIANCE_ELEMENT_CONFLICT"]);
    expect(report.clearingOffsets).toEqual({});
    expect(report.clearingWaits).toEqual([]);
  });

  it("exits 0 once --offset delays the start past the crossing", () => {
    const { own } = firstAuto();
    const partnerFile = writeJson("crossing.json", projection("RED", "Team Partner", crossingPoses(own)));
    const code = runAlliance("first-auto", [partnerFile], { cwd: dir, project: STARTER, json: true, offset: 1 });
    expect(code).toBe(0);
    const report = parsedReport();
    expect(report.offsetS).toBe(1);
    expect(report.errors).toBe(0);
    expect(report.findings.map((finding) => finding.code)).not.toContain("ALLIANCE_COLLISION");
    expect(report.clearingOffset).toBeUndefined();
  });

  it("mirrors a partner written for the other alliance, finding the same collision", () => {
    const { own } = firstAuto();
    const red = crossingPoses(own);
    // Point symmetry: (x, y, h) to (-x, -y, h + pi).
    const blue = red.map(([xIn, yIn, headingRad]) => [-xIn, -yIn, headingRad + Math.PI] as [number, number, number]);
    const redFile = writeJson("red.json", projection("RED", "Team Partner", red));
    const blueFile = writeJson("blue.json", projection("BLUE", "Team Partner", blue));

    expect(runAlliance("first-auto", [redFile], { cwd: dir, project: STARTER, json: true })).toBe(1);
    const fromRed = parsedReport();
    out = [];
    expect(runAlliance("first-auto", [blueFile], { cwd: dir, project: STARTER, json: true })).toBe(1);
    const fromBlue = parsedReport();

    expect(fromBlue.partners[0]?.mirrored).toBe(true);
    const summary = (report: AllianceReport) => report.findings.map((finding) => [finding.code, finding.timeS]);
    expect(summary(fromBlue)).toEqual(summary(fromRed));
  });

  it("prints a table with the clearing offset for a person, and says the findings are predictions", () => {
    const { own } = firstAuto();
    const partnerFile = writeJson("crossing.json", projection("RED", "Team Partner", crossingPoses(own)));
    const code = runAlliance("first-auto", [partnerFile], { cwd: dir, project: STARTER });
    expect(code).toBe(1);
    const text = out.join("");
    expect(text).toContain("autos/first-auto.auto.json as RED with Team Partner (crossing.json)");
    expect(text).toContain("ALLIANCE_COLLISION");
    expect(text).toMatch(/Delaying your start by \d\.\d s clears every predicted collision\./);
    expect(text).toMatch(/For the collision at \d+\.\d s: a \d\.\d s wait before driveOut clears every predicted collision\./);
    expect(text).toContain("They never block validate, deploy or propose.");
  });

  it("exits 0 with no findings for a partner that stays out of the way", () => {
    const far = leg([60, 60], [60, 40], 5);
    const partnerFile = writeJson("far.json", projection("RED", "Team Partner", far));
    const code = runAlliance("first-auto", [partnerFile], { cwd: dir, project: STARTER, json: true });
    expect(code).toBe(0);
    expect(parsedReport().findings).toEqual([]);
  });

  it("names the robot that reaches a claimed element first, from the ledger, and still exits 0", () => {
    const far = { ...projection("RED", "Team Partner", leg([60, 60], [60, 40], 5)) };
    far.claims = [{ elementId: "hiveRedUpCell", action: "score", atS: 2 }];
    const partnerFile = writeJson("far.json", far);
    const code = runAlliance("first-auto", [partnerFile], { cwd: dir, project: STARTER, json: true });
    expect(code).toBe(0);
    const report = parsedReport();
    expect(report.warnings).toBe(1);
    expect(report.findings[0]?.code).toBe("ALLIANCE_ELEMENT_CONFLICT");
    // The partner is in neither of the hive's floor quarters, so its cell is not known and may be
    // the one ours scores into: the message names our robot's cell.
    expect(report.findings[0]?.message).toContain(
      "both autos score into hiveRedUpCell (the south cell); your robot gets there first, at 1.1 s, and Team Partner at 2.0 s",
    );
  });

  it("renames a mirrored partner's elements with the season's hook", () => {
    const far = projection("BLUE", "Team Partner", leg([-60, -60], [-60, -40], 5));
    far.claims = [{ elementId: "hiveBlueUpCell", action: "score", atS: 0.5 }];
    const partnerFile = writeJson("far.json", far);
    expect(runAlliance("first-auto", [partnerFile], { cwd: dir, project: STARTER, json: true })).toBe(0);
    expect(parsedReport().findings[0]?.message).toContain("both autos score into hiveRedUpCell (the south cell); Team Partner gets there first");
  });

  it("exits 2 and names the key when a projection is not one", () => {
    const broken = { ...projection("RED", "Team Partner", leg([60, 60], [60, 40], 5)), kind: "auto" };
    const partnerFile = writeJson("broken.json", broken);
    const code = runAlliance("first-auto", [partnerFile], { cwd: dir, project: STARTER });
    expect(code).toBe(2);
    expect(errOut.join("")).toContain('kind: Invalid literal value, expected "projection"');
    expect(errOut.join("")).toContain("broken.json");
  });

  it("exits 2 on a negative offset or no partner at all", () => {
    const partnerFile = writeJson("far.json", projection("RED", "Team Partner", leg([60, 60], [60, 40], 5)));
    expect(runAlliance("first-auto", [partnerFile], { cwd: dir, project: STARTER, offset: -1 })).toBe(2);
    expect(runAlliance("first-auto", [], { cwd: dir, project: STARTER })).toBe(2);
  });

  it("is a verb of the zenith binary, with --offset parsed as seconds", async () => {
    const { own } = firstAuto();
    const partnerFile = writeJson("crossing.json", projection("RED", "Team Partner", crossingPoses(own)));
    const argv = ["node", "zenith", "alliance", "first-auto", partnerFile, "--project", STARTER, "--json"];
    process.exitCode = undefined;
    expect(await main(argv)).toBe(1);
    process.exitCode = undefined;
    expect(await main([...argv, "--offset", "1"])).toBe(0);
    process.exitCode = undefined;
  });

  it("changes nothing about zenith validate on the same auto", () => {
    const { own } = firstAuto();
    writeJson("crossing.json", projection("RED", "Team Partner", crossingPoses(own)));
    const before = runValidate(["first-auto"], { cwd: dir, project: STARTER, json: true });
    const validateBefore = out.join("");
    out = [];
    runAlliance("first-auto", [join(dir, "crossing.json")], { cwd: dir, project: STARTER, json: true });
    out = [];
    const after = runValidate(["first-auto"], { cwd: dir, project: STARTER, json: true });
    expect(after).toBe(before);
    expect(out.join("")).toBe(validateBefore);
    expect(validateBefore).not.toContain("ALLIANCE_");
  });

  it("changes nothing, byte for byte, in what deploy, codegen, propose and a proposal produce", () => {
    // A copy of the starter, so codegen and the proposal files have somewhere to go.
    const root = join(dir, "project");
    cpSync(STARTER, root, { recursive: true });
    const project = loadProject(root, root);
    const loaded = loadAutoAndPlan(resolveAutoPath(root, project, "collect-and-score"), project);
    if (!loaded.ok) throw new Error("the starter collect-and-score does not load");
    const { plan, robot, field } = loaded.loaded;
    const ledger = runLedger(plan, field);
    const shared = projectShare({ plan, trace: simulate(plan, robot, field, { ledger }), robot, field, ledger }, { level: "propose" });
    const projectionFile = join(root, "shared.projection.json");
    const proposalFile = join(root, "partner.proposal.json");
    writeFileSync(projectionFile, canonicalize("projection", shared));
    writeFileSync(
      proposalFile,
      canonicalize("proposal", newProposal(shared, { shareId: "share1", revision: 1 }, [{ op: "insertWait", atStart: true, seconds: 1 }])),
    );

    /** Everything each verb puts out: its exit code, what it prints, and every byte it would write. */
    const everything = (): Record<string, string> => {
      const captured: Record<string, string> = {};
      const run = (name: string, work: () => number): void => {
        out = [];
        const code = work();
        captured[name] = `${String(code)}\n${out.join("")}`;
      };
      captured["deploy plan"] = JSON.stringify(planDeploy(loadProject(root, root)));
      run("codegen", () => runCodegen("first-auto", { cwd: root, json: true }));
      captured["codegen java"] = readFileSync(join(root, "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/zenith/FirstAutoGenerated.java"), "utf8");
      run("propose", () => runProposeDryRun("first-auto", { cwd: root, json: true }));
      run("proposal validate", () => runProposalValidate(proposalFile, projectionFile, { cwd: root, json: true }));
      run("proposal apply", () => runProposalApply("collect-and-score", proposalFile, { cwd: root, json: true, accept: "all" }));
      out = [];
      return captured;
    };

    const before = everything();
    // The partner crosses first-auto at 1 s: zenith alliance says so and exits 1.
    const { own } = firstAuto();
    const partnerFile = writeJson("crossing.json", projection("RED", "Team Partner", crossingPoses(own)));
    expect(runAlliance("first-auto", [partnerFile], { cwd: root, project: root, json: true })).toBe(1);
    expect(parsedReport().findings.map((finding) => finding.code)).toContain("ALLIANCE_COLLISION");
    const after = everything();

    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const key of Object.keys(before)) {
      expect(after[key], key).toBe(before[key]);
      expect(after[key], key).not.toContain("ALLIANCE_");
    }
    expect(before["codegen"]?.startsWith("0\n")).toBe(true);
    expect(before["proposal validate"]?.startsWith("0\n")).toBe(true);
    expect(before["proposal apply"]?.startsWith("0\n")).toBe(true);
  });
});
