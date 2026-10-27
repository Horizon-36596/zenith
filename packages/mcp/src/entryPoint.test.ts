import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

/**
 * Starts the server from `entry`, a path that reaches `src/index.ts` through a link, and lists its
 * tools. Before the fix the entry check compared the link's path with the real file's URL, so the
 * process exited without starting and `connect` failed on the closed stream.
 */
async function listToolsFrom(entry: string): Promise<string[]> {
  const transport = new StdioClientTransport({ command: "pnpm", args: ["exec", "tsx", entry], cwd: repoRoot });
  const client = new Client({ name: "zenith-mcp-entry-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

describe("the zenith-mcp bin started through a link", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "zenith-mcp-entry-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it(
    "starts through a file symlink, the way npm links node_modules/.bin/zenith-mcp on Linux and macOS",
    async (context) => {
      const link = join(root, "zenith-mcp.ts");
      try {
        symlinkSync(join(here, "index.ts"), link, "file");
      } catch {
        // Windows without Developer Mode cannot make file symlinks; CI on Linux runs this case, and
        // the junction case below covers the same path mismatch everywhere.
        context.skip();
      }
      expect(await listToolsFrom(link)).toContain("zenith.project.open");
    },
    30000,
  );

  it(
    "starts through a linked directory, where argv[1] is not the real path of the module",
    async () => {
      const linkDir = join(root, "linked-src");
      // A junction on Windows (no privilege needed), a directory symlink elsewhere.
      symlinkSync(here, linkDir, "junction");
      expect(await listToolsFrom(join(linkDir, "index.ts"))).toContain("zenith.project.open");
    },
    30000,
  );
});
