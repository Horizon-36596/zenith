import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The MCP server serves `packages/mcp/spec/*.md` as resources (`resources.ts`). They are copies of the
 * public docs pages, so an agent reads the same reference a person does on the docs site.
 */
const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

describe("the MCP spec resources", () => {
  it.each([
    ["../spec/file-format.md", "../../../site/docs/file-format.md"],
    ["../spec/checks.md", "../../../site/docs/checks-and-findings.md"],
  ])("%s is a byte-for-byte copy of %s", (copy, page) => {
    expect(read(copy), `re-copy ${page} to packages/mcp/${copy.slice(3)}`).toBe(read(page));
  });
});
