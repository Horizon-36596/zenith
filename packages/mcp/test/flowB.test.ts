import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

/**
 * `Client.callTool`'s declared return type carries a legacy `{ toolResult }` variant this server
 * never sends; narrowed at runtime the same way `src/integration.test.ts` does, so both suites
 * agree on what a tool result looks like.
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

interface FindingLike {
  severity: string;
  code: string;
  stepId: string;
  message: string;
}

interface EditResult {
  written: string;
  auto: { steps: { id: string; kind: string }[] };
  findings: FindingLike[];
  errors: number;
  warnings: number;
}

/**
 * A small, self-contained project fixture, in the spirit of `packages/cli/src/testSupport.ts`'s
 * `TEST_FIELD`/`TEST_ROBOT`: a plain 144x144 field with no obstacles and an unregistered season
 * ("flowb-test" is not in `@horizon36596/zenith-seasons`'s registry), so every season-gated check
 * (`START_ILLEGAL`, `CAPACITY`, `MOUTH_LEADING`, ...) is inert (`noSeasonRules`) and the only
 * findings this flow can hit are the structural ones (`HEADING_MISSING`, `PERIMETER`, `CONTINUITY`).
 * That keeps the "apply edits until zero errors" loop below about the edits, not about the BIOBUZZ
 * field's start rules and obstacles.
 */
function makeProject(root: string): void {
  writeFileSync(
    join(root, "zenith.json"),
    `${JSON.stringify(
      {
        $schema: "https://libraries.horizon36596.org/zenith/schema/v1/link.json",
        formatVersion: 1,
        autosDir: "autos",
        robot: "autos/robot.json",
        field: "autos/field/field.json",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  mkdirSync(join(root, "autos/field"), { recursive: true });
  writeFileSync(
    join(root, "autos/robot.json"),
    `${JSON.stringify(
      {
        $schema: "https://libraries.horizon36596.org/zenith/schema/v1/robot.json",
        formatVersion: 1,
        name: "flowB test robot",
        frame: { forward: "+x", left: "+y", headingZero: "+x", headingPositive: "ccw" },
        footprint: {
          startIn: { lengthIn: 18, widthIn: 14, provenance: "PLACEHOLDER: flowB test fixture" },
          expandedIn: { lengthIn: 18, widthIn: 14, provenance: "PLACEHOLDER: flowB test fixture" },
          centreOfRotationIn: { xIn: 0, yIn: 0 },
        },
        heightIn: 18,
        kinematics: {
          maxForwardVelInPerS: { value: 60, provenance: "PLACEHOLDER: flowB test fixture" },
          maxStrafeVelInPerS: { value: 50, provenance: "PLACEHOLDER: flowB test fixture" },
          forwardDecelInPerS2: { value: 60, provenance: "PLACEHOLDER: flowB test fixture" },
          strafeDecelInPerS2: { value: 40, provenance: "PLACEHOLDER: flowB test fixture" },
          accelInPerS2: { value: 90, provenance: "PLACEHOLDER: flowB test fixture" },
          maxAngularVelRadPerS: { value: 6, provenance: "PLACEHOLDER: flowB test fixture" },
          defaultPathSpeedFraction: { value: 0.8, provenance: "SET BY HAND: flowB test fixture" },
          settleS: { value: 0.25, provenance: "PLACEHOLDER: flowB test fixture" },
          follower: { library: "pedro", version: "3.0.0-20260828.185437-17", holdEnd: true },
        },
        commands: [
          {
            name: "shootAll",
            params: { count: { type: "integer", min: 1, max: 4 } },
            estimateS: "0.6 + count",
            ledger: { launches: "count" },
            stationary: true,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    join(root, "autos/field/field.json"),
    `${JSON.stringify(
      {
        $schema: "https://libraries.horizon36596.org/zenith/schema/v1/field.json",
        formatVersion: 1,
        season: "flowb-test",
        name: "flowB test field",
        frame: {
          origin: "centre",
          xAxis: "audienceRight",
          yAxis: "awayFromAudience",
          headingZero: "+x",
          headingPositive: "ccw",
          units: "in",
          canonicalAlliance: "RED",
          mirror: "pointSymmetry",
        },
        sizeIn: { xIn: 144, yIn: 144 },
        periods: { autoS: 30, teleopS: 120 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/**
 * Drives the agent flow ("an agent authors a new auto", site/docs/agents-mcp.md) through the MCP tools
 * rather than the CLI: `newAutoFromTemplate`, a path step added without a heading (deliberately, so
 * `HEADING_MISSING` has something to fix), `setHeadingMode` to fix it, a `shootAll` command step,
 * then `validate` and an edit loop until the auto has zero errors, a PNG render and an estimate —
 * the same loop `/build-auto` runs, over the real stdio transport with the SDK's own client.
 */
describe("MCP flow B: an agent authors a new auto end to end", () => {
  let client: Client;
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), "zenith-mcp-flowb-"));
    makeProject(project);

    const transport = new StdioClientTransport({
      command: "pnpm",
      args: ["exec", "tsx", join(repoRoot, "packages/mcp/src/index.ts")],
      cwd: repoRoot,
    });
    client = new Client({ name: "zenith-mcp-flowb-test", version: "0.0.0" });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    await client.close();
    rmSync(project, { recursive: true, force: true });
  });

  it(
    "builds a clean auto from nothing and estimates it",
    async () => {
      // 1. newAutoFromTemplate: start touching no wall in particular (this field's season is
      // unregistered, so START_ILLEGAL is inert) but well inside the boundary either way.
      const created = await client.callTool({
        name: "zenith.edit.newAutoFromTemplate",
        arguments: {
          name: "flowb",
          alliance: "RED",
          start: { pose: { xIn: 0, yIn: -60, headingRad: 1.5708 } },
          project,
        },
      });
      const createdBody = JSON.parse(textResult(created).text) as EditResult;
      expect(textResult(created).isError).toBe(false);
      expect(createdBody.auto.steps.map((step) => step.id)).toContain("leg1");

      // 2. addStep (path): after "leg1", deliberately with no heading mode, so the next validate
      // finds exactly the HEADING_MISSING error this flow is about to fix.
      const withPath = await client.callTool({
        name: "zenith.edit.addStep",
        arguments: {
          auto: "flowb",
          afterId: "leg1",
          step: {
            id: "toShoot",
            kind: "path",
            segments: [{ kind: "line", from: "current", to: { xIn: 30, yIn: 30 } }],
          },
          project,
        },
      });
      expect(textResult(withPath).isError).toBe(false);
      const afterAddPath = JSON.parse(textResult(withPath).text) as EditResult;
      expect(afterAddPath.findings.some((finding) => finding.code === "HEADING_MISSING")).toBe(true);
      expect(afterAddPath.errors).toBeGreaterThan(0);

      // 3. setHeadingMode: fixes the HEADING_MISSING error from step 2.
      const withHeading = await client.callTool({
        name: "zenith.edit.setHeadingMode",
        arguments: { auto: "flowb", stepId: "toShoot", heading: { mode: "tangent" }, project },
      });
      expect(textResult(withHeading).isError).toBe(false);
      const afterHeading = JSON.parse(textResult(withHeading).text) as EditResult;
      expect(afterHeading.findings.some((finding) => finding.code === "HEADING_MISSING")).toBe(false);

      // 4. addStep (command): shootAll after the path step.
      const withCommand = await client.callTool({
        name: "zenith.edit.addStep",
        arguments: {
          auto: "flowb",
          afterId: "toShoot",
          step: { id: "shoot1", kind: "command", name: "shootAll", args: { count: 3 } },
          project,
        },
      });
      expect(textResult(withCommand).isError).toBe(false);

      // 5. validate, then apply edits until zero errors. The fixture is chosen to already be clean
      // by this point (no obstacles, well inside the field, a legal heading mode); the loop still
      // exercises the real agent workflow — read the findings, fix what they name, validate again —
      // rather than assuming the first attempt is always right.
      let errors = -1;
      for (let attempt = 0; attempt < 5 && errors !== 0; attempt += 1) {
        const validated = await client.callTool({
          name: "zenith.validate",
          arguments: { auto: "flowb", project },
        });
        expect(textResult(validated).isError).toBe(false);
        const body = JSON.parse(textResult(validated).text) as { findings: FindingLike[]; errors: number };
        errors = body.errors;
        if (errors === 0) break;

        // Only PERIMETER is plausible geometry-wise for this fixture; fix it by pulling the
        // offending step's segment endpoints halfway back toward the field centre and retry.
        const perimeterSteps = new Set(
          body.findings.filter((finding) => finding.code === "PERIMETER").map((finding) => finding.stepId),
        );
        expect(perimeterSteps.size, `unexpected findings blocking flowB: ${JSON.stringify(body.findings)}`).toBeGreaterThan(0);
        for (const stepId of perimeterSteps) {
          await client.callTool({
            name: "zenith.edit.setPose",
            arguments: {
              auto: "flowb",
              stepId,
              target: { segmentIndex: 0, pointKind: "to" },
              pose: { xIn: 15, yIn: 15 },
              project,
            },
          });
        }
      }
      expect(errors).toBe(0);

      // 6. render to a temp PNG.
      const pngPath = join(project, "flowb.png");
      const rendered = await client.callTool({
        name: "zenith.render",
        arguments: { auto: "flowb", out: pngPath, format: "png", project },
      });
      const renderedResult = textResult(rendered);
      expect(renderedResult.isError, renderedResult.text).toBe(false);
      expect(existsSync(pngPath)).toBe(true);

      // 7. estimate.
      const estimated = await client.callTool({
        name: "zenith.estimate",
        arguments: { auto: "flowb", project },
      });
      const estimatedResult = textResult(estimated);
      expect(estimatedResult.isError, estimatedResult.text).toBe(false);
      // finding 24: zenith.estimate now returns { estimate, findings, errors, seasonWarnings }, the
      // same shape zenith.validate's findings live in, rather than a bare Estimate — so a caller
      // can tell "blocked by an error finding" (estimate: null) from "a real number".
      const response = JSON.parse(estimatedResult.text) as {
        estimate: { nominalS: number | null; steps: unknown[] } | null;
        errors: number;
        seasonWarnings: string[];
      };
      expect(response.errors, estimatedResult.text).toBe(0);
      expect(response.estimate).not.toBeNull();
      const estimate = response.estimate as { nominalS: number | null; steps: unknown[] };
      expect(estimate.nominalS).not.toBeNull();
      expect(Array.isArray(estimate.steps)).toBe(true);
      expect(estimate.steps.length).toBeGreaterThan(0);

      // The file on disk is canonical: re-parsing and re-canonicalizing it gives back the exact
      // same bytes, the same round-trip `src/integration.test.ts` checks.
      const writtenPath = join(project, "autos", "flowb.auto.json");
      const writtenText = readFileSync(writtenPath, "utf8");
      const reparsed = loadAuto(JSON.parse(writtenText) as unknown);
      expect(canonicalize("auto", reparsed)).toBe(writtenText);
    },
    30000,
  );

  it(
    "finding 24: zenith.estimate refuses a number when the auto has a blocking error, and honours the auto's own robot override the same way zenith.render does",
    async () => {
      // Part 1: a path step with no heading mode is HEADING_MISSING, an error-severity finding.
      // zenith.estimate must report it and must not also hand back a nominal time as if the plan
      // were trustworthy.
      await client.callTool({
        name: "zenith.edit.newAutoFromTemplate",
        arguments: {
          name: "blocked",
          alliance: "RED",
          start: { pose: { xIn: 0, yIn: -60, headingRad: 1.5708 } },
          project,
        },
      });
      await client.callTool({
        name: "zenith.edit.addStep",
        arguments: {
          auto: "blocked",
          afterId: "leg1",
          step: {
            id: "noHeading",
            kind: "path",
            segments: [{ kind: "line", from: "current", to: { xIn: 10, yIn: 10 } }],
          },
          project,
        },
      });

      const blockedEstimate = await client.callTool({
        name: "zenith.estimate",
        arguments: { auto: "blocked", project },
      });
      const blockedResult = textResult(blockedEstimate);
      expect(blockedResult.isError, blockedResult.text).toBe(false);
      const blockedBody = JSON.parse(blockedResult.text) as {
        estimate: unknown;
        findings: FindingLike[];
        errors: number;
      };
      expect(blockedBody.errors).toBeGreaterThan(0);
      expect(blockedBody.findings.some((finding) => finding.code === "HEADING_MISSING")).toBe(true);
      expect(blockedBody.estimate).toBeNull();

      // Part 2: an auto naming its own robot override (a robot with a much higher top speed) must
      // plan against that robot everywhere, not just in the render — previously zenith.estimate's
      // findings.ts helper and zenith.render's own plan() call could each resolve the override
      // independently and disagree. Writing straight to disk (not through the edit tools, which do
      // not expose auto.robot) mirrors how a human or another agent would hand-edit the link.
      const fastRobotPath = join(project, "autos", "robot-fast.json");
      const baseRobotJson = JSON.parse(readFileSync(join(project, "autos/robot.json"), "utf8")) as {
        kinematics: { maxForwardVelInPerS: { value: number; provenance: string } };
      };
      writeFileSync(
        fastRobotPath,
        JSON.stringify(
          {
            ...(JSON.parse(readFileSync(join(project, "autos/robot.json"), "utf8")) as Record<string, unknown>),
            kinematics: {
              ...(JSON.parse(readFileSync(join(project, "autos/robot.json"), "utf8")) as { kinematics: Record<string, unknown> }).kinematics,
              maxForwardVelInPerS: { value: baseRobotJson.kinematics.maxForwardVelInPerS.value * 10, provenance: "SET BY HAND: flowB test fixture (fast)" },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const overriddenAuto = {
        $schema: SCHEMA_ID.auto,
        formatVersion: 1,
        name: "overridden",
        title: "overridden",
        alliance: "RED" as const,
        robot: "autos/robot-fast.json",
        start: { pose: { xIn: 0, yIn: -60, headingRad: 1.5708 } },
        steps: [
          {
            id: "leg1",
            kind: "path" as const,
            segments: [{ kind: "line" as const, from: "current" as const, to: { xIn: 0, yIn: 10 } }],
            heading: { mode: "tangent" as const },
          },
        ],
      };
      writeFileSync(
        join(project, "autos", "overridden.auto.json"),
        canonicalize("auto", loadAuto(overriddenAuto)),
        "utf8",
      );

      const overriddenEstimate = await client.callTool({
        name: "zenith.estimate",
        arguments: { auto: "overridden", project },
      });
      const overriddenResult = textResult(overriddenEstimate);
      expect(overriddenResult.isError, overriddenResult.text).toBe(false);
      const overriddenBody = JSON.parse(overriddenResult.text) as {
        estimate: { nominalS: number } | null;
        findings: FindingLike[];
        errors: number;
      };
      expect(overriddenBody.findings.some((finding) => finding.message.includes("Cannot use")), overriddenResult.text).toBe(
        false,
      );
      expect(overriddenBody.estimate).not.toBeNull();

      const plainAuto = { ...overriddenAuto, name: "plain", title: "plain", robot: undefined };
      delete (plainAuto as { robot?: string }).robot;
      writeFileSync(join(project, "autos", "plain.auto.json"), canonicalize("auto", loadAuto(plainAuto)), "utf8");
      const plainEstimate = await client.callTool({ name: "zenith.estimate", arguments: { auto: "plain", project } });
      const plainBody = JSON.parse(textResult(plainEstimate).text) as { estimate: { nominalS: number } | null };
      expect(plainBody.estimate).not.toBeNull();
      // The overridden robot is ten times as fast over the same leg, so its nominal time must be
      // meaningfully shorter than the default robot's — proof zenith.estimate actually planned
      // against autos/robot-fast.json rather than silently falling back to the link's robot.json.
      expect((overriddenBody.estimate as { nominalS: number }).nominalS).toBeLessThan(
        (plainBody.estimate as { nominalS: number }).nominalS,
      );

      // zenith.render (svg) must plan against the same override, not error, and must not report the
      // override as unreadable either.
      const overriddenRenderPath = join(project, "overridden.svg");
      const overriddenRender = await client.callTool({
        name: "zenith.render",
        arguments: { auto: "overridden", out: overriddenRenderPath, format: "svg", project },
      });
      const overriddenRenderResult = textResult(overriddenRender);
      expect(overriddenRenderResult.isError, overriddenRenderResult.text).toBe(false);
      expect(existsSync(overriddenRenderPath)).toBe(true);
    },
    30000,
  );
});
