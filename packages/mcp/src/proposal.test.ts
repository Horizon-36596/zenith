import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  applyProposalToAuto,
  canonicalize,
  loadAuto,
  newProposal,
  projectShare,
  runLedger,
  simulate,
  type ProjectShareInput,
  type ProposalChangeReport,
  type ProposalFinding,
} from "@horizon36596/zenith-core";
import type { ProposalChange } from "@horizon36596/zenith-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAutoAndPlan } from "./findings.js";
import { readJsonFile, resolveAutoPath, resolveProject } from "./project.js";
import { createServer } from "./server.js";

/**
 * `zenith.proposal.validate` and `zenith.proposal.apply`, in process, on a copy of
 * `examples/starter`: the same refusals and the same result core computes, and apply writes only
 * when asked to and only what was accepted.
 */

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, "..", "..", "..", "examples", "starter");
const AUTO = "collect-and-score";

function body<T>(result: unknown): { isError: boolean; value: T; text: string } {
  const value = result as { content?: { type: string; text?: string }[]; isError?: boolean };
  const text = value.content?.find((item) => item.type === "text")?.text ?? "";
  if (value.isError === true) return { isError: true, value: undefined as T, text };
  return { isError: false, value: JSON.parse(text) as T, text };
}

const CHANGES: ProposalChange[] = [
  { op: "setSpeedFraction", stepId: "s3", speedFraction: 0.6, comment: "Slower into the garden." },
  { op: "insertWait", afterStepId: "s2", seconds: 0.5 },
];

interface ValidateResult {
  ok: boolean;
  findings: ProposalFinding[];
  changes: number;
}

interface ApplyResult {
  changes: ProposalChangeReport[];
  findings: ProposalFinding[];
  errors: number;
  written: string | null;
  accepted: number[];
}

describe("zenith.proposal tools", () => {
  let client: Client;
  let project = "";

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), "zenith-mcp-proposal-"));
    cpSync(examplesDir, project, { recursive: true });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    client = new Client({ name: "zenith-mcp-proposal-test", version: "0.0.0" });
    await client.connect(clientSide);

    const proj = resolveProject(project);
    const { plan, robot, field } = loadAutoAndPlan(loadAuto(readJsonFile(resolveAutoPath(proj, AUTO))), proj);
    const ledger = runLedger(plan, field);
    const input: ProjectShareInput = { plan, trace: simulate(plan, robot, field, { ledger }), robot, field, ledger };
    const propose = projectShare(input, { level: "propose" });
    writeFileSync(join(project, "shared.json"), canonicalize("projection", propose));
    writeFileSync(join(project, "view.json"), canonicalize("projection", projectShare(input, { level: "view" })));
    writeFileSync(join(project, "partner.proposal.json"), canonicalize("proposal", newProposal(propose, { shareId: "share1", revision: 1 }, CHANGES)));
  });

  afterAll(async () => {
    await client.close();
    rmSync(project, { recursive: true, force: true });
  });

  const autoText = (): string => readFileSync(join(project, "autos", `${AUTO}.auto.json`), "utf8");

  it("are listed", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["zenith.proposal.validate", "zenith.proposal.apply"]));
  });

  it("validates a proposal that fits, and refuses one against a view or revoked share with a sentence why", async () => {
    const call = async (args: Record<string, unknown>) =>
      body<ValidateResult>(await client.callTool({ name: "zenith.proposal.validate", arguments: { proposal: "partner.proposal.json", project, ...args } }));
    const fits = await call({ projection: "shared.json" });
    expect(fits.value).toMatchObject({ ok: true, changes: 2, findings: [] });

    const view = await call({ projection: "view.json" });
    expect(view.value.ok).toBe(false);
    expect(view.value.findings.map((finding) => finding.code)).toEqual(["PROPOSAL_SHARE"]);
    expect(view.value.findings[0]?.message).toMatch(/^This share is view only.*\.$/);

    const revoked = await call({ projection: "shared.json", share: "revoked" });
    expect(revoked.value.findings[0]?.message).toMatch(/revoked/);
  });

  it("refuses a file outside the project", async () => {
    const result = body(await client.callTool({ name: "zenith.proposal.validate", arguments: { proposal: "../outside.json", projection: "shared.json", project } }));
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/outside the project root/);
  });

  it("reviews without writing unless write is true, and then writes what core computes", async () => {
    const before = autoText();
    const review = body<ApplyResult>(await client.callTool({ name: "zenith.proposal.apply", arguments: { auto: AUTO, proposal: "partner.proposal.json", project } }));
    expect(review.isError).toBe(false);
    expect(review.value.written).toBeNull();
    expect(review.value.changes.map((change) => change.status)).toEqual(["applied", "applied"]);
    expect(autoText()).toBe(before);

    const refused = body(await client.callTool({ name: "zenith.proposal.apply", arguments: { auto: AUTO, proposal: "partner.proposal.json", write: true, project } }));
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/write needs accept/);
    expect(autoText()).toBe(before);

    // Accepting none of the changes leaves the file exactly as it was, and says why.
    const none = body<ApplyResult & { notWritten?: string }>(
      await client.callTool({ name: "zenith.proposal.apply", arguments: { auto: AUTO, proposal: "partner.proposal.json", accept: [], write: true, project } }),
    );
    expect(none.value.written).toBeNull();
    expect(none.value.notWritten).toBe("Nothing was written, because no change was accepted.");
    expect(autoText()).toBe(before);

    const proj = resolveProject(project);
    const auto = loadAuto(readJsonFile(resolveAutoPath(proj, AUTO)));
    const { plan, robot, field } = loadAutoAndPlan(auto, proj);
    const proposal = readJsonFile(join(project, "partner.proposal.json"));
    const expected = applyProposalToAuto(auto, { plan, trace: { poses: [], steps: [], simTimeS: 0 }, robot, field }, { level: "propose" }, proposal, [1], {
      waypoints: proj.waypoints,
    });

    const written = body<ApplyResult>(
      await client.callTool({ name: "zenith.proposal.apply", arguments: { auto: AUTO, proposal: "partner.proposal.json", accept: [2], write: true, project } }),
    );
    expect(written.value).toMatchObject({ written: `autos/${AUTO}.auto.json`, accepted: [2], errors: 0 });
    expect(written.value.changes.map((change) => change.status)).toEqual(["notAccepted", "applied"]);
    expect(autoText()).toBe(canonicalize("auto", expected.auto));
    expect(autoText()).not.toBe(before);
  });
});
