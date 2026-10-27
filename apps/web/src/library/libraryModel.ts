/**
 * The team library as the Library panel shows it (spec 13 section 5), with
 * no React in it so it is tested in node against `MemoryBackend`.
 *
 * A local auto maps to a library auto by its file name, which is the library auto's title. This
 * device remembers which revision each local auto was last published or opened as: that is the base
 * of the next publish, so two members who publish from the same revision make a diverged pair
 * instead of one overwriting the other (section 5.3).
 */
import { canonicalize, loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import type { AutoRecord, Member, Revision } from "@horizon36596/zenith-cloud";
import type { Project } from "../project/types";
import { KEYS, type DeviceStorage } from "../account/storage";
import type { ZipEntry } from "./zip";

/** One revision as a Library row shows it. */
export interface RevisionRow {
  id: string;
  n: number;
  authorName: string;
  createdAt: Date;
  /** The first 7 characters of the git commit, when the project was a git repository. */
  gitSha: string | null;
  diverged: boolean;
  baseRevision: string | null;
  /** The number of the revision this one was published from, or null for a first revision. */
  baseN: number | null;
  /** The newest revision: the highest number, and the latest of any diverged siblings on it. */
  latest: boolean;
  /** This device's base for the matching local auto. */
  isBase: boolean;
}

/** The library auto whose title is this file name, if the team has one. */
export const findLibraryAuto = (autos: readonly AutoRecord[], fileName: string): AutoRecord | undefined =>
  autos.find((auto) => auto.title === fileName);

/** The newest revision, or null. */
export function latestRevision(revisions: readonly Revision[]): Revision | null {
  let best: Revision | null = null;
  for (const revision of revisions) {
    if (
      best === null ||
      revision.n > best.n ||
      (revision.n === best.n && revision.createdAt.getTime() > best.createdAt.getTime())
    ) {
      best = revision;
    }
  }
  return best;
}

const baseKey = (teamId: string, autoId: string): string => `${KEYS.basePrefix}${teamId}.${autoId}`;

export function rememberedBase(storage: DeviceStorage, teamId: string, autoId: string): string | null {
  return storage.get(baseKey(teamId, autoId));
}

export function rememberBase(storage: DeviceStorage, teamId: string, autoId: string, revisionId: string): void {
  storage.set(baseKey(teamId, autoId), revisionId);
}

/**
 * The base of the next publish: the revision this device last published or opened, while the library
 * still has it; otherwise the newest revision, for a device that never linked this auto; otherwise
 * none, for the first revision.
 */
export function chooseBase(remembered: string | null, revisions: readonly Revision[]): string | null {
  if (remembered !== null && revisions.some((revision) => revision.id === remembered)) return remembered;
  return latestRevision(revisions)?.id ?? null;
}

/** The rows of one auto's history, newest first. `members` supplies the authors' display names. */
export function revisionRows(
  revisions: readonly Revision[],
  members: readonly Member[],
  base: string | null,
): RevisionRow[] {
  const names = new Map(members.map((member) => [member.uid, member.displayName]));
  const numbers = new Map(revisions.map((revision) => [revision.id, revision.n]));
  const latest = latestRevision(revisions);
  return [...revisions]
    .sort((a, b) => b.n - a.n || b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
    .map((revision) => ({
      id: revision.id,
      n: revision.n,
      authorName: names.get(revision.author) ?? "A former member",
      createdAt: revision.createdAt,
      gitSha: revision.gitSha === undefined ? null : revision.gitSha.slice(0, 7),
      diverged: revision.diverged,
      baseRevision: revision.baseRevision,
      // Revisions are never deleted, so a base is always listed; `n - 1` covers a history read in part.
      baseN: revision.baseRevision === null ? null : (numbers.get(revision.baseRevision) ?? revision.n - 1),
      latest: latest !== null && revision.id === latest.id,
      isBase: revision.id === base,
    }));
}

/** The revisions that share a base with `revisionId`, other than itself: what it diverged from. */
export function siblingsOf(revisions: readonly Revision[], revisionId: string): Revision[] {
  const target = revisions.find((revision) => revision.id === revisionId);
  if (target === undefined) return [];
  return revisions.filter(
    (revision) =>
      revision.id !== revisionId && revision.baseRevision === target.baseRevision && revision.n === target.n,
  );
}

/**
 * The revisions that make an open divergence: two or more published from the same base as the
 * newest number, oldest first. Empty when the newest number has one revision, which is also what
 * a Keep leaves behind (spec 13 section 5.3). An older diverged pair that someone has since built
 * on is history, not a choice still waiting.
 */
export function openDivergence(revisions: readonly Revision[]): Revision[] {
  const latest = latestRevision(revisions);
  if (latest === null) return [];
  const group = revisions
    .filter((revision) => revision.n === latest.n)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  return group.length > 1 ? group : [];
}

/** Why the open auto cannot be published now, or null. The role check is `permissions.ts`'s. */
export function whyCannotPublishFile(input: {
  fileName: string | null;
  savedCanonical: string | null;
  dirty: boolean;
  reviewing: boolean;
}): string | null {
  if (input.fileName === null || input.savedCanonical === null) return "Open an auto first.";
  if (input.reviewing) return "Leave review mode first.";
  if (input.dirty) return "Save the auto first. Publishing sends the saved file, not unsaved edits.";
  return null;
}

/** The project files a revision is published with, canonical, as the library stores them. */
export function projectTexts(project: Pick<Project, "robot" | "field" | "waypoints"> | null): {
  robot?: string;
  field?: string;
  waypoints?: string;
} {
  if (project === null) return {};
  const out: { robot?: string; field?: string; waypoints?: string } = {
    robot: canonicalize("robot", project.robot),
    field: canonicalize("field", project.field),
  };
  if (project.waypoints !== undefined) out.waypoints = canonicalize("waypoints", project.waypoints);
  return out;
}

/** The field file's name for a field document: `<season id>.field.json` when it has one. */
function fieldFileName(fieldText: string): string {
  try {
    const parsed = JSON.parse(fieldText) as { season?: unknown; id?: unknown; name?: unknown };
    const raw = [parsed.season, parsed.id, parsed.name].find((value) => typeof value === "string") as
      | string
      | undefined;
    const slug = (raw ?? "field")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return `${slug === "" ? "field" : slug}.field.json`;
  } catch {
    return "field.field.json";
  }
}

/**
 * A minimal `zenith.json` for a project that lives only in the library. It names where the files
 * are and nothing else: a team that deploys adds its `deploy` section, as the getting-started guide
 * describes.
 */
export function minimalLink(fieldName: string, withWaypoints: boolean): string {
  const link: Record<string, unknown> = {
    formatVersion: 1,
    autosDir: "autos",
    robot: "autos/robot.json",
    field: `autos/field/${fieldName}`,
  };
  if (withWaypoints) link.waypoints = "autos/waypoints.json";
  return canonicalize("link", loadLink(link));
}

/**
 * The files of Download project: each auto's newest revision, the robot, field and waypoints of the
 * newest revision that carries them, and a minimal `zenith.json`. The zip opens again with the
 * app's Open files.
 */
export function projectZipEntries(latest: ReadonlyArray<{ title: string; revision: Revision }>): ZipEntry[] {
  const newestFirst = [...latest].sort((a, b) => b.revision.createdAt.getTime() - a.revision.createdAt.getTime());
  const robot = newestFirst.find((entry) => entry.revision.robot !== undefined)?.revision.robot;
  const field = newestFirst.find((entry) => entry.revision.field !== undefined)?.revision.field;
  const waypoints = newestFirst.find((entry) => entry.revision.waypoints !== undefined)?.revision.waypoints;
  const entries: ZipEntry[] = [];
  if (robot !== undefined && field !== undefined) {
    const fieldName = fieldFileName(field);
    entries.push({ path: "zenith.json", text: minimalLink(fieldName, waypoints !== undefined) });
    entries.push({ path: "autos/robot.json", text: robot });
    entries.push({ path: `autos/field/${fieldName}`, text: field });
    if (waypoints !== undefined) entries.push({ path: "autos/waypoints.json", text: waypoints });
  }
  for (const entry of [...latest].sort((a, b) => a.title.localeCompare(b.title))) {
    entries.push({ path: `autos/${entry.title}`, text: entry.revision.content });
  }
  return entries;
}

/**
 * A project built from one revision, for Open in project when no project is open: the revision's
 * own robot, field and waypoints. Null when the revision was published without them.
 */
export function projectFromRevision(title: string, revision: Revision): Project | null {
  if (revision.robot === undefined || revision.field === undefined) return null;
  const fieldName = fieldFileName(revision.field);
  return {
    source: { kind: "files" },
    name: "Team library",
    link: loadLink(JSON.parse(minimalLink(fieldName, revision.waypoints !== undefined))),
    robot: loadRobot(JSON.parse(revision.robot)),
    field: loadField(JSON.parse(revision.field)),
    ...(revision.waypoints === undefined ? {} : { waypoints: loadWaypoints(JSON.parse(revision.waypoints)) }),
    autoFiles: [title],
    autoTexts: { [title]: revision.content },
  };
}

/** A revision's auto, parsed, with the canonical text the editor compares unsaved changes against. */
export function autoOfRevision(revision: Revision): { auto: ReturnType<typeof loadAuto>; canonical: string } {
  const auto = loadAuto(JSON.parse(revision.content));
  return { auto, canonical: canonicalize("auto", auto) };
}

/**
 * Where the open auto stands in the team library, for the share dialog (spec 13 section 8.3: a
 * share is made from a published revision, and pinned to it):
 *
 * - `loading` until the library has been read;
 * - `unreadable` when it could not be read, with the sentence saying why;
 * - `unpublished` when the team library has no revision of it;
 * - `changed` when the file differs from the revision this device last published or opened, or has
 *   unsaved edits, so a share would not show what the dialog previews;
 * - `published` with the library auto and the revision a share is made from.
 */
export type LibraryStatus =
  | { kind: "loading" }
  | { kind: "unreadable"; why: string }
  | { kind: "unpublished" }
  | { kind: "changed"; autoId: string; revisionId: string; n: number }
  | { kind: "published"; autoId: string; revisionId: string; n: number };

export function libraryStatusOf(
  library: { loaded: boolean; readError?: string | null; autos: readonly AutoRecord[]; revisions: Readonly<Record<string, Revision[]>> },
  file: { fileName: string | null; savedCanonical: string | null; dirty: boolean },
  base: (autoId: string) => string | null,
): LibraryStatus {
  if (!library.loaded) return library.readError === undefined || library.readError === null ? { kind: "loading" } : { kind: "unreadable", why: library.readError };
  if (file.fileName === null) return { kind: "unpublished" };
  const auto = findLibraryAuto(library.autos, file.fileName);
  if (auto === undefined) return { kind: "unpublished" };
  const revisions = library.revisions[auto.id] ?? [];
  const baseId = base(auto.id);
  const revision = revisions.find((entry) => entry.id === baseId);
  if (revision === undefined) return { kind: "unpublished" };
  const at = { autoId: auto.id, revisionId: revision.id, n: revision.n };
  if (file.dirty || file.savedCanonical !== revision.content) return { kind: "changed", ...at };
  return { kind: "published", ...at };
}
