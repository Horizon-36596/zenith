import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { canonicalize, loadAuto, projectShare, runLedger, simulate, type Finding } from "@horizon36596/zenith-core";
import { parseProjection, type Auto, type Projection } from "@horizon36596/zenith-schema";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAutoAndPlan } from "./findings.js";
import { readJsonFile, resolveAutoPath, resolveProject } from "./project.js";
import { createServer } from "./server.js";

/**
 * `zenith.import` and `zenith.projection`, in process: the same files `zenith import` and
 * `zenith projection` write, nothing written without `out`, and nothing written outside the project.
 */

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, "..", "..", "..", "examples", "starter");
const fixturesDir = join(here, "..", "..", "import", "fixtures");

function body<T>(result: unknown): { isError: boolean; value: T; text: string } {
  const value = result as { content?: { type: string; text?: string }[]; isError?: boolean };
  const text = value.content?.find((item) => item.type === "text")?.text ?? "";
  if (value.isError === true) return { isError: true, value: undefined as T, text };
  return { isError: false, value: JSON.parse(text) as T, text };
}

interface ImportResult {
  kind: string;
  written: string | null;
  auto?: Auto;
  projection?: Projection;
  robotFootprint?: { lengthIn: number; widthIn: number };
  findings?: Finding[];
  warnings: string[];
}

describe("zenith.import and zenith.projection", () => {
  let client: Client;
  let project = "";

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), "zenith-mcp-import-"));
    cpSync(examplesDir, project, { recursive: true });
    cpSync(fixturesDir, join(project, "fixtures"), { recursive: true });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    client = new Client({ name: "zenith-mcp-import-test", version: "0.0.0" });
    await client.connect(clientSide);
  });

  afterAll(async () => {
    await client.close();
    rmSync(project, { recursive: true, force: true });
  });

  const call = async <T>(name: string, args: Record<string, unknown>) => body<T>(await client.callTool({ name, arguments: { ...args, project } }));

  it("is listed", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["zenith.import", "zenith.projection"]));
  });

  it("imports a .pp project as an auto with its findings, and writes it only when given out", async () => {
    const dry = await call<ImportResult>("zenith.import", { file: "fixtures/pedro/score-and-park.pp", alliance: "RED" });
    expect(dry.isError).toBe(false);
    expect(dry.value).toMatchObject({ kind: "pedro", written: null });
    expect(dry.value.auto?.name).toBe("score-and-park");
    expect(Array.isArray(dry.value.findings)).toBe(true);
    expect(existsSync(join(project, "autos", "score-and-park.auto.json"))).toBe(false);

    const wrote = await call<ImportResult>("zenith.import", { file: "fixtures/pedro/score-and-park.pp", alliance: "RED", out: "autos/score-and-park.auto.json" });
    expect(wrote.value.written).toBe("autos/score-and-park.auto.json");
    const text = readFileSync(join(project, "autos", "score-and-park.auto.json"), "utf8");
    expect(text).toBe(canonicalize("auto", loadAuto(JSON.parse(text))));

    const again = await call<ImportResult>("zenith.import", { file: "fixtures/pedro/score-and-park.pp", out: "autos/score-and-park.auto.json" });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already exists\. Pass force: true/);
  });

  it("imports a trajectory.json as a projection zenith.alliance reads, or as an auto with asAuto", async () => {
    const projection = await call<ImportResult>("zenith.import", {
      file: "fixtures/trajectory/meepmeep-line-and-turn.trajectory.json",
      out: "partners/meepmeep.projection.json",
    });
    expect(projection.value.kind).toBe("trajectory");
    expect(parseProjection(readJsonFile(join(project, "partners", "meepmeep.projection.json"))).trajectory.rateHz).toBe(10);
    const alliance = await call<{ partners: { label: string }[] }>("zenith.alliance", { auto: "first-auto", projections: ["partners/meepmeep.projection.json"] });
    expect(alliance.isError).toBe(false);
    expect(alliance.value.partners[0]?.label).toBe("MeepMeep line and turn");

    const auto = await call<ImportResult>("zenith.import", { file: "fixtures/trajectory/meepmeep-line-and-turn.trajectory.json", asAuto: true });
    expect(auto.value.auto?.steps.map((step) => step.id)).toEqual(["drive1", "wait1", "turn1"]);
    expect(auto.value.robotFootprint).toEqual({ lengthIn: 18, widthIn: 18 });
  });

  it("names every wrong field of a file it cannot import, and refuses a path outside the project", async () => {
    const broken = await call<ImportResult>("zenith.import", { file: "fixtures/path/broken/piecewise-gap.path.json" });
    expect(broken.isError).toBe(true);
    expect(broken.text).toContain("steps[2].heading.ranges[1].startT");
    const outside = await call<ImportResult>("zenith.import", { file: "fixtures/pedro/score-and-park.pp", out: "../escape.auto.json" });
    expect(outside.isError).toBe(true);
    expect(outside.text).toMatch(/outside the project root/);
  });

  it("writes the projection core builds for an auto, the one zenith projection writes", async () => {
    const result = await call<{ written: string; bytes: number; projection: Projection }>("zenith.projection", {
      auto: "collect-and-score",
      level: "propose",
      out: "partners/mine.projection.json",
    });
    expect(result.isError).toBe(false);
    const proj = resolveProject(project);
    const loaded = loadAutoAndPlan(loadAuto(readJsonFile(resolveAutoPath(proj, "collect-and-score"))), proj);
    const season = resolveSeason(loaded.field).rules;
    const ledger = runLedger(loaded.plan, loaded.field, season);
    const expected = canonicalize(
      "projection",
      projectShare({ plan: loaded.plan, trace: simulate(loaded.plan, loaded.robot, loaded.field, { ledger, season }), robot: loaded.robot, field: loaded.field, ledger }, { level: "propose" }),
    );
    expect(readFileSync(join(project, "partners", "mine.projection.json"), "utf8")).toBe(expected);
    expect(result.value.bytes).toBe(Buffer.byteLength(expected));
    expect(result.value.projection.level).toBe("propose");
  });

  it("names the commands only with includeCommands, as zenith projection --include-commands does", async () => {
    const proj = resolveProject(project);
    const loaded = loadAutoAndPlan(loadAuto(readJsonFile(resolveAutoPath(proj, "collect-and-score"))), proj);
    const season = resolveSeason(loaded.field).rules;
    const ledger = runLedger(loaded.plan, loaded.field, season);
    const inputs = { plan: loaded.plan, trace: simulate(loaded.plan, loaded.robot, loaded.field, { ledger, season }), robot: loaded.robot, field: loaded.field, ledger };

    const named = await call<{ projection: Projection }>("zenith.projection", {
      auto: "collect-and-score",
      title: "Horizon collect",
      includeCommands: true,
    });
    expect(named.isError).toBe(false);
    const expected = projectShare(inputs, { level: "view", title: "Horizon collect", includeCommands: true });
    expect(named.value.projection).toEqual(JSON.parse(canonicalize("projection", expected)));
    expect(named.value.projection.title).toBe("Horizon collect");
    expect(named.value.projection.commands?.length).toBeGreaterThan(0);

    const plain = await call<{ projection: Projection }>("zenith.projection", { auto: "collect-and-score" });
    expect(plain.value.projection.commands).toBeUndefined();
  });
});
