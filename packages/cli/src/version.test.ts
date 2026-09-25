import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildProgram } from "./index.js";
import { VERSION } from "./version.js";

const rootVersion = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8")) as { version: string }
).version;

describe("zenith --version", () => {
  it("reports the release version stamped from the root package.json", () => {
    expect(VERSION).toBe(rootVersion);
    expect(buildProgram().version()).toBe(rootVersion);
  });
});
