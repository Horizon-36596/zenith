/**
 * Where a project keeps its presets:
 * `<autosDir>/presets/*.zenith-preset.json`. Names and paths only, with no imports, so the project
 * backends and Settings share them without either loading the other.
 */

/** What every preset file's name ends with, exported or in a project. */
export const PRESET_FILE_SUFFIX = ".zenith-preset.json";

/** The folder inside `autosDir` that holds a project's presets. */
export const PROJECT_PRESETS_DIR = "presets";

/** `autos/presets`: where the project's presets are, from the root, with `/` separators. */
export function projectPresetsDir(link: { autosDir: string }): string {
  const autos = link.autosDir
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  return autos === "" ? PROJECT_PRESETS_DIR : `${autos}/${PROJECT_PRESETS_DIR}`;
}

/** `autos/presets/Drive team.zenith-preset.json` for the file `Drive team.zenith-preset.json`. */
export const projectPresetPath = (link: { autosDir: string }, file: string): string => `${projectPresetsDir(link)}/${file}`;

/**
 * Whether `name` is a bare preset file name a project may hold: `*.zenith-preset.json`, not hidden,
 * with no path separator in it.
 */
export const isPresetFileName = (name: string): boolean =>
  name.endsWith(PRESET_FILE_SUFFIX) &&
  name.length > PRESET_FILE_SUFFIX.length &&
  !name.startsWith(".") &&
  !name.includes("/") &&
  !name.includes("\\");
