/**
 * Setting the command library from the Settings window (issue #97). `zenith.json` also holds
 * `sim.command`, which the main process runs for High-fidelity sim, so the renderer may only name
 * one of two libraries: the main process reads the file from disk, changes `deploy.commandLibrary`
 * and nothing else, and refuses every other value, file text included.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCommandLibrary } from "../src/main/project.js";
import { CHANNELS } from "../src/shared/channels.js";
import { exampleProject, patchLink } from "./support.js";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function project(): string {
  const made = exampleProject();
  cleanup = made.cleanup;
  return made.root;
}

const linkOf = (root: string): string => readFileSync(join(root, "zenith.json"), "utf8");

describe("setting the command library", () => {
  it("changes only deploy.commandLibrary, leaving sim.command the same to the byte", () => {
    const root = project();
    const before = linkOf(root).replace(/\r\n/g, "\n");
    const note = vi.fn();
    const written = setCommandLibrary(root, "ivy", note);
    const after = linkOf(root);
    expect(after).toBe(written);
    expect(note).toHaveBeenCalledWith(written);
    const changed = after.split("\n").filter((line, index) => line !== before.split("\n")[index]);
    expect(changed).toEqual([`    "commandLibrary": "ivy",`]);
    const simLine = (text: string) => text.split("\n").find((line) => line.includes('"command":'));
    expect(simLine(after)).toBe(simLine(before));
    expect(simLine(after)).toContain("./gradlew :TeamCode:testDebugUnitTest");
    // Back again, the file is what it was.
    setCommandLibrary(root, "solverslib");
    expect(linkOf(root)).toBe(before);
    // Nothing is left beside it from the atomic write.
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses any value but the two libraries, file text included, and writes nothing", () => {
    const root = project();
    const before = linkOf(root);
    const hostile = before.replace(/"command": "[^"\n]*(\\"[^"\n]*)*"/, '"command": "calc.exe"');
    for (const value of ["roadrunner", "IVY", "", hostile, `${before}`, { library: "ivy" }, ["ivy"], null, undefined, 1]) {
      expect(() => setCommandLibrary(root, value)).toThrow(/SolversLib or Ivy/);
    }
    expect(linkOf(root)).toBe(before);
  });

  it("keeps a team's own edits on disk and refuses a zenith.json with no deploy section", () => {
    const root = project();
    patchLink(root, (link) => {
      (link["sim"] as Record<string, unknown>)["command"] = "gradlew.bat test --tests Mine";
    });
    setCommandLibrary(root, "ivy");
    const after = JSON.parse(linkOf(root)) as { sim: { command: string }; deploy: { commandLibrary: string } };
    expect(after.sim.command).toBe("gradlew.bat test --tests Mine");
    expect(after.deploy.commandLibrary).toBe("ivy");

    patchLink(root, (link) => {
      delete link["deploy"];
    });
    const without = linkOf(root);
    expect(() => setCommandLibrary(root, "ivy")).toThrow(/no deploy section/);
    expect(linkOf(root)).toBe(without);
  });

  it("offers no channel that writes zenith.json from text", () => {
    expect(Object.values(CHANNELS)).toContain("zenith:project-set-command-library");
    expect(Object.keys(CHANNELS).some((name) => /link/i.test(name))).toBe(false);
  });
});
