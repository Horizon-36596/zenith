import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonicalize, FINDING_HELP, loadAuto } from "@horizon36596/zenith-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Item 5: the format version 2 edit tools over stdio (`zenith.edit.wrap`, `unwrap`, `insertAfter`,
 * `repairContinuity`), a sequence step through `addStep`, and the finding help `zenith.validate`
 * returns. Each test works on its own temp copy of examples/starter, on its collect-and-score auto.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const examplesDir = join(repoRoot, "examples", "starter");

function body<T>(result: unknown): T {
  const value = result as { content?: { type: string; text?: string }[]; isError?: boolean };
  const text = value.content?.find((item) => item.type === "text")?.text ?? "";
  if (value.isError === true) throw new Error(`tool error: ${text}`);
  return JSON.parse(text) as T;
}

describe("the format version 2 MCP tools", () => {
  let client: Client;
  const temps: string[] = [];
  const copy = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "zenith-mcp-v2-"));
    cpSync(examplesDir, dir, { recursive: true });
    temps.push(dir);
    return dir;
  };

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: "pnpm",
      args: ["exec", "tsx", join(repoRoot, "packages/mcp/src/index.ts")],
      cwd: repoRoot,
    });
    client = new Client({ name: "zenith-mcp-v2-test", version: "0.0.0" });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    await client.close();
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it(
    "lists the group tools",
    async () => {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of ["zenith.edit.wrap", "zenith.edit.unwrap", "zenith.edit.insertAfter", "zenith.edit.repairContinuity"]) {
        expect(names).toContain(name);
      }
    },
    15000,
  );

  it(
    "wraps two steps in a sequence, unwraps it again, and writes canonical files",
    async () => {
      const project = copy();
      const wrapped = body<{ groupId: string; auto: { steps: { kind: string }[] } }>(
        await client.callTool({
          name: "zenith.edit.wrap",
          arguments: { auto: "collect-and-score", ids: ["waitForFull", "stopIntake"], kind: "sequence", project },
        }),
      );
      expect(wrapped.groupId).toBe("sequence");
      // The group takes the place of the first wrapped step, the fifth step of the auto.
      expect(wrapped.auto.steps[4]?.kind).toBe("sequence");
      const written = readFileSync(join(project, "autos/collect-and-score.auto.json"), "utf8");
      expect(written).toContain('"formatVersion": 3');
      expect(canonicalize("auto", loadAuto(JSON.parse(written) as unknown))).toBe(written);

      const unwrapped = body<{ auto: { steps: { id: string }[] } }>(
        await client.callTool({ name: "zenith.edit.unwrap", arguments: { auto: "collect-and-score", id: "sequence", project } }),
      );
      expect(unwrapped.auto.steps.slice(4, 6).map((step) => step.id)).toEqual(["waitForFull", "stopIntake"]);
    },
    20000,
  );

  it(
    "inserts a path after a step, reports the gap it opens, and repairs it",
    async () => {
      const project = copy();
      // Every path in collect-and-score after the first starts from "current", so no insert can
      // open a gap. Pin toGarden's start to the scoreSouth waypoint so the path inserted before it
      // leaves the robot somewhere else.
      const autoPath = join(project, "autos/collect-and-score.auto.json");
      const auto = JSON.parse(readFileSync(autoPath, "utf8")) as {
        steps: { id: string; segments?: { from: unknown }[] }[];
      };
      const toGarden = auto.steps.find((step) => step.id === "toGarden");
      toGarden!.segments![0]!.from = { ref: "scoreSouth" };
      writeFileSync(autoPath, JSON.stringify(auto, null, 2), "utf8");

      const inserted = body<{ id: string; continuityGapStepId: string | null; findings: { code: string; stepId: string }[] }>(
        await client.callTool({
          name: "zenith.edit.insertAfter",
          arguments: {
            auto: "collect-and-score",
            afterId: "scorePreload",
            step: {
              id: "nudge",
              kind: "path",
              segments: [{ kind: "line", from: "current", to: { xIn: -20, yIn: -36, headingRad: 1.5708 } }],
              heading: { mode: "constant", headingRad: 1.5708 },
            },
            project,
          },
        }),
      );
      expect(inserted.id).toBe("nudge");
      // `toGarden` now starts from the scoreSouth waypoint rather than "current", so it starts 8 in
      // from where the robot is.
      expect(inserted.continuityGapStepId).toBe("toGarden");
      expect(inserted.findings.some((finding) => finding.code === "CONTINUITY" && finding.stepId === "toGarden")).toBe(true);

      const repaired = body<{ findings: { code: string }[] }>(
        await client.callTool({
          name: "zenith.edit.repairContinuity",
          arguments: { auto: "collect-and-score", stepId: "toGarden", project },
        }),
      );
      expect(repaired.findings.filter((finding) => finding.code === "CONTINUITY")).toEqual([]);
    },
    20000,
  );

  it(
    "adds a sequence into a parallel group and returns plain-language help with the findings",
    async () => {
      const project = copy();
      const added = body<{ auto: unknown; help: Record<string, unknown>; findings: { code: string }[] }>(
        await client.callTool({
          name: "zenith.edit.addStep",
          arguments: {
            auto: "collect-and-score",
            step: {
              id: "intakePulse",
              kind: "sequence",
              steps: [
                { id: "pulseOn", kind: "command", name: "intakeOn" },
                { id: "pulseWait", kind: "wait", seconds: 0.5 },
                { id: "pulseOff", kind: "command", name: "intakeOff" },
              ],
            },
            into: { into: "returnToScore", index: 1 },
            project,
          },
        }),
      );
      const text = JSON.stringify(added.auto);
      expect(text).toContain('"intakePulse"');
      for (const finding of added.findings) {
        expect(added.help[finding.code]).toEqual(FINDING_HELP[finding.code as keyof typeof FINDING_HELP]);
      }

      const validated = body<{ help: Record<string, { title: string; means: string; fix: string }> }>(
        await client.callTool({ name: "zenith.validate", arguments: { auto: "collect-and-score", project } }),
      );
      // collect-and-score has no errors or warnings; its one finding is the TIME_BUDGET info.
      expect(validated.help["TIME_BUDGET"]?.title).toBe(FINDING_HELP.TIME_BUDGET.title);
    },
    20000,
  );
});
