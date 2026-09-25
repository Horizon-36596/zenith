#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

export { createServer, SERVER_NAME, SERVER_VERSION };

/**
 * The `@horizon36596/zenith-mcp` binary: runs the server over stdio, the transport Claude Code's
 * `.mcp.json` and every other MCP host speak (site/docs/agents-mcp.md). `createServer()` is
 * exported separately so a test, or a host that wants to embed the server in-process, does not have
 * to spawn a subprocess.
 */
export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
