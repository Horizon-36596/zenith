/**
 * Where partner projections come from. Today that is a file the user picks or drops, and the
 * bundled example partner; later the team library's received shares will be one more source
 * (spec 13 section 9, "Add to alliance view"). The alliance view only ever
 * sees `PartnerSource`, so adding the cloud is a new implementation of it and nothing else.
 *
 * Every file goes through the schema's one validator, `parseProjection`, which is strict: a
 * projection is somebody else's file, so an unknown key or an oversized list is refused, never
 * dropped (section 13).
 */
import { ImportError, interchangeKindOf, readTrajectory } from "@horizon36596/zenith-import";
import { detectKind, parseProjection, SchemaError, SCHEMA_ID, type Field, type Kind, type Projection } from "@horizon36596/zenith-schema";
import { MAX_IMPORT_BYTES } from "../app/importFile";
import type { PartnerShare } from "../cloud/partnerShare";
import { megabytes, newerFormatMessage, newerFormatVersion, tooLargeFileMessage, unreadableJsonMessage } from "../project/fileErrors";
import exampleText from "../../../../examples/starter/partners/starter-partner.projection.json?raw";

/**
 * One projection a source handed over, or why the file it named could not be read. The reason is
 * a whole sentence that names the file and ends with what to do, so the status line shows it alone.
 */
export type PartnerLoad =
  | { ok: true; fileName: string; projection: Projection; share?: PartnerShare }
  | { ok: false; fileName: string; reason: string };

/** Something that can hand the alliance view partner projections. */
export interface PartnerSource {
  /** What the source is, in words, for a status line: "the files you picked". */
  readonly description: string;
  load(): Promise<PartnerLoad[]>;
}

/**
 * The largest projection file read, in bytes. A projection's own caps (3000 poses, 200 phases and
 * so on) fit well inside it; anything larger is refused before it is parsed (section 13, "size caps
 * before and after decompression").
 */
export const MAX_PROJECTION_BYTES = 2_000_000;

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/**
 * How a share file's sentences name it and what they tell the person to do (UI_GUIDE section 9.19).
 * A file the person picked is named by its file name, and its partner sends it again; a share from
 * the cloud is named by the team that shared it.
 */
export interface ShareWords {
  /** The sentence's subject: "partner.projection.json", or "The auto shared by Team 12345". */
  subject: string;
  /** What to do about a damaged or unreadable share. */
  again: string;
}

/** The words for a share file the person picked or dropped. */
export const shareFileWords = (fileName: string): ShareWords => ({
  subject: baseName(fileName),
  again: "Ask your partner to download it again.",
});

/** Where a share file comes from, for a file that is some other kind. */
const WHERE_SHARES_COME_FROM = "Ask your partner for the file Download share file makes in their Zenith.";

/** Each other Zenith file, as a sentence names it. */
const KIND_WORDS: Readonly<Record<Exclude<Kind, "projection">, string>> = {
  auto: "a Zenith auto",
  robot: "a Zenith robot file",
  field: "a Zenith field file",
  waypoints: "a Zenith waypoints file",
  link: "a project's zenith.json",
  proposal: "a proposal",
};

/**
 * The sentence for a file that is some other kind of file, such as a `robot.json` (the 0.1.2 UX
 * sweep, W3-6), or JSON Zenith did not write at all. It names what the file is when Zenith can
 * tell, and where a share file comes from.
 */
export const notShareReason = (fileName: string, kind: Kind | null = null): string => notShareSentence(baseName(fileName), kind);

function notShareSentence(subject: string, kind: Kind | null): string {
  const what = kind === null || kind === "projection" ? "is not a share file Zenith wrote" : `is ${KIND_WORDS[kind]}, not a share file`;
  return `${subject} ${what}. ${WHERE_SHARES_COME_FROM}`;
}

/** One refused value, by where it is: "the value at trajectory.poses.3", or what is extra. */
function refusedValueWords(issue: SchemaError["issues"][number]): string {
  if (issue.code === "unrecognized_keys") return `it holds ${issue.keys.join(", ")}, which a share file does not have`;
  return issue.path.length === 0 ? "Zenith cannot read it" : `Zenith cannot read the value at ${issue.path.join(".")}`;
}

/**
 * The share in `json`, or why it did not load as one, as one sentence that starts with
 * `words.subject`. The schema's own words never appear: the person did not write the file and
 * cannot fix it, so the sentence says where the damage is and to ask for it again.
 */
function readShare(json: unknown, words: ShareWords): { projection: Projection } | { reason: string } {
  const kind = detectKind(json);
  if (kind !== "projection") return { reason: notShareSentence(words.subject, kind) };
  const newer = newerFormatVersion("projection", json);
  if (newer !== null) return { reason: newerFormatMessage(words.subject, "projection", newer, "share file", "load") };
  try {
    return { projection: parseProjection(json) };
  } catch (error) {
    if (error instanceof SchemaError && error.issues.length > 0) {
      const more = error.issues.length - 1;
      const first = refusedValueWords(error.issues[0] as SchemaError["issues"][number]);
      const rest = more === 0 ? "" : ` (and ${String(more)} more value${more === 1 ? "" : "s"})`;
      return { reason: `${words.subject} is a damaged share file: ${first}${rest}. ${words.again}` };
    }
    return { reason: `${words.subject} is a damaged share file, so Zenith cannot read it. ${words.again}` };
  }
}

/**
 * A projection from its text, checked by the schema. Every refusal is one sentence that names the
 * file, says what is wrong in plain words and ends with what to do: too large, not JSON (empty,
 * cut off, a picture), some other kind of file, from a newer Zenith, or damaged.
 */
export function readPartnerText(fileName: string, text: string, words: ShareWords = shareFileWords(fileName)): PartnerLoad {
  if (text.length > MAX_PROJECTION_BYTES) {
    return {
      ok: false,
      fileName,
      reason: tooLargeFileMessage(words.subject, text.length, MAX_PROJECTION_BYTES, "a share file", "Check that this is the file you meant."),
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, fileName, reason: unreadableJsonMessage(words.subject, text, error, words.again) };
  }
  const read = readShare(json, words);
  return "reason" in read ? { ok: false, fileName, reason: read.reason } : { ok: true, fileName, projection: read.projection };
}

/**
 * The sentence for a picked file over `MAX_IMPORT_BYTES`, the cap for a trajectory.json, which is
 * larger than any share file may be.
 */
export const partnerTooLargeReason = (fileName: string, bytes: number): string =>
  `${baseName(fileName)} is ${megabytes(bytes)}, so it was not read. A share file may be ${megabytes(MAX_PROJECTION_BYTES)} at most and a trajectory.json ${megabytes(MAX_IMPORT_BYTES)}. Check that this is the file you meant.`;

/**
 * A partner file the user picked: a projection, or an interchange `trajectory.json` from a team that
 * paths on the fly or plans in RoadRunner (spec 13 section 11). A trajectory is read against
 * `field`, the open auto's field, by the same importer `zenith import` uses (`readTrajectory`: the
 * season's frame, 10 Hz, 0.5 in and one degree), and the view projection it makes goes through
 * `parseProjection` like any other, so it is trusted no more than a projection file. Only files
 * the user picked come here; a share from the cloud is always a projection (`readPartnerText`).
 *
 * A trajectory may be larger than a projection (its own rate can be up to 1000 Hz), so it is held
 * to the import's size cap instead of `MAX_PROJECTION_BYTES`.
 */
export function readPartnerFile(fileName: string, text: string, field: Field | null): PartnerLoad {
  if (text.length > MAX_IMPORT_BYTES) return { ok: false, fileName, reason: partnerTooLargeReason(fileName, text.length) };
  const words = shareFileWords(fileName);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, fileName, reason: unreadableJsonMessage(words.subject, text, error, words.again) };
  }
  if (interchangeKindOf(json) !== "trajectory") return readPartnerText(fileName, text, words);
  if (field === null) {
    return { ok: false, fileName, reason: `${words.subject} is a trajectory.json, which is read against the open auto's field. Open an auto first.` };
  }
  const again = "Check the file, or export it again from the planner that wrote it.";
  try {
    const { projection } = readTrajectory(json, field);
    return { ok: true, fileName, projection: parseProjection({ $schema: SCHEMA_ID.projection, ...projection }) };
  } catch (error) {
    const first = error instanceof ImportError ? error.issues[0] : undefined;
    if (first !== undefined) {
      const where = first.path === "" ? "" : ` at ${first.path}`;
      const what = first.message.replace(/\.$/, "");
      return { ok: false, fileName, reason: `${words.subject} has a value Zenith cannot read${where}: ${what.charAt(0).toLowerCase()}${what.slice(1)}. ${again}` };
    }
    return { ok: false, fileName, reason: `${words.subject} is a trajectory.json Zenith cannot read. ${again}` };
  }
}

/** The part of a browser `File` a source reads, so tests can hand in plain objects. */
export interface PartnerFileLike {
  name: string;
  size: number;
  text(): Promise<string>;
}

/**
 * Files the user picked with the file picker or dropped on the Partners panel: projections, or
 * `trajectory.json` files read against `field` (`readPartnerFile`). Without a field, a trajectory
 * is refused with the reason and a projection loads as before.
 */
export function fileSource(files: readonly PartnerFileLike[], field: Field | null = null): PartnerSource {
  return {
    description: files.length === 1 ? "the file you chose" : "the files you chose",
    async load() {
      const loads: PartnerLoad[] = [];
      for (const file of files) {
        if (file.size > MAX_IMPORT_BYTES) {
          loads.push({ ok: false, fileName: file.name, reason: partnerTooLargeReason(file.name, file.size) });
          continue;
        }
        loads.push(readPartnerFile(file.name, await file.text(), field));
      }
      return loads;
    },
  };
}

/** The file name the bundled example partner is shown with. */
export const EXAMPLE_PARTNER_FILE = "partners/starter-partner.projection.json";

/**
 * The example partner bundled with `examples/starter`: the starter's first auto shared as a view
 * projection from a different start tile (`partnerFixture.test.ts` builds it with `projectShare`).
 */
export const exampleSource: PartnerSource = {
  description: "the example partner",
  load: () => Promise.resolve([readPartnerText(EXAMPLE_PARTNER_FILE, exampleText)]),
};
