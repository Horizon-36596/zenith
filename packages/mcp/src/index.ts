#!/usr/bin/env node
import { isEntryPoint } from "@horizon36596/zenith-cli/lib";
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

// Through symlinks: `npx @horizon36596/zenith-mcp` on Linux and macOS starts this file from a
// `node_modules/.bin` link, which a plain URL comparison would not match, so the server never started.
if (isEntryPoint(process.argv[1], import.meta.url)) {
  await main();
}
