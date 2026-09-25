/**
 * Test fixtures: a throwaway copy of examples/starter, which is a complete robot repository as
 * `zenith.json` describes one, so every handler runs against real files without touching the
 * repository's own copy.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXAMPLE = fileURLToPath(new URL("../../../examples/starter", import.meta.url));

export function exampleProject(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "zenith-desktop-"));
  cpSync(EXAMPLE, root, { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Rewrites part of the copy's zenith.json. */
export function patchLink(root: string, patch: (link: Record<string, unknown>) => void): void {
  const path = join(root, "zenith.json");
  const link = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  patch(link);
  writeFileSync(path, `${JSON.stringify(link, null, 2)}\n`, "utf8");
}

/** Rewrites part of one auto in the copy. */
export function patchAuto(root: string, fileName: string, patch: (auto: Record<string, unknown>) => void): void {
  const path = join(root, "autos", fileName);
  const auto = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  patch(auto);
  writeFileSync(path, `${JSON.stringify(auto, null, 2)}\n`, "utf8");
}

/**
 * A small project whose one auto has no validation errors, from the CLI's own test fixture, so
 * the pull request tests do not depend on the example autos staying clean.
 */
export async function cleanProject(): Promise<{ root: string; cleanup: () => void }> {
  const { makeProject, simpleAuto } = await import("../../../packages/cli/src/testSupport.js");
  const root = mkdtempSync(join(tmpdir(), "zenith-desktop-clean-"));
  makeProject(root);
  writeFileSync(join(root, "autos", "demo.auto.json"), `${JSON.stringify(simpleAuto("demo"), null, 2)}\n`, "utf8");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
