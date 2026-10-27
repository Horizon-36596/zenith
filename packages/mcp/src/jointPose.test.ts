import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./server.js";

/**
 * `zenith.edit.setPose` with `joint: true` (issue #146): the point where two segments of a path meet
 * moves as one point, as it does in the editor, through core's own rule. Each test works on a temp
 * copy of examples/starter whose first-auto has driveOut split at (-9, -49.5).
 */

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, "..", "..", "..", "examples", "starter");

interface Segment {
  from: unknown;
  to: unknown;
}

interface EditBody {
  auto: { steps: { id: string; segments?: Segment[] }[] };
  findings: { code: string; stepId: string }[];
}

describe("zenith.edit.setPose on a joint", () => {
  let client: Client;
  const temps: string[] = [];

  /** A project whose first-auto's driveOut runs in two segments that meet at (-9, -49.5). */
  const splitProject = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "zenith-mcp-joint-"));
    cpSync(examplesDir, dir, { recursive: true });
    temps.push(dir);
    const file = join(dir, "autos/first-auto.auto.json");
    const auto = JSON.parse(readFileSync(file, "utf8")) as { steps: { id: string; segments?: unknown[] }[] };
    const driveOut = auto.steps.find((step) => step.id === "driveOut");
    if (driveOut === undefined) throw new Error("the starter first-auto has no driveOut");
    const middle = { xIn: -9, yIn: -49.5, provenance: "SET FROM EDITOR" };
    driveOut.segments = [
      { kind: "line", from: { ref: "start" }, to: middle },
      { kind: "line", from: middle, to: { ref: "scoreSouth" } },
    ];
    writeFileSync(file, JSON.stringify(auto, null, 2));
    return dir;
  };

  const setPose = async (project: string, joint: boolean | undefined): Promise<EditBody> => {
    const result = (await client.callTool({
      name: "zenith.edit.setPose",
      arguments: {
        auto: "first-auto",
        stepId: "driveOut",
        target: { segmentIndex: 0, pointKind: "to" },
        pose: { xIn: 12, yIn: -49.5, headingRad: 1.5708 },
        ...(joint === undefined ? {} : { joint }),
        project,
      },
    })) as { content: { type: string; text?: string }[]; isError?: boolean };
    const text = result.content.find((item) => item.type === "text")?.text ?? "";
    if (result.isError === true) throw new Error(`tool error: ${text}`);
    return JSON.parse(text) as EditBody;
  };

  const segmentsOf = (body: EditBody): Segment[] => body.auto.steps.find((step) => step.id === "driveOut")?.segments ?? [];
  const continuity = (body: EditBody) => body.findings.filter((finding) => finding.code === "CONTINUITY");

  beforeAll(async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    client = new Client({ name: "zenith-mcp-joint-test", version: "0.0.0" });
    await client.connect(clientSide);
  });

  afterAll(async () => {
    await client.close();
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it("moves both ends of the joint with joint true, and opens no CONTINUITY gap", async () => {
    const body = await setPose(splitProject(), true);
    const [first, second] = segmentsOf(body);
    expect(first?.to).toEqual({ xIn: 12, yIn: -49.5, headingRad: 1.5708 });
    expect(second?.from).toEqual(first?.to);
    expect(continuity(body)).toEqual([]);
  });

  it("moves only the point it names without it, as before", async () => {
    const body = await setPose(splitProject(), undefined);
    expect(segmentsOf(body)[1]?.from).toMatchObject({ xIn: -9, yIn: -49.5 });
    expect(continuity(body)).toHaveLength(1);
  });
});
