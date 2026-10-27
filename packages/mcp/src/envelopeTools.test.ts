import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The envelope and rejoin edit tools over stdio (`zenith.edit.setEnvelope`, `setEnvelopeCorner`,
 * `addEnvelopeCorner`, `removeEnvelopeCorner`, `setRejoinFrom`; spec 13 section 10). Each test works
 * on its own temp copy of examples/starter, on its first-auto: the path `driveOut` from the start
 * waypoint, the command `scorePreload`, and the path `park` from `"current"`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const examplesDir = join(repoRoot, "examples", "starter");

interface Finding {
  severity: string;
  code: string;
  stepId: string;
}

interface EditBody {
  written: string;
  auto: { steps: { id: string; envelope?: { polygon: { xIn: number; yIn: number }[] }; rejoinFrom?: unknown }[] };
  findings: Finding[];
}

function result(value: unknown): { isError: boolean; text: string } {
  const typed = value as { content?: { type: string; text?: string }[]; isError?: boolean };
  return { isError: typed.isError === true, text: typed.content?.find((item) => item.type === "text")?.text ?? "" };
}

function body(value: unknown): EditBody {
  const { isError, text } = result(value);
  if (isError) throw new Error(`tool error: ${text}`);
  return JSON.parse(text) as EditBody;
}

const SQUARE = {
  polygon: [
    { xIn: -48, yIn: -48 },
    { xIn: -24, yIn: -48 },
    { xIn: -24, yIn: -24 },
    { xIn: -48, yIn: -24 },
  ],
  maxDurationS: 4,
  provenance: "SET BY HAND: the MCP envelope test",
};

describe("the envelope and rejoin MCP tools", () => {
  let client: Client;
  const temps: string[] = [];
  const copy = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "zenith-mcp-envelope-"));
    cpSync(examplesDir, dir, { recursive: true });
    temps.push(dir);
    return dir;
  };
  const writtenAuto = (project: string): string => readFileSync(join(project, "autos/first-auto.auto.json"), "utf8");
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: { auto: "first-auto", ...args } });

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: "pnpm",
      args: ["exec", "tsx", join(repoRoot, "packages/mcp/src/index.ts")],
      cwd: repoRoot,
    });
    client = new Client({ name: "zenith-mcp-envelope-test", version: "0.0.0" });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    await client.close();
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it(
    "lists the envelope tools, each with a description",
    async () => {
      const tools = (await client.listTools()).tools;
      for (const name of [
        "zenith.edit.setEnvelope",
        "zenith.edit.setEnvelopeCorner",
        "zenith.edit.addEnvelopeCorner",
        "zenith.edit.removeEnvelopeCorner",
        "zenith.edit.setRejoinFrom",
      ]) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool, name).toBeDefined();
        expect(tool?.description ?? "", name).not.toBe("");
      }
    },
    15000,
  );

  it(
    "sets an envelope, edits its corners and removes it, writing canonical files",
    async () => {
      const project = copy();
      const set = body(await call("zenith.edit.setEnvelope", { stepId: "scorePreload", envelope: SQUARE, project }));
      expect(set.written).toBe("autos/first-auto.auto.json");
      expect(set.auto.steps[1]?.envelope?.polygon).toEqual(SQUARE.polygon);
      let text = writtenAuto(project);
      expect(canonicalize("auto", loadAuto(JSON.parse(text) as unknown))).toBe(text);
      // The envelope is written before notes, as canonical form orders a command step.
      expect(text.indexOf('"envelope"')).toBeLessThan(text.indexOf('"notes": "Launches'));

      const moved = body(
        await call("zenith.edit.setEnvelopeCorner", {
          stepId: "scorePreload",
          cornerIndex: 2,
          corner: { xIn: -20, yIn: -20 },
          project,
        }),
      );
      expect(moved.auto.steps[1]?.envelope?.polygon[2]).toEqual({ xIn: -20, yIn: -20 });

      const added = body(await call("zenith.edit.addEnvelopeCorner", { stepId: "scorePreload", afterIndex: 0, project }));
      // The new corner sits at the middle of the edge from corner 0 to corner 1.
      expect(added.auto.steps[1]?.envelope?.polygon).toHaveLength(5);
      expect(added.auto.steps[1]?.envelope?.polygon[1]).toEqual({ xIn: -36, yIn: -48 });

      const removed = body(await call("zenith.edit.removeEnvelopeCorner", { stepId: "scorePreload", cornerIndex: 1, project }));
      expect(removed.auto.steps[1]?.envelope?.polygon).toHaveLength(4);
      text = writtenAuto(project);
      expect(canonicalize("auto", loadAuto(JSON.parse(text) as unknown))).toBe(text);

      const cleared = body(await call("zenith.edit.setEnvelope", { stepId: "scorePreload", project }));
      expect(cleared.auto.steps[1]?.envelope).toBeUndefined();
      expect(writtenAuto(project)).not.toContain('"envelope"');
    },
    20000,
  );

  it(
    "writes a what-if actualDurationS after maxDurationS, and refuses one longer than the window",
    async () => {
      const project = copy();
      const set = body(
        await call("zenith.edit.setEnvelope", { stepId: "scorePreload", envelope: { ...SQUARE, actualDurationS: 1.5 }, project }),
      );
      expect((set.auto.steps[1]?.envelope as { actualDurationS?: number } | undefined)?.actualDurationS).toBe(1.5);
      const text = writtenAuto(project);
      expect(canonicalize("auto", loadAuto(JSON.parse(text) as unknown))).toBe(text);
      expect(text.indexOf('"maxDurationS"')).toBeLessThan(text.indexOf('"actualDurationS"'));
      expect(text.indexOf('"actualDurationS"')).toBeLessThan(text.indexOf('"provenance": "SET BY HAND: the MCP envelope test"'));

      const refused = result(
        await call("zenith.edit.setEnvelope", { stepId: "scorePreload", envelope: { ...SQUARE, actualDurationS: 5 }, project }),
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("actualDurationS");
      expect(writtenAuto(project)).toBe(text);
    },
    20000,
  );

  it(
    "reports a crossed polygon as ENVELOPE_SHAPE and refuses to leave fewer than three corners",
    async () => {
      const project = copy();
      body(await call("zenith.edit.setEnvelope", { stepId: "driveOut", envelope: SQUARE, project }));
      // Pulling the last corner out past the east edge makes the closing edge cross that edge.
      const crossed = body(
        await call("zenith.edit.setEnvelopeCorner", {
          stepId: "driveOut",
          cornerIndex: 3,
          corner: { xIn: -12, yIn: -36 },
          project,
        }),
      );
      expect(crossed.auto.steps[0]?.envelope?.polygon[3]).toEqual({ xIn: -12, yIn: -36 });
      expect(crossed.findings.some((finding) => finding.code === "ENVELOPE_SHAPE" && finding.stepId === "driveOut")).toBe(true);

      body(await call("zenith.edit.removeEnvelopeCorner", { stepId: "driveOut", cornerIndex: 0, project }));
      const before = writtenAuto(project);
      const refused = result(await call("zenith.edit.removeEnvelopeCorner", { stepId: "driveOut", cornerIndex: 0, project }));
      expect(refused.isError).toBe(true);
      // A refused edit never touches the file on disk.
      expect(writtenAuto(project)).toBe(before);

      const unknown = result(await call("zenith.edit.setEnvelope", { stepId: "noSuchStep", envelope: SQUARE, project }));
      expect(unknown.isError).toBe(true);
    },
    20000,
  );

  it(
    "sets a rejoin pose, which is used after a command that moves the robot and warned about otherwise",
    async () => {
      const project = copy();
      const pose = { xIn: -30, yIn: -30, headingRad: 1.5708, provenance: "SET BY HAND: the MCP rejoin test" };

      // score does not move the robot in the starter's robot.json, so the pose is not used.
      const unused = body(await call("zenith.edit.setRejoinFrom", { stepId: "park", pose, project }));
      expect(unused.auto.steps[2]?.rejoinFrom).toEqual(pose);
      expect(unused.findings.some((finding) => finding.code === "MOVES_ROBOT" && finding.stepId === "park")).toBe(true);
      const text = writtenAuto(project);
      expect(canonicalize("auto", loadAuto(JSON.parse(text) as unknown))).toBe(text);

      // Mark score as a command that moves the robot: now the pose is where park starts from.
      const robotPath = join(project, "autos/robot.json");
      const robot = JSON.parse(readFileSync(robotPath, "utf8")) as { commands: { name: string; movesRobot?: boolean }[] };
      robot.commands.find((command) => command.name === "score")!.movesRobot = true;
      writeFileSync(robotPath, JSON.stringify(robot, null, 2), "utf8");
      const used = body(await call("zenith.edit.setRejoinFrom", { stepId: "park", pose, project }));
      expect(used.findings.filter((finding) => finding.code === "MOVES_ROBOT")).toEqual([]);

      // A path that starts from a fixed pose cannot rejoin, and clearing takes the key away.
      expect(result(await call("zenith.edit.setRejoinFrom", { stepId: "driveOut", pose, project })).isError).toBe(true);
      const cleared = body(await call("zenith.edit.setRejoinFrom", { stepId: "park", pose: null, project }));
      expect(cleared.auto.steps[2]?.rejoinFrom).toBeUndefined();
    },
    20000,
  );

  it(
    "carries an envelope and a rejoin pose through zenith.edit.addStep",
    async () => {
      const project = copy();
      const added = body(
        await call("zenith.edit.addStep", {
          step: {
            id: "hold",
            kind: "wait",
            until: "hopperFull",
            envelope: SQUARE,
          },
          project,
        }),
      );
      expect(added.auto.steps.find((step) => step.id === "hold")?.envelope?.polygon).toEqual(SQUARE.polygon);

      const rejoinFrom = { xIn: -30, yIn: -30, headingRad: 0 };
      const path = body(
        await call("zenith.edit.addStep", {
          step: {
            id: "leave",
            kind: "path",
            rejoinFrom,
            segments: [{ kind: "line", from: "current", to: { xIn: -30, yIn: -10, headingRad: 1.5708 } }],
            heading: { mode: "tangent" },
          },
          project,
        }),
      );
      expect(path.auto.steps.find((step) => step.id === "leave")?.rejoinFrom).toEqual(rejoinFrom);
    },
    20000,
  );
});
