import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAppTools, type AppToolDeps } from "./tools/app.js";

const examplesDir = fileURLToPath(new URL("../../../examples/starter", import.meta.url));
const APP = "C:\\Team\\Local\\Programs\\Zenith\\Zenith.exe";

async function connect(deps: AppToolDeps): Promise<Client> {
  const server = new McpServer({ name: "zenith-app-test", version: "0.0.0" });
  registerAppTools(server, deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "zenith-app-test-client", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

const textOf = (result: unknown): { isError: boolean; text: string } => {
  const typed = result as { isError?: boolean; content: Array<{ type: string; text: string }> };
  return { isError: typed.isError === true, text: typed.content.map((part) => part.text).join("") };
};

let client: Client | null = null;
afterEach(async () => {
  await client?.close();
  client = null;
});

describe("zenith.app.open", () => {
  it("starts the desktop app on the project and the auto", async () => {
    const launch = vi.fn(async () => undefined);
    client = await connect({
      host: { env: { LOCALAPPDATA: "C:\\Team\\Local" }, platform: "win32", exists: (path) => path === APP || existsSync(path) },
      launch,
    });
    const result = textOf(await client.callTool({ name: "zenith.app.open", arguments: { project: examplesDir, auto: "first-auto" } }));
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ opened: true, root: examplesDir, auto: "first-auto.auto.json" });
    expect(launch).toHaveBeenCalledWith(APP, [`--zenith-open=${examplesDir}`, "--zenith-auto=first-auto.auto.json"]);
  });

  it("returns a clear error and starts nothing when the app is not installed", async () => {
    const launch = vi.fn(async () => undefined);
    client = await connect({ host: { env: {}, platform: "linux", exists: existsSync }, launch });
    const result = textOf(await client.callTool({ name: "zenith.app.open", arguments: { project: examplesDir } }));
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/desktop app is not installed/);
    expect(launch).not.toHaveBeenCalled();
  });
});
