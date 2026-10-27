/**
 * The Library panel's actions that reach into the editor: Publish to the team library, Open in project,
 * Download project, Compare and Keep (spec 13 sections 5.2 and 5.3). The library state
 * itself is `AccountModel`'s; these only move files between it and the open project.
 */
import type { Revision } from "@horizon36596/zenith-cloud";
import { LocalBackend } from "../project/backend";
import { isWritable } from "../project/types";
import { confirmReplace } from "../app/unsaved";
import { getState, openAuto, openProject, setStatus } from "../state/store";
import { whyCannotPublish } from "../account/permissions";
import { account, editorDirty, savedFile } from "../account/store";
import { autoOfRevision, projectFromRevision, whyCannotPublishFile } from "./libraryModel";
import { keepPlan, publishKeep, type RevisionPair } from "./revisionReview";
import { closeLibraryReview, showLibraryReview } from "./reviewStore";
import { downloadBytes, zipStored } from "./zip";
import { countOf } from "../lib/format";

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Why the open auto cannot be published now, file-wise; the role check is separate. */
export function whyCannotPublishOpenAuto(): string | null {
  const state = getState();
  return whyCannotPublishFile({
    fileName: state.fileName,
    savedCanonical: state.savedCanonical,
    dirty: editorDirty(state),
    reviewing: state.review !== null,
  });
}

/** Publishes the editor's saved file as a new revision. */
export async function publishOpenAuto(): Promise<void> {
  const file = savedFile();
  const why = whyCannotPublishOpenAuto();
  if (file === null || why !== null) {
    setStatus("error", why ?? "Open an auto first.");
    return;
  }
  const project = file.project;
  await account.publish({
    fileName: file.fileName,
    canonical: file.canonical,
    project: project === null ? null : { robot: project.robot, field: project.field, waypoints: project.waypoints },
  });
}

/**
 * Brings a revision into the editor (section 5.2). A folder that can be written takes it through the
 * project's own save path, in place, ready to commit as usual; a read-only project opens it as
 * unsaved; with nothing open, the revision's own robot and field make a project to hold it.
 * Resolves to true when the revision is now the open auto.
 */
export async function openRevisionInProject(title: string, revision: Revision): Promise<boolean> {
  let parsed: ReturnType<typeof autoOfRevision>;
  try {
    parsed = autoOfRevision(revision);
  } catch (error) {
    setStatus("error", `Revision ${String(revision.n)} of ${title} could not be read: ${say(error)}`);
    return false;
  }
  const n = String(revision.n);
  if (!(await confirmReplace(`Opening revision ${n} of ${title} will replace it.`))) {
    setStatus("info", "Kept the unsaved edits.");
    return false;
  }
  const { backend, project } = getState();
  try {
    if (backend !== null && project !== null && isWritable(project.source)) {
      const result = await backend.save(
        title,
        parsed.canonical,
        `Open revision ${n} of ${title} from the team library`,
      );
      openAuto(title, parsed.auto, result.text);
      account.markOpened(revision.autoId, revision.id);
      setStatus("ok", result.note ?? `Wrote revision ${n} of ${title} into ${project.name}.`);
      return true;
    }
    if (backend !== null && project !== null) {
      // An empty saved text makes the auto unsaved, so Save writes it wherever this project saves.
      openAuto(title, parsed.auto, "");
      account.markOpened(revision.autoId, revision.id);
      setStatus(
        "info",
        `Opened revision ${n} of ${title} as unsaved: this project is read only, so Save asks where to put it.`,
      );
      return true;
    }
    const built = projectFromRevision(title, revision);
    if (built === null) {
      setStatus(
        "error",
        `Revision ${n} was published without robot.json and a field. Open your robot's folder first, then open it again.`,
      );
      return false;
    }
    const local = LocalBackend.of(built);
    await local.open();
    openProject(built, local);
    openAuto(title, parsed.auto, "");
    account.markOpened(revision.autoId, revision.id);
    setStatus("info", `Opened revision ${n} of ${title} as unsaved, with the robot and field it was published with.`);
    return true;
  } catch (error) {
    setStatus("error", say(error));
    return false;
  }
}

/** Downloads the whole library as one zip, which the app's Open files reads back. */
export function downloadProject(teamLabel: string): void {
  const entries = account.projectEntries();
  if (entries.length === 0) {
    setStatus("error", "The team library has no revisions to download yet.");
    return;
  }
  const slug =
    teamLabel
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "team";
  downloadBytes(`${slug}-library.zip`, zipStored(entries));
  setStatus(
    "ok",
    `Downloaded ${countOf(entries.filter((e) => e.path.endsWith(".auto.json")).length, "auto")} as ${slug}-library.zip.`,
  );
}

/**
 * Opens two revisions of one auto in the review view (spec 13 section 5.3): the second drawn over
 * the first, ghosted, with the steps that differ. The Library sheet closes so the view has the
 * room; nothing in the project changes until the person chooses.
 */
export function openRevisionReview(autoId: string, title: string, ids: readonly [string, string]): void {
  account.close();
  showLibraryReview(autoId, title, ids);
  setStatus("info", `Comparing two revisions of ${title}. Nothing changes until you choose.`);
}

/** Leaves the review view, back to the editor as it was. */
export function leaveRevisionReview(): void {
  closeLibraryReview();
  setStatus("info", "Left the comparison. Nothing was changed.");
}

/** Open in project, from the review view: the view closes once the revision is the open auto. */
export async function openReviewedRevision(title: string, revision: Revision): Promise<void> {
  if (await openRevisionInProject(title, revision)) closeLibraryReview();
}

/**
 * Keep mine or Keep theirs (spec 13 section 5.3): publishes the kept revision's content as a new
 * revision built on the other one, with the robot and field it was published with. This device's
 * base moves to the new revision, as after any publish; if the publish fails, it goes back to what
 * it was. The local file is not touched: Open in project does that, when the person asks.
 */
export async function keepRevision(title: string, pair: RevisionPair, which: "first" | "second"): Promise<void> {
  const plan = keepPlan(pair, which);
  if (typeof plan === "string") {
    setStatus("error", plan);
    return;
  }
  const why = whyCannotPublish(account.role());
  if (why !== null) {
    setStatus("error", why);
    return;
  }
  let files: ReturnType<typeof projectFromRevision> = null;
  try {
    files = projectFromRevision(title, plan.keep);
  } catch {
    files = null;
  }
  const project = files ?? getState().project;
  const published = await publishKeep(
    account,
    title,
    plan,
    project === null ? null : { robot: project.robot, field: project.field, waypoints: project.waypoints },
  );
  if (published === null) return;
  closeLibraryReview();
  setStatus(
    "ok",
    `Kept revision ${String(plan.keep.n)} by publishing it as revision ${String(published.n)} of ${title}. Nothing was deleted; open it in the project to bring it into your folder.`,
  );
}
