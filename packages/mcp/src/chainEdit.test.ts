import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./server.js";

/**
 * The path chain verbs of issue #185: zenith.edit.appendSegment, removeSegmentJoined and
 * joinSegmentsAt, and joinSteps of issue #204. Each test works on a temp copy of examples/starter, whose first-auto's driveOut
 * runs north from waypoint start (-9, -63) to waypoint scoreSouth (-9, -36), and checks that the
 * file each verb writes is canonical: loading it and writing it again gives the same bytes.
 */

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, "..", "..", "..", "examples", "starter");

interface Segment {
  kind: string;
  from: unknown;
  to: unknown;
}

interface EditBody {
  written: string;
  auto: { steps: { id: string; segments?: Segment[] }[] };
  findings: { code: string; stepId: string }[];
  movedMarkers: number;
  movedRanges: number;
  droppedWaypoints: string[];
}

describe("the path chain edit verbs", () => {
  let client: Client;
  const temps: string[] = [];

  const project = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "zenith-mcp-chain-"));
    cpSync(examplesDir, dir, { recursive: true });
    temps.push(dir);
    return dir;
  };

  const call = async (name: string, args: Record<string, unknown>): Promise<EditBody> => {
    const result = (await client.callTool({ name, arguments: { auto: "first-auto", stepId: "driveOut", ...args } })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = result.content.find((item) => item.type === "text")?.text ?? "";
    if (result.isError === true) throw new Error(`tool error: ${text}`);
    return JSON.parse(text) as EditBody;
  };

  /** The written file, after checking that it is exactly what canonical form writes for it. */
  const canonicalFile = (dir: string): string => {
    const text = readFileSync(join(dir, "autos/first-auto.auto.json"), "utf8");
    expect(canonicalize("auto", loadAuto(JSON.parse(text) as unknown))).toBe(text);
    return text;
  };

  const segmentsOf = (body: EditBody): Segment[] => body.auto.steps.find((step) => step.id === "driveOut")?.segments ?? [];
  const continuity = (body: EditBody) => body.findings.filter((finding) => finding.code === "CONTINUITY");

  beforeAll(async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    client = new Client({ name: "zenith-mcp-chain-test", version: "0.0.0" });
    await client.connect(clientSide);
  });

  afterAll(async () => {
    await client.close();
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it("appendSegment adds a line from current, and removeSegmentJoined takes it away again", async () => {
    const dir = project();
    const original = readFileSync(join(dir, "autos/first-auto.auto.json"), "utf8");
    const appended = await call("zenith.edit.appendSegment", { project: dir });
    expect(appended.written).toBe("autos/first-auto.auto.json");
    const segments = segmentsOf(appended);
    expect(segments).toHaveLength(2);
    expect(segments[1]).toMatchObject({ kind: "line", from: "current" });
    expect(continuity(appended)).toEqual([]);
    canonicalFile(dir);

    const removed = await call("zenith.edit.removeSegmentJoined", { segmentIndex: 1, project: dir });
    expect(segmentsOf(removed)).toHaveLength(1);
    expect(canonicalFile(dir)).toBe(canonicalize("auto", loadAuto(JSON.parse(original) as unknown)));
  });

  it("appendSegment cuts the new segment to the auto's own field, not the project's", async () => {
    // driveOut made to end heading south at (-9, -36), so the appended 24 in runs toward the south
    // wall. On the project's field it fits whole; the auto names a field 8 in smaller each way, on
    // which it has to be cut short.
    const appendSouth = async (smallField: boolean): Promise<number> => {
      const dir = project();
      const file = join(dir, "autos/first-auto.auto.json");
      const auto = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> & {
        steps: { id: string; segments?: unknown[] }[];
      };
      const driveOut = auto.steps.find((step) => step.id === "driveOut");
      if (driveOut === undefined) throw new Error("the starter first-auto has no driveOut");
      driveOut.segments = [
        {
          kind: "line",
          from: { xIn: -9, yIn: -20, provenance: "SET FROM EDITOR" },
          to: { xIn: -9, yIn: -36, provenance: "SET FROM EDITOR" },
        },
      ];
      if (smallField) {
        const fieldFile = join(dir, "autos/field/biobuzz.field.json");
        const field = JSON.parse(readFileSync(fieldFile, "utf8")) as { sizeIn: { xIn: number; yIn: number } };
        field.sizeIn = { xIn: field.sizeIn.xIn - 16, yIn: field.sizeIn.yIn - 16 };
        writeFileSync(join(dir, "autos/field/small.field.json"), JSON.stringify(field, null, 2));
        auto.field = "autos/field/small.field.json";
      }
      writeFileSync(file, JSON.stringify(auto, null, 2));
      const appended = await call("zenith.edit.appendSegment", { project: dir });
      const added = segmentsOf(appended)[1];
      expect(added).toMatchObject({ kind: "line", from: "current" });
      return (added?.to as { yIn: number }).yIn;
    };

    const onProjectField = await appendSouth(false);
    const onOwnField = await appendSouth(true);
    expect(onProjectField).toBeCloseTo(-60, 1);
    expect(onOwnField).toBeGreaterThan(-59);
    expect(onOwnField).toBeLessThanOrEqual(-48);
  });

  it("joinSegmentsAt merges two halves of driveOut back into one line between the same waypoints", async () => {
    const dir = project();
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

    const joined = await call("zenith.edit.joinSegmentsAt", { nodeIndex: 1, project: dir });
    expect(segmentsOf(joined)).toEqual([{ kind: "line", from: { ref: "start" }, to: { ref: "scoreSouth" } }]);
    expect(joined.droppedWaypoints).toEqual([]);
    expect(continuity(joined)).toEqual([]);
    canonicalFile(dir);
  });

  it("joinSteps joins a path step with the next one, and writes a canonical auto (issue #204)", async () => {
    const dir = project();
    const file = join(dir, "autos/first-auto.auto.json");
    const auto = JSON.parse(readFileSync(file, "utf8")) as { steps: { id: string }[] };
    // Without the command between them, driveOut and park follow each other with nothing between.
    auto.steps = auto.steps.filter((step) => step.id !== "scorePreload");
    writeFileSync(file, JSON.stringify(auto, null, 2));

    const joined = await call("zenith.edit.joinSteps", { project: dir });
    expect(joined.auto.steps.map((step) => step.id)).toEqual(["driveOut"]);
    expect(segmentsOf(joined)).toEqual([
      { kind: "line", from: { ref: "start" }, to: { ref: "scoreSouth" } },
      { kind: "line", from: "current", to: { ref: "park" } },
    ]);
    expect(joined.droppedWaypoints).toEqual([]);
    expect(continuity(joined)).toEqual([]);
    canonicalFile(dir);
  });

  it("joinSteps refuses a next step that is not a path, and leaves the file alone", async () => {
    const dir = project();
    const before = readFileSync(join(dir, "autos/first-auto.auto.json"), "utf8");
    await expect(call("zenith.edit.joinSteps", { project: dir })).rejects.toThrow(/scorePreload is a command step/);
    expect(readFileSync(join(dir, "autos/first-auto.auto.json"), "utf8")).toBe(before);
  });

  it("removeSegmentJoined refuses a one-segment path and leaves the file alone", async () => {
    const dir = project();
    const before = readFileSync(join(dir, "autos/first-auto.auto.json"), "utf8");
    await expect(call("zenith.edit.removeSegmentJoined", { segmentIndex: 0, project: dir })).rejects.toThrow(
      /needs at least one/,
    );
    expect(readFileSync(join(dir, "autos/first-auto.auto.json"), "utf8")).toBe(before);
  });
});
