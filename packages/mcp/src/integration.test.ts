import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const examplesDir = join(repoRoot, "examples", "starter");

/**
 * `Client.callTool`'s declared return type is a union with a legacy `{ toolResult }` shape used
 * by pre-2025-06-18 servers; this server always returns the standard `{ content, isError? }`
 * shape, so this narrows at runtime rather than fighting the union in every test.
 */
function textResult(result: unknown): { isError: boolean; text: string } {
  const value = result as { content?: unknown; isError?: unknown };
  if (!Array.isArray(value.content)) {
    throw new Error(`expected a content array in the tool result, got ${JSON.stringify(result)}`);
  }
  const block = (value.content as { type: string; text?: string }[]).find((item) => item.type === "text");
  if (block?.text === undefined) throw new Error("expected a text content block");
  return { isError: value.isError === true, text: block.text };
}

/**
 * Spawns the real `@horizon36596/zenith-mcp` server over stdio (the same transport `.mcp.json` uses) with the
 * SDK's own client, the way an agent host actually talks to it — not by importing `createServer`
 * in-process, which would not exercise the stdio framing at all.
 */
describe("the MCP server over stdio", () => {
  let client: Client;
  let tempProject: string;

  beforeAll(async () => {
    if (!existsSync(examplesDir)) {
      throw new Error(`examples/starter is missing at ${examplesDir}; cannot run the integration test.`);
    }
    tempProject = mkdtempSync(join(tmpdir(), "zenith-mcp-"));
    cpSync(examplesDir, tempProject, { recursive: true });

    const transport = new StdioClientTransport({
      command: "pnpm",
      args: ["exec", "tsx", join(repoRoot, "packages/mcp/src/index.ts")],
      cwd: repoRoot,
    });
    client = new Client({ name: "zenith-mcp-integration-test", version: "0.0.0" });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    await client.close();
    rmSync(tempProject, { recursive: true, force: true });
  });

  it(
    "opens examples/starter as a project",
    async () => {
      const result = await client.callTool({
        name: "zenith.project.open",
        arguments: { dir: examplesDir },
      });
      const { isError, text } = textResult(result);
      expect(isError).toBe(false);
      const body = JSON.parse(text) as { autos: string[]; robot: { commands: string[] } };
      expect(body.autos).toEqual(expect.arrayContaining(["first-auto", "collect-and-score", "all-step-kinds"]));
      expect(body.robot.commands.length).toBeGreaterThan(0);
    },
    15000,
  );

  it(
    "lists the zenith tools, including one per edit primitive",
    async () => {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      for (const expected of [
        "zenith.project.open",
        "zenith.auto.read",
        "zenith.validate",
        "zenith.estimate",
        "zenith.render",
        "zenith.diff",
        "zenith.sim",
        "zenith.registry",
        "zenith.waypoints",
        "zenith.edit.addStep",
        "zenith.edit.removeStep",
        "zenith.edit.moveStep",
        "zenith.edit.renameStep",
        "zenith.edit.setPose",
        "zenith.edit.setHeadingMode",
        "zenith.edit.setSpeed",
        "zenith.edit.addSegment",
        "zenith.edit.removeSegment",
        "zenith.edit.addMarker",
        "zenith.edit.removeMarker",
        "zenith.edit.setMarkerAt",
        "zenith.edit.setCommandArgs",
        "zenith.edit.setTimeout",
        "zenith.edit.setStart",
        "zenith.edit.setMeta",
        "zenith.edit.newAutoFromTemplate",
      ]) {
        expect(names, `expected ${expected} in the tool list`).toContain(expected);
      }
      // Every tool has a non-empty description written for an agent.
      for (const tool of tools) {
        expect(tool.description ?? "", tool.name).not.toBe("");
      }
    },
    15000,
  );

  it(
    "lists the two spec resources",
    async () => {
      const { resources } = await client.listResources();
      const uris = resources.map((resource) => resource.uri);
      expect(uris).toContain("zenith://spec/file-format");
      expect(uris).toContain("zenith://spec/checks");
    },
    15000,
  );

  it(
    "validates the starter first-auto example",
    async () => {
      const result = await client.callTool({
        name: "zenith.validate",
        arguments: { auto: "first-auto", project: examplesDir },
      });
      const { isError, text } = textResult(result);
      expect(isError).toBe(false);
      const body = JSON.parse(text) as {
        findings: { severity: string; code: string; stepId: string; message: string }[];
        errors: number;
      };
      expect(Array.isArray(body.findings)).toBe(true);
      // first-auto is the starter's smallest auto and validates clean: every reference resolves,
      // every command it names is registered, and no check has anything to report.
      expect(body.errors).toBe(0);
      expect(body.findings).toEqual([]);
    },
    15000,
  );

  it(
    "moves a segment endpoint on a temp copy, writing a canonical file back",
    async () => {
      const result = await client.callTool({
        name: "zenith.edit.setPose",
        arguments: {
          auto: "first-auto",
          stepId: "park",
          target: { segmentIndex: 0, pointKind: "to" },
          pose: { xIn: -40.5, yIn: -36, headingRad: 3.1416 },
          project: tempProject,
        },
      });
      const { isError, text } = textResult(result);
      expect(isError).toBe(false);
      const body = JSON.parse(text) as {
        written: string;
        findings: { severity: string; code: string; stepId: string; message: string }[];
        errors: number;
      };
      expect(body.written).toBe("autos/first-auto.auto.json");
      expect(Array.isArray(body.findings)).toBe(true);
      for (const finding of body.findings) {
        expect(typeof finding.severity).toBe("string");
        expect(typeof finding.code).toBe("string");
        expect(typeof finding.stepId).toBe("string");
        expect(typeof finding.message).toBe("string");
      }

      const writtenPath = join(tempProject, "autos", "first-auto.auto.json");
      const writtenText = readFileSync(writtenPath, "utf8");
      expect(writtenText).toContain('"xIn": -40.5');
      // Canonical form round-trips byte for byte: re-parsing and re-canonicalizing the file the
      // tool wrote must give back exactly the same bytes.
      const reparsed = loadAuto(JSON.parse(writtenText) as unknown);
      expect(canonicalize("auto", reparsed)).toBe(writtenText);
    },
    15000,
  );
});
