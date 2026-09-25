import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAnalysisTools } from "./tools/analysis.js";
import { registerAutoTools } from "./tools/auto.js";
import { registerEditTools } from "./tools/edit.js";
import { registerProjectTools } from "./tools/project.js";
import { registerResources } from "./resources.js";
import { VERSION } from "./version.js";

export const SERVER_NAME = "zenith";
/** The release version, stamped from the root package.json by scripts/stamp-version.mjs. */
export const SERVER_VERSION = VERSION;

/**
 * Builds the Zenith MCP server (site/docs/agents-mcp.md): the same verbs the
 * CLI has, plus structural edit tools, so an agent can author an auto end to end without
 * hand-editing JSON. Exported on its own (rather than only from `index.ts`) so the integration
 * test can connect a client to it directly, and so a host that wants to embed the server without
 * spawning a child process can too.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerProjectTools(server);
  registerAutoTools(server);
  registerAnalysisTools(server);
  registerEditTools(server);
  registerResources(server);
  return server;
}
