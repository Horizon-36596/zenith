import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  allianceFixes,
  allianceRobotFromProjection,
  alliancePoseAt,
  checkAlliance,
  loadAuto,
  mirrorForField,
  ownAllianceRobot,
  type AllianceProjection,
  type Finding,
} from "@horizon36596/zenith-core";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAutoAndPlan } from "./findings.js";
import { readJsonFile, resolveAutoPath, resolveProject } from "./project.js";
import { createServer } from "./server.js";

/**
 * `zenith.alliance`, in process: the same predicted findings core computes for an example auto
 * and a partner's projection, and a refusal for a projection file outside the project.
 */

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, "..", "..", "..", "examples", "starter");

function body<T>(result: unknown): { isError: boolean; value: T; text: string } {
  const value = result as { content?: { type: string; text?: string }[]; isError?: boolean };
  const text = value.content?.find((item) => item.type === "text")?.text ?? "";
  if (value.isError === true) return { isError: true, value: undefined as T, text };
  return { isError: false, value: JSON.parse(text) as T, text };
}

function leg(from: [number, number], to: [number, number], ticks: number): [number, number, number][] {
  const poses: [number, number, number][] = [];
  for (let tick = 0; tick <= ticks; tick += 1) {
    const u = tick / ticks;
    poses.push([from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u, 0]);
  }
  return poses;
}

function projection(poses: [number, number, number][]): AllianceProjection {
  const [xIn, yIn, headingRad] = poses[0] as [number, number, number];
  const totalS = (poses.length - 1) / 10;
  return {
    $schema: SCHEMA_ID.projection,
    formatVersion: 1,
    kind: "projection",
    level: "view",
    season: "biobuzz",
    alliance: "RED",
    title: "Team Partner",
    startPose: { xIn, yIn, headingRad },
    boundingBox: { lengthIn: 18, widthIn: 18, centreOffsetIn: { xIn: 0, yIn: 0 } },
    trajectory: { rateHz: 10, positionQuantumIn: 0.5, headingQuantumRad: 0.0175, poses },
    phases: [{ startS: 0, endS: totalS, label: "drive" }],
    claims: [],
    envelopes: [],
    totalS,
  };
}

interface AllianceResult {
  findings: Finding[];
  errors: number;
  offsetS: number;
  clearingOffset?: { offsetS: number } | null;
  clearingOffsets: Partial<Record<string, { offsetS: number } | null>>;
  clearingWaits: { findingIndex: number; code: string; wait: { stepId: string; seconds: number } | null }[];
  partners: { path: string; label: string; mirrored: boolean }[];
}

describe("zenith.alliance", () => {
  let client: Client;
  let project = "";

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), "zenith-mcp-alliance-"));
    cpSync(examplesDir, project, { recursive: true });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    client = new Client({ name: "zenith-mcp-alliance-test", version: "0.0.0" });
    await client.connect(clientSide);
  });

  afterAll(async () => {
    await client.close();
    rmSync(project, { recursive: true, force: true });
  });

  /** The starter first-auto as core sees it, and a partner placed to meet it at 1.0 s. */
  function setUp() {
    const proj = resolveProject(project);
    const auto = loadAuto(readJsonFile(resolveAutoPath(proj, "first-auto")));
    const { plan, field } = loadAutoAndPlan(auto, proj);
    const season = resolveSeason(field).rules;
    const own = ownAllianceRobot(plan, field, season);
    const at = alliancePoseAt(own, 1);
    const poses = [
      ...leg([at.xIn - 30, at.yIn], [at.xIn - 30, at.yIn], 4),
      ...leg([at.xIn - 30, at.yIn], [at.xIn, at.yIn], 6).slice(1),
      ...leg([at.xIn, at.yIn], [at.xIn, at.yIn + 60], 12).slice(1),
    ];
    writeFileSync(join(project, "partner.json"), JSON.stringify(projection(poses)), "utf8");
    return { own, field, season, partner: allianceRobotFromProjection(projection(poses)) };
  }

  it("is listed", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("zenith.alliance");
  });

  it("returns the findings core computes, with the clearing offset", async () => {
    const { own, field, season, partner } = setUp();
    const result = body<AllianceResult>(
      await client.callTool({ name: "zenith.alliance", arguments: { auto: "first-auto", projections: ["partner.json"], project } }),
    );
    expect(result.isError).toBe(false);
    const mirrorId = season.mirrorId;
    const expected = checkAlliance(own, [partner], {
      mirror: mirrorForField(field),
      ...(mirrorId === undefined ? {} : { mirrorId: (id: string) => mirrorId.call(season, id) }),
    });
    expect(result.value.findings).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(result.value.errors).toBeGreaterThan(0);
    expect(result.value.partners).toEqual([{ path: "partner.json", label: "Team Partner", alliance: "RED", mirrored: false }]);
    expect(result.value.clearingOffset?.offsetS).toBeGreaterThan(0);
  });

  it("returns both of the editor's fixes, the start offset for each code and the wait for each finding", async () => {
    const { own, field, season, partner } = setUp();
    const result = body<AllianceResult>(
      await client.callTool({ name: "zenith.alliance", arguments: { auto: "first-auto", projections: ["partner.json"], project } }),
    );
    const proj = resolveProject(project);
    const { plan } = loadAutoAndPlan(loadAuto(readJsonFile(resolveAutoPath(proj, "first-auto"))), proj);
    const mirrorId = season.mirrorId;
    const options = {
      ownStartOffsetS: 0,
      mirror: mirrorForField(field),
      ...(mirrorId === undefined ? {} : { mirrorId: (id: string) => mirrorId.call(season, id) }),
    };
    const findings = checkAlliance(own, [partner], options);
    const input = { plan, ...(proj.waypoints === undefined ? {} : { waypoints: proj.waypoints }), field, season };
    const fixes = allianceFixes(input, own, [partner], findings, options);
    expect(result.value.clearingOffsets).toEqual(JSON.parse(JSON.stringify(fixes.clearingOffsets)));
    expect(result.value.clearingWaits).toEqual(JSON.parse(JSON.stringify(fixes.clearingWaits)));
    expect(result.value.clearingOffsets.ALLIANCE_COLLISION).toEqual(result.value.clearingOffset);
    const collision = result.value.clearingWaits.find((entry) => entry.code === "ALLIANCE_COLLISION");
    expect(collision?.wait).toEqual({ stepId: "driveOut", seconds: result.value.clearingOffset?.offsetS });
  });

  it("takes a start offset", async () => {
    setUp();
    const result = body<AllianceResult>(
      await client.callTool({
        name: "zenith.alliance",
        arguments: { auto: "first-auto", projections: ["partner.json"], offsetS: 1, project },
      }),
    );
    expect(result.value.offsetS).toBe(1);
    expect(result.value.errors).toBe(0);
  });

  it("refuses a projection outside the project", async () => {
    const result = body<AllianceResult>(
      await client.callTool({
        name: "zenith.alliance",
        arguments: { auto: "first-auto", projections: ["../outside.json"], project },
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("outside the project root");
  });
});
