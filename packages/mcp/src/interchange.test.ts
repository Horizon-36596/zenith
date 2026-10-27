import { copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./server.js";

/**
 * `zenith.validate` on the interchange files (M-C8): a trajectory.json or path.json inside the
 * project is checked the way `zenith import` reads it, and every problem names its field, the
 * same as `zenith validate --json` prints.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const examplesDir = join(repoRoot, "examples", "starter");
const fixture = (path: string): string => join(repoRoot, "packages", "import", "fixtures", path);

interface Validation {
  path: string;
  kind?: string;
  errors: number;
  warnings: number;
  findings: { severity: string; code: string; field?: string; message: string }[];
  help: Record<string, { title: string }>;
}

function body(result: unknown): Validation {
  const value = result as { content?: { type: string; text?: string }[]; isError?: boolean };
  const text = value.content?.find((item) => item.type === "text")?.text ?? "";
  if (value.isError === true) throw new Error(`tool error: ${text}`);
  return JSON.parse(text) as Validation;
}

describe("zenith.validate on interchange files", () => {
  let client: Client;
  let project = "";

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), "zenith-mcp-interchange-"));
    cpSync(examplesDir, project, { recursive: true });
    copyFileSync(fixture("path/pedro-score-and-park.path.json"), join(project, "partner.path.json"));
    copyFileSync(fixture("path/broken/piecewise-gap.path.json"), join(project, "gap.path.json"));
    copyFileSync(fixture("trajectory/meepmeep-line-and-turn.trajectory.json"), join(project, "partner.trajectory.json"));
    copyFileSync(fixture("trajectory/broken/rate-not-positive.trajectory.json"), join(project, "rate.trajectory.json"));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    client = new Client({ name: "zenith-mcp-interchange-test", version: "0.0.0" });
    await client.connect(clientSide);
  });

  afterAll(async () => {
    await client.close();
    rmSync(project, { recursive: true, force: true });
  });

  const validate = async (auto: string): Promise<Validation> =>
    body(await client.callTool({ name: "zenith.validate", arguments: { auto, project } }));

  it("passes a good path.json and a good trajectory.json, saying which kind each is", async () => {
    const path = await validate("partner.path.json");
    expect(path).toMatchObject({ path: "partner.path.json", kind: "path", errors: 0 });
    const trajectory = await validate("partner.trajectory.json");
    expect(trajectory).toMatchObject({ path: "partner.trajectory.json", kind: "trajectory", errors: 0 });
  });

  it("names the field of each problem, with the help for its code", async () => {
    const gap = await validate("gap.path.json");
    expect(gap.errors).toBeGreaterThan(0);
    expect(gap.findings.map((finding) => finding.field)).toContain("steps[2].heading.ranges[1].startT");
    expect(gap.help["SCHEMA"]?.title).toBe("File problem");
    const rate = await validate("rate.trajectory.json");
    expect(rate.findings.map((finding) => finding.field)).toContain("rateHz");
  });

  it("still validates an auto by its bare name, with no kind", async () => {
    const auto = await validate("first-auto");
    expect(auto.kind).toBeUndefined();
    expect(auto.path).toBe("autos/first-auto.auto.json");
  });
});
