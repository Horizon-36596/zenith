/**
 * Two revisions of one library auto, side by side in the review view (spec 13 section 5.3, in the
 * review mode of spec 6 section 4): which one is the user's and which is the other, which is drawn
 * ghosted under the other, the step-by-step diff with what each change does to the time, and what
 * Keep would publish.
 *
 * No React, no store and no network: the one function that publishes, `publishKeep`, acts through
 * the account model it is handed, so the whole choice is tested in node against the in-memory cloud.
 *
 * A **diverged pair** is two revisions published from the same base, so they carry the same number.
 * Neither overwrote the other, and nothing is decided until a person chooses:
 *
 * - **Keep mine** or **Keep theirs** publishes the chosen revision's content as the next revision,
 *   built on the other one. The library then has one newest revision again, and both originals
 *   stay in the history, untouched.
 * - **Open in project** brings either one into the local folder, as Open does on any revision.
 *
 * Two revisions that did not diverge (picked from the list to compare) show the same view with the
 * older one ghosted, and only Open in project.
 */
import type { Member, Revision } from "@horizon36596/zenith-cloud";
import type { Project } from "../project/types";
import type { Field, Robot, Waypoints } from "@horizon36596/zenith-schema";
import { buildReviewModel, type ReviewModel } from "../github/reviewModel";
import { autoOfRevision, latestRevision, projectFromRevision } from "./libraryModel";

/** Whose a side is, as far as this device can tell. */
export type SideOwner = "mine" | "theirs" | "unknown";

export interface ReviewSide {
  revision: Revision;
  n: number;
  authorName: string;
  createdAt: Date;
  owner: SideOwner;
  /** How the view names it at the start of a sentence: "Mine", "Theirs", "Ada's", "Revision 3". */
  name: string;
  /** The same inside a sentence: "mine", "theirs", "Ada's", "revision 3". */
  phrase: string;
  /** The Keep button's words: "Keep mine", "Keep theirs", "Keep Ada's". */
  keepLabel: string;
}

export interface RevisionPair {
  /** True when both were published from the same base: a choice is waiting. */
  diverged: boolean;
  /**
   * The two sides in the order the view lists them. For a diverged pair the user's own comes
   * first when this device can tell which it is; otherwise the older comes first.
   */
  first: ReviewSide;
  second: ReviewSide;
  /** The number of the revision both were published from, for a diverged pair; else null. */
  commonBaseN: number | null;
  /** How many more revisions were published from the same base, beyond these two. */
  moreSiblings: number;
  /**
   * Why Keep is not offered, as a sentence, or null when it is: a pair that did not diverge, or a
   * diverged pair someone has since built on, which is history rather than a choice still waiting.
   */
  whyNoKeep: string | null;
}

const byAge = (a: Revision, b: Revision): number =>
  a.n - b.n || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

/** The revisions published from the same base as `revision`, itself included, oldest first. */
function siblingGroup(revisions: readonly Revision[], revision: Revision): Revision[] {
  return revisions
    .filter((other) => other.n === revision.n && other.baseRevision === revision.baseRevision)
    .sort(byAge);
}

/**
 * Describes two revisions of one auto as the review view shows them.
 *
 * `uid` is the signed-in user and `deviceBase` the revision this device last published or opened
 * (the base of its next publish): the side that is this device's base is "mine", else the one the
 * user wrote when only one of them is. When neither tells them apart, each side is named by its
 * author.
 */
export function describePair(input: {
  revisions: readonly Revision[];
  ids: readonly [string, string];
  members: readonly Member[];
  uid: string | null;
  deviceBase: string | null;
}): RevisionPair | string {
  const { revisions, ids, members, uid, deviceBase } = input;
  const a = revisions.find((revision) => revision.id === ids[0]);
  const b = revisions.find((revision) => revision.id === ids[1]);
  if (a === undefined || b === undefined) return "One of these revisions is no longer in the library.";
  if (a.id === b.id) return "Pick two different revisions to compare.";
  const names = new Map(members.map((member) => [member.uid, member.displayName]));
  const authorOf = (revision: Revision): string => names.get(revision.author) ?? "A former member";
  const [older, newer] = [a, b].sort(byAge) as [Revision, Revision];
  const diverged = older.n === newer.n && older.baseRevision === newer.baseRevision;

  if (!diverged) {
    const side = (revision: Revision): ReviewSide => ({
      revision,
      n: revision.n,
      authorName: authorOf(revision),
      createdAt: revision.createdAt,
      owner: uid !== null && revision.author === uid ? "mine" : "unknown",
      name: `Revision ${String(revision.n)}`,
      phrase: `revision ${String(revision.n)}`,
      keepLabel: `Keep revision ${String(revision.n)}`,
    });
    return {
      diverged: false,
      first: side(older),
      second: side(newer),
      commonBaseN: null,
      moreSiblings: 0,
      whyNoKeep: `These two did not diverge: revision ${String(newer.n)} comes after revision ${String(older.n)} on one line, so there is nothing to choose. Open either one in the project.`,
    };
  }

  // Which one is the user's: this device's base first, then authorship when it tells them apart.
  let mine: Revision | null = null;
  if (deviceBase === a.id || deviceBase === b.id) mine = deviceBase === a.id ? a : b;
  else if (uid !== null && (a.author === uid) !== (b.author === uid)) mine = a.author === uid ? a : b;

  let first: ReviewSide;
  let second: ReviewSide;
  if (mine !== null) {
    const other = mine === a ? b : a;
    const otherIsAlsoMine = uid !== null && other.author === uid;
    first = {
      revision: mine,
      n: mine.n,
      authorName: authorOf(mine),
      createdAt: mine.createdAt,
      owner: "mine",
      name: "Mine",
      phrase: "mine",
      keepLabel: "Keep mine",
    };
    second = {
      revision: other,
      n: other.n,
      authorName: authorOf(other),
      createdAt: other.createdAt,
      owner: otherIsAlsoMine ? "mine" : "theirs",
      name: otherIsAlsoMine ? "The other one" : "Theirs",
      phrase: otherIsAlsoMine ? "the other one" : "theirs",
      keepLabel: otherIsAlsoMine ? "Keep the other one" : "Keep theirs",
    };
  } else {
    const sameName = authorOf(older) === authorOf(newer);
    const named = (revision: Revision, order: "first" | "second"): ReviewSide => {
      const phrase = sameName ? `the ${order} one` : `${authorOf(revision)}'s`;
      const name = `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;
      return {
        revision,
        n: revision.n,
        authorName: authorOf(revision),
        createdAt: revision.createdAt,
        owner: "unknown",
        name,
        phrase,
        keepLabel: `Keep ${phrase}`,
      };
    };
    first = named(older, "first");
    second = named(newer, "second");
  }

  const base = older.baseRevision === null ? null : revisions.find((revision) => revision.id === older.baseRevision);
  const latest = latestRevision(revisions);
  const settled = latest !== null && latest.n > older.n;
  return {
    diverged: true,
    first,
    second,
    commonBaseN: older.baseRevision === null ? null : (base?.n ?? older.n - 1),
    moreSiblings: siblingGroup(revisions, older).length - 2,
    whyNoKeep: settled
      ? `Revision ${String(latest.n)} was published after these two, so this choice is already made. Open either one in the project to bring its work back.`
      : null,
  };
}

/**
 * What Keep publishes (spec 13 section 5.3): the kept revision's content as a new revision, built
 * on the one not kept, so it is numbered one past the pair and is the library's newest. Nothing is
 * edited or removed.
 */
export interface KeepPlan {
  keep: Revision;
  over: Revision;
  /** The number the new revision will have. */
  n: number;
}

export function keepPlan(pair: RevisionPair, which: "first" | "second"): KeepPlan | string {
  if (pair.whyNoKeep !== null) return pair.whyNoKeep;
  const keep = which === "first" ? pair.first.revision : pair.second.revision;
  const over = which === "first" ? pair.second.revision : pair.first.revision;
  return { keep, over, n: over.n + 1 };
}

/** What `publishKeep` needs of the account model: its base record and its publish. */
export interface KeepModel {
  baseOf(autoId: string): string | null;
  markOpened(autoId: string, revisionId: string): void;
  publish(file: {
    fileName: string;
    canonical: string;
    project: Pick<Project, "robot" | "field" | "waypoints"> | null;
  }): Promise<Revision | null>;
}

/**
 * Publishes a Keep: the one not kept becomes this device's base, so the ordinary publish builds the
 * new revision on it and numbers it one past the pair, with the kept content. If the publish does
 * not happen, the base goes back to what it was. Resolves to the new revision, or null (the model
 * has already said why).
 */
export async function publishKeep(
  model: KeepModel,
  title: string,
  plan: KeepPlan,
  project: Pick<Project, "robot" | "field" | "waypoints"> | null,
): Promise<Revision | null> {
  const { keep, over } = plan;
  const before = model.baseOf(keep.autoId);
  model.markOpened(keep.autoId, over.id);
  const published = await model.publish({ fileName: title, canonical: keep.content, project });
  if (published === null && before !== null) model.markOpened(keep.autoId, before);
  return published;
}

/** The sentence under the Keep buttons, for one side. */
export function keepWords(pair: RevisionPair, which: "first" | "second"): string {
  const plan = keepPlan(pair, which);
  if (typeof plan === "string") return plan;
  const kept = which === "first" ? pair.first : pair.second;
  const other = which === "first" ? pair.second : pair.first;
  return `Publishes ${kept.phrase} as revision ${String(plan.n)}, built on ${other.phrase}, so the team has one newest version again. Nothing is deleted: both revision ${String(pair.first.n)}s stay in the history.`;
}

/** Which side is drawn solid; the other is the dashed ghost under it. */
export type SolidSide = "first" | "second";

/**
 * The step diff of the pair, the ghost as the base and the solid side as the head, read against
 * the open project's robot and field, else the solid side's own, else the ghost's.
 */
export function pairReviewModel(
  pair: RevisionPair,
  solid: SolidSide,
  project: { robot: Robot; field: Field; waypoints?: Waypoints | undefined } | null,
): ReviewModel | string {
  const head = solid === "first" ? pair.first.revision : pair.second.revision;
  const base = solid === "first" ? pair.second.revision : pair.first.revision;
  try {
    const files =
      project ?? projectFromRevision("compare.auto.json", head) ?? projectFromRevision("compare.auto.json", base);
    if (files === null) {
      return "Open your robot's folder first: these revisions were published without robot.json and a field.";
    }
    return buildReviewModel({
      base: autoOfRevision(base).auto,
      head: autoOfRevision(head).auto,
      robot: files.robot,
      field: files.field,
      waypoints: files.waypoints,
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** "Mine is drawn solid over theirs, dashed." */
export function solidWords(pair: RevisionPair, solid: SolidSide): string {
  const on = solid === "first" ? pair.first : pair.second;
  const under = solid === "first" ? pair.second : pair.first;
  return `${on.name} is the solid path; ${under.phrase} is the dashed ghost under it.`;
}
