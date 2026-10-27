import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./server.js";

/** `zenith.importCommands`, in process: robot.json against the Java, and written only on `write`. */

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, "..", "..", "..", "examples", "starter");
const readmeRobot = join(here, "..", "..", "import", "fixtures", "java", "readme", "MyRobot.java");

describe("zenith.importCommands", () => {
  let client: Client;
  let project = "";

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), "zenith-mcp-commands-"));
    cpSync(examplesDir, project, { recursive: true });
    const java = join(project, "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/zenith/MyRobot.java");
    mkdirSync(dirname(java), { recursive: true });
    // The README's robot, plus one command robot.json does not have yet.
    writeFileSync(
      java,
      readFileSync(readmeRobot, "utf8").replace(
        'NamedCommands.registerCondition("holdingPiece", intake::hasPiece);',
        'NamedCommands.registerCondition("holdingPiece", intake::hasPiece);\n        NamedCommands.register("wiggle", (args, ctx) -> wiggle(NamedCommands.argDouble(args, "wiggle", "seconds", 0.5)));',
      ),
      "utf8",
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    client = new Client({ name: "zenith-mcp-commands-test", version: "0.0.0" });
    await client.connect(clientSide);
  });

  afterAll(async () => {
    await client.close();
    rmSync(project, { recursive: true, force: true });
  });

  const call = async (args: Record<string, unknown>) => {
    const result = (await client.callTool({ name: "zenith.importCommands", arguments: { ...args, project } })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    expect(result.isError ?? false).toBe(false);
    return JSON.parse(result.content[0]?.text ?? "{}") as {
      changes: { kind: string; name: string }[];
      findings: { severity: string; name?: string }[];
      written: string | null;
      errors: number;
      diff: string;
    };
  };

  it("reports what robot.json lacks and every disagreement, and writes nothing by default", async () => {
    const before = readFileSync(join(project, "autos/robot.json"), "utf8");
    const result = await call({});
    expect(result.changes.map((change) => [change.kind, change.name])).toEqual([["addCommand", "wiggle"]]);
    expect(result.written).toBeNull();
    expect(result.diff).toContain('"name": "wiggle"');
    expect(result.findings.filter((finding) => finding.severity === "error").map((finding) => finding.name)).toEqual([
      "intakeOff",
      "spinUp",
      "hopperFull",
      "hopperEmpty",
    ]);
    expect(readFileSync(join(project, "autos/robot.json"), "utf8")).toBe(before);
  });

  it("writes the additions when asked", async () => {
    const result = await call({ dirs: ["TeamCode"], write: true });
    expect(result.written).toBe("autos/robot.json");
    const robot = JSON.parse(readFileSync(join(project, "autos/robot.json"), "utf8")) as { commands: { name: string; estimateS: string }[] };
    expect(robot.commands.find((command) => command.name === "wiggle")?.estimateS).toBe("unknown");
    expect((await call({})).changes).toEqual([]);
  });
});
