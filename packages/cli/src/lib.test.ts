import { describe, expect, it } from "vitest";
import * as index from "./index.js";
import * as lib from "./lib.js";

/** The exports the desktop app imports from the CLI package. */
describe("the CLI library entry", () => {
  const names = [
    "confinePath",
    "loadProject",
    "ProjectError",
    "splitShellWords",
    "resolveLauncher",
    "findJava",
    "withRerun",
    "LauncherError",
    "MissingToolError",
    "planDeploy",
    "applyDeploy",
    "AUTO_NAME_PATTERN",
    "loadAutoAndPlan",
    "tryCore",
  ] as const;

  it("exports what the desktop app reuses, and index.ts re-exports the same values", () => {
    for (const name of names) {
      expect(lib[name], name).toBeDefined();
      expect(index[name], name).toBe(lib[name]);
    }
  });

  it("does not run the program when imported", () => {
    expect(typeof index.main).toBe("function");
    expect(process.exitCode).toBeUndefined();
  });
});
