import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyProposalToAuto,
  canonicalize,
  newProposal,
  projectShare,
  runLedger,
  setSpeed,
  simulate,
  type ProjectShareInput,
} from "@horizon36596/zenith-core";
import type { Proposal, ProposalChange } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAutoAndPlan, resolveAutoPath } from "../autoLoad.js";
import { main } from "../index.js";
import { loadProject } from "../project.js";
import { runProposalApply, runProposalValidate, type ProposalApplyReport, type ProposalValidateReport } from "./proposal.js";

/**
 * `zenith proposal validate` and `zenith proposal apply` on a copy of `examples/starter`: the
 * proposer's check refuses what core refuses, with the same sentences, and the owner's apply is a
 * dry run unless `--write` and `--accept` are both given, and then writes exactly what core computes.
 */

const STARTER = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const AUTO = "collect-and-score";

let dir = "";
let out: string[] = [];
let errOut: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zenith-proposal-"));
  cpSync(STARTER, dir, { recursive: true });
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

const autoFile = (): string => join(dir, "autos", `${AUTO}.auto.json`);

/** The share's inputs, planned and simulated the way the sharer's device builds a projection. */
function shareInputs(): ProjectShareInput {
  const project = loadProject(dir, dir);
  const loaded = loadAutoAndPlan(resolveAutoPath(dir, project, AUTO), project);
  if (!loaded.ok) throw new Error("the starter auto does not load");
  const { plan, robot, field } = loaded.loaded;
  const ledger = runLedger(plan, field);
  return { plan, trace: simulate(plan, robot, field, { ledger }), robot, field, ledger };
}

const CHANGES: ProposalChange[] = [
  { op: "setSpeedFraction", stepId: "s3", speedFraction: 0.6, comment: "Slower round the hive." },
  { op: "insertWait", afterStepId: "s2", seconds: 0.5 },
  { op: "setHeading", stepId: "s1", heading: { mode: "constant", headingRad: 1.5708 } },
];

/** Writes the share's projection at a level, and a proposal against the propose one. */
function writeFiles(level: "view" | "propose" = "propose"): { projection: string; proposal: string; value: Proposal } {
  const input = shareInputs();
  const projectionValue = projectShare(input, { level });
  const value = newProposal(projectShare(input, { level: "propose" }), { shareId: "share1", revision: 3 }, CHANGES);
  const projection = join(dir, `shared.${level}.projection.json`);
  const proposal = join(dir, "partner.proposal.json");
  writeFileSync(projection, canonicalize("projection", projectionValue));
  writeFileSync(proposal, canonicalize("proposal", value));
  return { projection, proposal, value };
}

const lastJson = <T>(): T => JSON.parse(out.join("")) as T;

describe("zenith proposal validate", () => {
  it("passes a proposal that fits the share, and says so", () => {
    const { projection, proposal } = writeFiles();
    expect(runProposalValidate(proposal, projection, { cwd: dir })).toBe(0);
    expect(out.join("")).toMatch(/3 changes, all of which fit .*; it can be sent\./);
    out = [];
    expect(runProposalValidate(proposal, projection, { cwd: dir, json: true })).toBe(0);
    expect(lastJson<ProposalValidateReport>()).toMatchObject({ ok: true, changes: 3, errors: 0, share: "live" });
  });

  it("refuses a proposal against a view share, and against a revoked or expired one, with a sentence why", () => {
    const view = writeFiles("view");
    expect(runProposalValidate(view.proposal, view.projection, { cwd: dir, json: true })).toBe(1);
    const report = lastJson<ProposalValidateReport>();
    expect(report.findings.map((finding) => finding.code)).toEqual(["PROPOSAL_SHARE"]);
    expect(report.findings[0]?.message).toMatch(/^This share is view only.*\.$/);
    expect(report.help.PROPOSAL_SHARE?.title).toBeDefined();

    const live = writeFiles();
    for (const share of ["revoked", "expired"]) {
      out = [];
      expect(runProposalValidate(live.proposal, live.projection, { cwd: dir, json: true, share })).toBe(1);
      expect(lastJson<ProposalValidateReport>().findings[0]?.message).toContain(share);
    }
  });

  it("prints the refusal as a findings table for a person", () => {
    const view = writeFiles("view");
    expect(runProposalValidate(view.proposal, view.projection, { cwd: dir })).toBe(1);
    expect(out.join("")).toMatch(/error\s+PROPOSAL_SHARE\s+\(proposal\)\s+This share is view only/);
  });

  it("is a usage error for an unknown share state or a file that is not a projection", () => {
    const { projection, proposal } = writeFiles();
    expect(runProposalValidate(proposal, projection, { cwd: dir, share: "paused" })).toBe(2);
    expect(runProposalValidate(proposal, proposal, { cwd: dir })).toBe(2);
    expect(errOut.join("")).toMatch(/--share must be one of live, revoked, expired/);
  });

  it("is wired into the binary", async () => {
    const { projection, proposal } = writeFiles();
    expect(await main(["node", "zenith", "proposal", "validate", proposal, projection, "--json"])).toBe(0);
    out = [];
    expect(await main(["node", "zenith", "proposal", "validate", proposal, projection, "--share", "revoked"])).toBe(1);
  });
});

describe("zenith proposal apply", () => {
  it("is a dry run by default: it prints the review and the diff, and writes nothing", () => {
    const { proposal } = writeFiles();
    const before = readFileSync(autoFile(), "utf8");
    expect(runProposalApply(AUTO, proposal, { cwd: dir, project: dir })).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/1\. applied\s+Drive "toOtherSide" at 0\.6 of full speed\. Comment: Slower round the hive\./);
    expect(text).toMatch(/`toOtherSide` changed/);
    expect(text).toMatch(/Dry run: nothing was written/);
    expect(readFileSync(autoFile(), "utf8")).toBe(before);
  });

  it("writes, with --write and --accept, exactly the canonical auto core computes for those changes", () => {
    const { proposal, value } = writeFiles();
    const input = shareInputs();
    const expected = applyProposalToAuto(input.plan.auto, input, { level: "propose" }, value, [0, 2], {
      waypoints: loadProject(dir, dir).waypoints,
    });
    expect(expected.findings).toEqual([]);
    expect(runProposalApply(AUTO, proposal, { cwd: dir, project: dir, accept: "1,3", write: true, json: true })).toBe(0);
    const report = lastJson<ProposalApplyReport>();
    expect(report.written).toBe(`autos/${AUTO}.auto.json`);
    expect(report.accepted).toEqual([1, 3]);
    expect(report.changes.map((change) => change.status)).toEqual(["applied", "notAccepted", "applied"]);
    expect(readFileSync(autoFile(), "utf8")).toBe(canonicalize("auto", expected.auto));
  });

  it("will not write without --accept, and refuses an --accept it cannot read", () => {
    const { proposal } = writeFiles();
    expect(runProposalApply(AUTO, proposal, { cwd: dir, project: dir, write: true })).toBe(2);
    expect(errOut.join("")).toMatch(/--write needs --accept/);
    expect(runProposalApply(AUTO, proposal, { cwd: dir, project: dir, accept: "1,x" })).toBe(2);
  });

  it("reports a change to a step edited since the share as a conflict, and writes nothing while it is accepted", () => {
    const { proposal } = writeFiles();
    const baseFile = join(dir, "autos", "shared-revision.auto.json");
    const original = readFileSync(autoFile(), "utf8");
    writeFileSync(baseFile, original.replace(`"name": "${AUTO}"`, '"name": "shared-revision"'));
    const edited = setSpeed(JSON.parse(original) as never, "toOtherSide", 0.5);
    writeFileSync(autoFile(), canonicalize("auto", edited));
    const now = readFileSync(autoFile(), "utf8");

    expect(runProposalApply(AUTO, proposal, { cwd: dir, project: dir, base: "shared-revision", accept: "all", write: true, json: true })).toBe(1);
    const refused = lastJson<ProposalApplyReport>();
    expect(refused.written).toBeNull();
    expect(refused.changes.map((change) => change.status)).toEqual(["conflict", "applied", "applied"]);
    expect(refused.findings.map((finding) => [finding.code, finding.severity])).toEqual([["PROPOSAL_CONFLICT", "error"]]);
    expect(readFileSync(autoFile(), "utf8")).toBe(now);

    out = [];
    expect(runProposalApply(AUTO, proposal, { cwd: dir, project: dir, base: "shared-revision", accept: "2,3", write: true, json: true })).toBe(0);
    const accepted = lastJson<ProposalApplyReport>();
    expect(accepted.written).toBe(`autos/${AUTO}.auto.json`);
    expect(accepted.findings.map((finding) => [finding.code, finding.severity])).toEqual([["PROPOSAL_CONFLICT", "warning"]]);
  });

  it("changes nothing for a proposal refused as a whole", () => {
    const { proposal } = writeFiles();
    const before = readFileSync(autoFile(), "utf8");
    expect(runProposalApply(AUTO, proposal, { cwd: dir, project: dir, accept: "all", write: true, share: "expired", json: true })).toBe(1);
    const report = lastJson<ProposalApplyReport>();
    expect(report.findings.map((finding) => finding.code)).toEqual(["PROPOSAL_SHARE"]);
    expect(report.changes.every((change) => change.status === "refused")).toBe(true);
    expect(readFileSync(autoFile(), "utf8")).toBe(before);
  });

  it("reports an inserted wait as one added step, not every later step as moved", () => {
    const { proposal } = writeFiles();
    expect(runProposalApply(AUTO, proposal, { cwd: dir, project: dir, accept: "2", json: true })).toBe(0);
    const report = lastJson<ProposalApplyReport>();
    expect(report.diff.changes.map((change) => change.kind)).toEqual(["added"]);
    out = [];
    expect(runProposalApply(AUTO, proposal, { cwd: dir, project: dir, accept: "2" })).toBe(0);
    expect(out.join("")).not.toMatch(/ moved\./);
  });

  it("writes nothing with --accept none --write, and says no change was accepted", () => {
    const { proposal } = writeFiles();
    const past = new Date("2026-01-01T00:00:00Z");
    utimesSync(autoFile(), past, past);
    const before = readFileSync(autoFile(), "utf8");
    expect(runProposalApply(AUTO, proposal, { cwd: dir, project: dir, accept: "none", write: true, json: true })).toBe(0);
    expect(lastJson<ProposalApplyReport>().written).toBeNull();
    out = [];
    expect(runProposalApply(AUTO, proposal, { cwd: dir, project: dir, accept: "none", write: true })).toBe(0);
    expect(out.join("")).toMatch(/Nothing was written, because no change was accepted\./);
    expect(readFileSync(autoFile(), "utf8")).toBe(before);
    expect(statSync(autoFile()).mtimeMs).toBe(past.getTime());
  });

  it("is wired into the binary", async () => {
    const { proposal } = writeFiles();
    expect(await main(["node", "zenith", "proposal", "apply", AUTO, proposal, "--project", dir, "--accept", "2", "--json"])).toBe(0);
    expect(lastJson<ProposalApplyReport>().accepted).toEqual([2]);
  });
});
