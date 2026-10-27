import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./server.js";

/**
 * zenith.edit.renameStep, zenith.edit.addStep and zenith.edit.insertAfter and the step id rule: an
 * id outside it is refused with the reason the editor's rename gives, and the file is left as it
 * was. Each test works on a temp copy of examples/starter.
 */

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, "..", "..", "..", "examples", "starter");

describe("zenith.edit.renameStep", () => {
  let client: Client;
  const temps: string[] = [];

  const project = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "zenith-mcp-rename-"));
    cpSync(examplesDir, dir, { recursive: true });
    temps.push(dir);
    return dir;
  };

  const rename = async (dir: string, newId: string): Promise<{ isError: boolean; text: string }> => {
    const result = (await client.callTool({
      name: "zenith.edit.renameStep",
      arguments: { auto: "first-auto", id: "driveOut", newId, project: dir },
    })) as { content: { type: string; text?: string }[]; isError?: boolean };
    return { isError: result.isError === true, text: result.content.find((item) => item.type === "text")?.text ?? "" };
  };

  beforeAll(async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    client = new Client({ name: "zenith-mcp-rename-test", version: "0.0.0" });
    await client.connect(clientSide);
  });

  afterAll(async () => {
    await client.close();
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an id outside the waypoint name rule with the reason, and writes nothing", async () => {
    const dir = project();
    const file = join(dir, "autos/first-auto.auto.json");
    const before = readFileSync(file, "utf8");
    const refused = await rename(dir, "drive out");
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("A step's id starts with a letter and holds only letters, digits, _ and -.");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("renames to an id inside the rule", async () => {
    const dir = project();
    const done = await rename(dir, "driveToScore");
    expect(done.isError).toBe(false);
    expect(readFileSync(join(dir, "autos/first-auto.auto.json"), "utf8")).toContain('"id": "driveToScore"');
  });
});

describe("zenith.edit.addStep and zenith.edit.insertAfter", () => {
  let client: Client;
  const temps: string[] = [];

  const project = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "zenith-mcp-add-id-"));
    cpSync(examplesDir, dir, { recursive: true });
    temps.push(dir);
    return dir;
  };

  const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> => {
    const result = (await client.callTool({ name, arguments: { auto: "first-auto", ...args } })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    return { isError: result.isError === true, text: result.content.find((item) => item.type === "text")?.text ?? "" };
  };

  const wait = (id?: string): Record<string, unknown> => ({ ...(id === undefined ? {} : { id }), kind: "wait", seconds: 0.5 });

  beforeAll(async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    client = new Client({ name: "zenith-mcp-add-id-test", version: "0.0.0" });
    await client.connect(clientSide);
  });

  afterAll(async () => {
    await client.close();
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it.each(["zenith.edit.addStep", "zenith.edit.insertAfter"])("%s refuses an id outside the rule and writes nothing", async (name) => {
    const dir = project();
    const file = join(dir, "autos/first-auto.auto.json");
    const before = readFileSync(file, "utf8");
    const dotted = await call(name, { afterId: "driveOut", step: wait("park.2"), project: dir });
    expect(dotted.isError).toBe(true);
    expect(dotted.text).toContain("A step's id starts with a letter and holds only letters, digits, _ and -.");
    const long = await call(name, { afterId: "driveOut", step: wait("a".repeat(65)), project: dir });
    expect(long.isError).toBe(true);
    expect(long.text).toContain("A step's id is at most 64 characters.");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it.each(["zenith.edit.addStep", "zenith.edit.insertAfter"])("%s adds a step with an id inside the rule, or none", async (name) => {
    const dir = project();
    expect((await call(name, { afterId: "driveOut", step: wait("pause_1"), project: dir })).isError).toBe(false);
    expect((await call(name, { afterId: "driveOut", step: wait(), project: dir })).isError).toBe(false);
    const written = readFileSync(join(dir, "autos/first-auto.auto.json"), "utf8");
    expect(written).toContain('"id": "pause_1"');
    expect(written).toContain('"id": "wait"');
  });
});
