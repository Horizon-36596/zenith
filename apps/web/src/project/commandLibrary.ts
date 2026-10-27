/**
 * Setting a project's command library in its `zenith.json` (issue #97): the one key the Settings
 * window writes in that file. The desktop app's main process does the same in
 * `apps/desktop/src/main/project.ts`, from a library name and never from file text, because
 * `zenith.json` also holds `sim.command`, which it runs.
 */
import { canonicalize, loadLink } from "@horizon36596/zenith-core";

export type CommandLibrary = "solverslib" | "ivy";

/** Both libraries, in the order the docs list them. Neither is a default. */
export const COMMAND_LIBRARIES: readonly CommandLibrary[] = ["solverslib", "ivy"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `text`, a `zenith.json` as it is on disk now, with `deploy.commandLibrary` set to `library` and
 * nothing else changed, in canonical form. Keys the schema does not name are kept.
 * @throws Error when the text does not load or has no `deploy` section to hold the key
 */
export function linkTextWithCommandLibrary(text: string, library: CommandLibrary): string {
  if (!COMMAND_LIBRARIES.includes(library)) throw new Error("The command library must be SolversLib or Ivy.");
  const raw: unknown = JSON.parse(text);
  loadLink(raw);
  if (!isRecord(raw) || !isRecord(raw["deploy"])) {
    throw new Error("zenith.json has no deploy section, so it names no command library.");
  }
  const next = { ...raw, deploy: { ...raw["deploy"], commandLibrary: library } };
  loadLink(next);
  return canonicalize("link", next);
}
