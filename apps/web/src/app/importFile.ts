/**
 * What "Import from another planner" does with a file once it has the bytes, apart from the file
 * picker and the store: tell a Pedro Visualizer `.pp` project from an interchange `path.json` or
 * `trajectory.json`, run the matching importer from `@horizon36596/zenith-import` against the
 * project's field, and name the new auto so it does not take the name of one already in the
 * project. A `trajectory.json` becomes an auto too (`importTrajectoryAsAuto`), so a team that
 * paths on the fly or plans in RoadRunner can save it to the library and share it like any other
 * auto (spec 13 section 11).
 *
 * DOM-free, so it runs in the node test environment beside the importers it calls.
 */
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import {
  assumedAllianceWarning,
  ImportError,
  importPath,
  importPedroProject,
  importTrajectoryAsAuto,
  interchangeKindOf,
  type ImportIssue,
} from "@horizon36596/zenith-import";
import { detectKind, type Auto, type Field } from "@horizon36596/zenith-schema";
import { newerFormatMessage, newerFormatVersion, unreadableJsonMessage } from "../project/fileErrors";

type Alliance = "RED" | "BLUE";

/** What the import is told beyond the file itself. */
export interface ImportChoices {
  /** The alliance a `.pp` project was drawn for. Unset, it is the field's canonical alliance. */
  alliance?: Alliance;
}

/** The other alliance. */
export const otherAlliance = (alliance: Alliance): Alliance => (alliance === "RED" ? "BLUE" : "RED");

/**
 * The editor's sentence for a `.pp` project imported with no alliance chosen, in place of the
 * importer's, which tells a command-line user to pass one.
 */
export const assumedAllianceNotice = (alliance: Alliance): string =>
  `A .pp file does not say which alliance it is for, so the auto was written for ${alliance}. If the path was drawn for ${otherAlliance(alliance)}, click Import for ${otherAlliance(alliance)} on this notice.`;

/** The file kinds the editor imports as an auto. */
export type ImportSource = "pedro" | "path" | "trajectory";

/**
 * What the file picker offers: `.pp` projects and JSON files (a `path.json`, a `trajectory.json`,
 * or a `.pp` saved as `.json`).
 */
export const IMPORT_ACCEPT = ".pp,.json,application/json";

/**
 * The largest file the import reads, in bytes: 16 MB. SET BY HAND, for spec 13 section 13 ("size
 * caps before and after decompression; the same for imports"). The largest file an importer
 * accepts is a `trajectory.json` at its own cap of 300,000 pose rows, about 11 MB the way the
 * MeepMeep exporter writes a row (about 36 bytes); 16 MB leaves room for other layouts, and a `.pp`
 * project with an embedded field image is a few MB. Anything larger is refused before it is read.
 */
export const MAX_IMPORT_BYTES = 16_000_000;

/** The sentence a file over `MAX_IMPORT_BYTES` is refused with. */
export function tooLargeMessage(fileName: string, bytes: number): string {
  const mb = (value: number): string => `${(value / 1_000_000).toFixed(1)} MB`;
  return `${fileName} is ${mb(bytes)}, larger than the ${mb(MAX_IMPORT_BYTES)} an import may be, so it was not read. A .pp project, a path.json or a trajectory.json is far smaller; check that this is the file you meant.`;
}

export interface ImportedAuto {
  ok: true;
  source: ImportSource;
  /** The file name the new auto will be saved as, in the project's autos directory. */
  fileName: string;
  /** The auto as the editor holds it: already through the canonical writer's rounding. */
  auto: Auto;
  /** Full sentences from the importer: what was changed, approximated or left out. */
  warnings: string[];
  /**
   * For a `.pp` project imported with no alliance chosen: the alliance the auto was written for,
   * since the format records none. The import notice then offers to import it for the other one.
   */
  assumedAlliance?: Alliance;
}

export interface ImportRefused {
  ok: false;
  /** One sentence saying why the file was not imported. */
  message: string;
  /** Each wrong field by its JSON path, when the importer could name them. */
  issues: ImportIssue[];
}

export type ImportOutcome = ImportedAuto | ImportRefused;

/** The auto name a file suggests: the letters, digits, dots, dashes and underscores of its stem. */
export function autoNameFromFile(fileName: string): string {
  const stem = fileName.replace(/\.(pp|json)$/i, "").replace(/\.(path|trajectory|auto)$/i, "");
  const cleaned = stem.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "imported" : cleaned;
}

/** `name`, or `name-2`, `name-3` and so on: the first whose `.auto.json` the project does not have yet. */
export function freeAutoName(name: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has(`${name}.auto.json`)) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name}-${String(n)}`;
    if (!taken.has(`${candidate}.auto.json`)) return candidate;
  }
}

/** Which importer a file needs, or null when it is no kind the editor imports. */
function sourceOf(fileName: string, doc: unknown): ImportSource | null {
  if (/\.pp$/i.test(fileName)) return "pedro";
  const kind = interchangeKindOf(doc);
  if (kind !== null) return kind;
  if (typeof doc === "object" && doc !== null && !Array.isArray(doc)) {
    const record = doc as Record<string, unknown>;
    if (Array.isArray(record["lines"]) || "startPoint" in record) return "pedro";
  }
  return null;
}

/** What to do about a planner file that is not readable JSON (UI_GUIDE section 9.19). */
const IMPORT_AGAIN = "Check that this is the file you meant, or export it again from that planner.";

/** What Import reads, for the sentence about a file it does not. */
const IMPORT_READS = "Import from another planner reads a Pedro Visualizer project (.pp), a path.json or a trajectory.json.";

/**
 * Why a JSON file is no kind the import reads, as one sentence and what to do. A Zenith file is
 * named for what it is and sent where it opens: an auto (one from a newer Zenith says to update),
 * a share file to the Partners panel, a proposal to Open proposal.
 */
function notImportableMessage(fileName: string, doc: unknown): string {
  const kind = detectKind(doc);
  if (kind === "auto") {
    const newer = newerFormatVersion("auto", doc);
    if (newer !== null) return newerFormatMessage(fileName, "auto", newer);
    return `${fileName} is a Zenith auto, not a file from another planner. Copy it into your project's autos folder, or open its own project with Open project.`;
  }
  if (kind === "projection") return `${fileName} is a share file, not a file from another planner. Load it in the Partners panel.`;
  if (kind === "proposal") return `${fileName} is a proposal, not a file from another planner. Open it with Open proposal.`;
  if (kind !== null) return `${fileName} is a Zenith ${kind === "link" ? "zenith.json" : `${kind} file`}, not a file from another planner. ${IMPORT_READS}`;
  return `${fileName} is not a file Import reads. ${IMPORT_READS}`;
}

/**
 * Imports one file's text as a new auto for the project whose field is `field` and whose autos are
 * `existing` (file names). Never throws for a bad file: a refusal carries the reason and, when the
 * importer named them, every wrong field.
 */
export function importAutoFile(
  fileName: string,
  text: string,
  field: Field,
  existing: readonly string[],
  choices: ImportChoices = {},
): ImportOutcome {
  // The caller refuses a file over the cap by its size before reading it. This catches text handed
  // in directly: a string is never longer than its UTF-8 size, so a text this long is over the cap.
  if (text.length > MAX_IMPORT_BYTES) return { ok: false, message: tooLargeMessage(fileName, text.length), issues: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(text) as unknown;
  } catch (error) {
    return { ok: false, message: unreadableJsonMessage(fileName, text, error, IMPORT_AGAIN), issues: [] };
  }
  const source = sourceOf(fileName, doc);
  if (source === null) return { ok: false, message: notImportableMessage(fileName, doc), issues: [] };
  const name = freeAutoName(autoNameFromFile(fileName), existing);
  try {
    let result: { auto: Auto; warnings: string[] };
    const warnings: string[] = [];
    let assumedAlliance: Alliance | undefined;
    if (source === "pedro") {
      const pedro = importPedroProject(doc, field, choices.alliance === undefined ? { name } : { name, alliance: choices.alliance });
      result = pedro;
      assumedAlliance = pedro.assumedAlliance;
      for (const warning of pedro.warnings) {
        warnings.push(
          assumedAlliance !== undefined && warning === assumedAllianceWarning(assumedAlliance)
            ? assumedAllianceNotice(assumedAlliance)
            : warning,
        );
      }
      if (pedro.robotFootprint !== undefined) {
        warnings.push(
          `The file gives the robot's size as ${String(pedro.robotFootprint.lengthIn)} in long and ${String(pedro.robotFootprint.widthIn)} in wide; robot.json was not changed.`,
        );
      }
    } else if (source === "trajectory") {
      // The size and the timing sentences come from the importer itself.
      result = importTrajectoryAsAuto(doc, field, { name });
      warnings.push(...result.warnings);
    } else {
      result = importPath(doc, field, { name });
      warnings.push(...result.warnings);
    }
    // Through the canonical writer and back, so the editor holds exactly what Save will write.
    const auto = loadAuto(JSON.parse(canonicalize("auto", result.auto)) as unknown);
    const imported: ImportedAuto = { ok: true, source, fileName: `${name}.auto.json`, auto, warnings };
    if (assumedAlliance !== undefined) imported.assumedAlliance = assumedAlliance;
    return imported;
  } catch (error) {
    if (error instanceof ImportError) {
      return { ok: false, message: `${fileName} could not be imported.`, issues: [...error.issues] };
    }
    return { ok: false, message: `${fileName} could not be imported: ${error instanceof Error ? error.message : String(error)}`, issues: [] };
  }
}
