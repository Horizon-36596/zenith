import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * `zenith://spec/file-format` and `zenith://spec/checks`: the two reference pages an agent needs to
 * know the file format's rules and the check codes, served as MCP resources so a client can read them
 * without the docs site or a clone of this repository.
 *
 * `packages/mcp/spec/file-format.md` and `packages/mcp/spec/checks.md` are byte-for-byte copies of the
 * public docs pages `site/docs/file-format.md` and `site/docs/checks-and-findings.md`, kept next to
 * the package's own source (not symlinked, for a clean Windows checkout and a clean npm publish) so
 * they ship with the published `@horizon36596/zenith-mcp` package. `specCopies.test.ts` fails when
 * they drift; re-copy them when the pages change.
 */
const specDir = join(dirname(fileURLToPath(import.meta.url)), "../spec");

function readSpec(file: string): string {
  return readFileSync(join(specDir, file), "utf8");
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    "file-format",
    "zenith://spec/file-format",
    {
      title: "Zenith file format",
      description:
        "The file format reference: the five file kinds, canonical form, and every field of " +
        "*.auto.json — step kinds, segments, heading modes, markers.",
      mimeType: "text/markdown",
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: readSpec("file-format.md") }],
    }),
  );

  server.registerResource(
    "checks",
    "zenith://spec/checks",
    {
      title: "Zenith checks and findings",
      description:
        "The checks and findings reference: every finding code zenith.validate can raise, with " +
        "what causes it and how to fix it.",
      mimeType: "text/markdown",
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: readSpec("checks.md") }],
    }),
  );
}
