import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FINDING_HELP } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { createServer } from "./server.js";

/**
 * The public docs pages that list things the code defines: every finding code on the checks page,
 * and every MCP tool on the agents page. A code or a tool added without its documentation fails
 * here, the way `specCopies.test.ts` fails when a spec copy drifts from its page.
 */
const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("site/docs/checks-and-findings.md", () => {
  const page = read("../../../site/docs/checks-and-findings.md");

  it.each(Object.keys(FINDING_HELP))("lists %s in a code table", (code) => {
    expect(page, `add a table row for ${code}`).toContain(`| [\`${code}\`](#${code.toLowerCase()}) |`);
  });

  it.each(Object.entries(FINDING_HELP))("explains %s under its own heading, with the editor's title", (code, help) => {
    // A title that ends in its own punctuation, such as a question, takes no full stop.
    const bold = /[.?!]$/.test(help.title) ? help.title : `${help.title}.`;
    const heading = new RegExp(`^### \`${escape(code)}\`\\n\\n\\*\\*${escape(bold)}\\*\\* `, "m");
    expect(page, `add a "### \`${code}\`" section that starts "**${bold}**"`).toMatch(heading);
  });
});

describe("site/docs/agents-mcp.md", () => {
  it("names every tool the MCP server registers", async () => {
    const page = read("../../../site/docs/agents-mcp.md");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    const client = new Client({ name: "zenith-mcp-docs-drift-test", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names.length).toBeGreaterThan(0);
      // The edit tools are listed in their own table without the `zenith.edit.` prefix.
      const missing = names.filter((name) => {
        const short = name.startsWith("zenith.edit.") ? name.slice("zenith.edit.".length) : name;
        return !page.includes(`\`${name}\``) && !page.includes(`\`${short}\``);
      });
      expect(missing, "list these tools on the Agents and MCP page").toEqual([]);
    } finally {
      await client.close();
    }
  });
});
