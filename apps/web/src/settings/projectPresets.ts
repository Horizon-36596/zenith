/**
 * Project presets (issue #484):
 * presets a team keeps in its project, `<autosDir>/presets/*.zenith-preset.json`, so one programmer's
 * setup reaches every teammate who opens the project. Each file is a preset file (section 6.4) and is
 * read with the same checks as an import. Pure: no DOM, no storage and no backend here; the
 * store reads and writes the files (`projectPresetStore.ts`), and the folder's name and paths are in
 * `project/presetPaths.ts`.
 */
import type { KeyContext } from "../app/keymap";
import type { ProjectSource } from "../project/types";
import { isPresetFileName } from "../project/presetPaths";
import { readPresetFile, type PresetFilePreset, type PresetImportReport } from "./presetFile";
import { sameValue, type UserPreset } from "./presets";

/** The most preset files read from one project. SET BY HAND (spec 15 section 6.5): as many as a person keeps of their own. */
export const MAX_PROJECT_PRESETS = 20;

/** One preset the project holds. */
export interface ProjectPreset {
  /** The file's bare name in the presets folder, which links a person's copy to it. */
  file: string;
  preset: PresetFilePreset;
  report: PresetImportReport;
}

/** What reading a project's presets found. */
export interface ProjectPresetList {
  presets: ProjectPreset[];
  /** Files that could not be read, with the reason, in name order. */
  problems: { file: string; reason: string }[];
  /** How many preset files were past the 20 read. */
  more: number;
}

export const NO_PROJECT_PRESETS: ProjectPresetList = { presets: [], problems: [], more: 0 };

/**
 * The project's presets from its files' names and a way to read each one: in name order, at most 20
 * read, each as an import reads a file. Two files with one name read as "Name" and "Name (2)". A
 * file that cannot be read, or is not a preset file, is a problem and the rest are kept.
 */
export async function readProjectPresets(
  files: readonly string[],
  read: (file: string) => Promise<string>,
  context: KeyContext,
): Promise<ProjectPresetList> {
  const names = files.filter(isPresetFileName).sort((a, b) => a.localeCompare(b));
  const list: ProjectPresetList = { presets: [], problems: [], more: Math.max(0, names.length - MAX_PROJECT_PRESETS) };
  for (const file of names.slice(0, MAX_PROJECT_PRESETS)) {
    let text: string;
    try {
      text = await read(file);
    } catch (error) {
      list.problems.push({ file, reason: `It could not be read: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const taken = list.presets.map((one) => one.preset);
    // The row is labelled with the file, so its reason starts "The file"; a project file is fixed in git.
    const result = readPresetFile(text, taken, { context, next: "Fix it, or restore it from git." });
    if (result.ok) list.presets.push({ file, preset: result.preset, report: result.report });
    else list.problems.push({ file, reason: result.reason });
  }
  return list;
}

/** The person's copy of the project's preset `file`, if they applied or added it before. */
export const linkedCopy = (presets: readonly UserPreset[], project: string, file: string): UserPreset | undefined =>
  presets.find((one) => one.fromProject?.project === project && one.fromProject.file === file);

/** Whether a copy sets exactly what the file does: its base, description, settings and keys. Its name may differ. */
export const matchesFile = (copy: UserPreset, file: PresetFilePreset): boolean =>
  copy.basedOn === file.basedOn &&
  copy.description === file.description &&
  sameValue(copy.settings, file.settings) &&
  sameValue(copy.keys ?? null, file.keys ?? null);

/**
 * Why Add to project cannot write into this project, or null when it can. `canWrite` says whether
 * its backend can write a preset file at all (an older desktop build cannot).
 */
export function projectPresetsReadOnlyReason(source: ProjectSource, canWrite: boolean): string | null {
  switch (source.kind) {
    case "example":
      return "The example project is read only. Open your own robot project to add presets to it.";
    case "files":
      return "These files were opened one at a time, so Zenith cannot add a file to the project. Open the project folder instead.";
    case "github":
      return "Zenith commits only autos and waypoints to GitHub. Export the preset and commit it to the project's presets folder.";
    case "host":
      return "The app that opened this auto owns its project, so Zenith cannot add a file to it.";
    case "directory":
    case "desktop":
      return canWrite ? null : "This version of the desktop app cannot add presets to a project. Update it, or Export the preset and copy it in.";
  }
}
