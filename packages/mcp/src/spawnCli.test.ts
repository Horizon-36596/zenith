import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveCliEntry } from "./spawnCli.js";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  dependencies?: Record<string, string>;
};

describe("the CLI the MCP server shells out to", () => {
  it("is a declared dependency, so npx -y @horizon36596/zenith-mcp installs it too", () => {
    expect(manifest.dependencies?.["@horizon36596/zenith-cli"]).toBe("workspace:*");
  });

  it("resolves from this package to the CLI's built entry point", () => {
    expect(resolveCliEntry().split("\\").join("/")).toMatch(/cli\/dist\/index\.js$/);
  });
});
