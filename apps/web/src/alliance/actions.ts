/**
 * What the alliance view's controls do. The two one-click fixes of spec 13 section 9, offered on
 * ALLIANCE_COLLISION, ALLIANCE_NEAR_MISS and ALLIANCE_ENVELOPE findings:
 *
 * - **Delay my start** sets the user's start offset, a view setting that changes nothing in the
 *   auto, to the smallest offset that clears every predicted finding of that code, and says what
 *   is left and how to set it back (Undo cannot: it is not an edit).
 * - **Add a wait step** inserts a real `wait` step before the step the robot runs as the finding
 *   begins, through the normal edit path (`tryEdit`, so it is one undo step), sized by core's
 *   `smallestClearingWait`.
 *
 * And **Make it a wait step**, which turns the start offset into a real wait at the start of the
 * auto through the same edit path, then sets the offset back to 0 s. Undoing that edit puts the
 * offset back, and redoing it sets it to 0 s again, so the delay is never lost.
 */
import {
  canonicalize,
  insertStartWait,
  insertWaitBefore,
  smallestClearingWait,
  type ClearingWait,
  type Finding,
  type Plan,
} from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import type { Auto, Waypoints } from "@horizon36596/zenith-schema";
import { tryEdit } from "../app/edits";
import { getState, selectStep, setPlayback, setStatus, subscribeEditor, type State } from "../state/store";
import { allianceOptions, findingAllianceS, type AlignedPartner, type PartnerEntry } from "./model";
import { exampleSource, fileSource, type PartnerFileLike, type PartnerSource } from "./source";
import { getAllianceState, loadPartners, removePartner, setOwnOffset } from "./store";
import { allianceView } from "./useAlliance";

/** "A", "A and B", "A, B and C". */
const listWords = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;

/**
 * The status line's sentence for files that were already loaded and replaced their entry instead
 * of loading twice, or "" when none was.
 */
export function replacedWords(replaced: readonly Pick<PartnerEntry, "label">[]): string {
  if (replaced.length === 0) return "";
  const names = listWords(replaced.map((entry) => entry.label));
  return replaced.length === 1
    ? `Replaced ${names} with the file loaded again, so it is not loaded twice.`
    : `Replaced ${names} with the files loaded again, so none is loaded twice.`;
}

/**
 * Loads partners from a source and says what happened on the status line, once. Each refusal is
 * already a whole sentence that names the file and says what to do (`readPartnerText`), so one
 * failed file is said alone, and more than one leads with how many did not load.
 */
export async function loadPartnersFrom(source: PartnerSource): Promise<void> {
  const { added, replaced, failed } = await loadPartners(source);
  const names = listWords(added.map((entry) => entry.label));
  const again = replacedWords(replaced);
  const first = failed[0];
  if (first !== undefined && !first.ok) {
    const count = failed.length;
    const files = count === 1 ? "1 file" : `${String(count)} files`;
    const lead =
      added.length > 0
        ? `Loaded ${names}, but ${files} did not load. `
        : replaced.length > 0
          ? `${again} ${files.charAt(0).toUpperCase()}${files.slice(1)} did not load. `
          : count > 1
            ? `None of ${source.description} loaded. `
            : "";
    const after = added.length > 0 && again !== "" ? ` ${again}` : "";
    setStatus("error", `${lead}${first.reason}${after}`);
    return;
  }
  if (added.length > 0) {
    setStatus(
      "ok",
      `Loaded ${names} into the alliance view. Its findings are predictions.${again === "" ? "" : ` ${again}`}`,
    );
  } else if (replaced.length > 0) setStatus("ok", again);
}

/**
 * Remove on a partner row: unloads it and says how to bring it back. A partner is session data and
 * not part of the auto, so Undo cannot; loading its file or share again can.
 */
export function removePartnerAndSay(partner: Pick<PartnerEntry, "id" | "label" | "share">): void {
  removePartner(partner.id);
  setStatus(
    "ok",
    `Removed ${partner.label}. Load its ${partner.share === undefined ? "file" : "share"} again to bring it back.`,
  );
}

/**
 * Loads the files the user picked. A `trajectory.json` among them is read against the field the
 * open auto is checked against, the same field its findings use.
 */
export const loadPartnerFiles = (files: readonly PartnerFileLike[]): Promise<void> => {
  const state = getState();
  return loadPartnersFrom(fileSource(files, state.autoField ?? state.project?.field ?? null));
};

export const loadExamplePartner = (): Promise<void> => loadPartnersFrom(exampleSource);

/** Moves the scrubber to a finding's time on the alliance clock and selects its step, if it has one. */
export function goToAllianceFinding(finding: Finding): void {
  setPlayback(findingAllianceS(finding));
  if (!finding.stepId.startsWith("(")) selectStep(finding.stepId);
}

/** How a status line names one, or several, predicted findings of each alliance code. */
const FINDING_NOUN: Record<string, [one: string, many: string]> = {
  ALLIANCE_COLLISION: ["collision", "collisions"],
  ALLIANCE_NEAR_MISS: ["near miss", "near misses"],
  ALLIANCE_ENVELOPE: ["entry into a partner's envelope", "entries into a partner's envelope"],
  ALLIANCE_START_OVERLAP: ["start overlap", "start overlaps"],
  ALLIANCE_ELEMENT_CONFLICT: ["element conflict", "element conflicts"],
};

/**
 * What a status line says is left of the predicted findings: "One near miss is left.", "One
 * collision and 2 near misses are left.", or "No predicted conflicts are left." when none is.
 */
export function leftWords(findings: readonly Pick<Finding, "code">[]): string {
  if (findings.length === 0) return "No predicted conflicts are left.";
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.code, (counts.get(finding.code) ?? 0) + 1);
  const parts = [...counts].map(([code, count], index) => {
    const [one, many] = FINDING_NOUN[code] ?? ["predicted finding", "predicted findings"];
    if (count > 1) return `${String(count)} ${many}`;
    return `${index === 0 ? "One" : "one"} ${one}`;
  });
  const verb = findings.length === 1 ? "is" : "are";
  return `${listWords(parts)} ${verb} left.`;
}

/**
 * "Delay my start": sets the user's start offset, checks the alliance again, and says what is left
 * and how to take it back. The offset is a view setting, not an edit, so Undo cannot: setting the
 * offset back can.
 */
export function delayMyStart(plan: Plan, offsetS: number): void {
  const previousS = getAllianceState().ownOffsetS;
  setOwnOffset(offsetS);
  const { result } = allianceView(plan, getAllianceState());
  const left = result === null ? "" : ` ${leftWords(result.findings.map((row) => row.finding))}`;
  setStatus(
    "ok",
    `Your start is delayed by ${offsetS.toFixed(1)} s in the alliance view.${left} To undo it, set Your start offset back to ${previousS.toFixed(1)} s.`,
  );
}

/** What each clearable finding is called in a status line. */
const CLEARS_WHAT: Record<string, string> = {
  ALLIANCE_COLLISION: "every predicted collision",
  ALLIANCE_NEAR_MISS: "every predicted near miss",
  ALLIANCE_ENVELOPE: "every predicted entry into a partner's envelope",
};

/** How a status line names what a fix for this finding's code clears. */
export const clearsWhat = (finding: Pick<Finding, "code">): string => CLEARS_WHAT[finding.code] ?? "it";

/**
 * The wait the second fix would insert for a collision, a near miss or an envelope entry, or null
 * when none up to 10 s clears it.
 */
export function clearingWaitFor(
  plan: Plan,
  waypoints: Waypoints | undefined,
  partners: readonly AlignedPartner[],
  finding: Finding,
): ClearingWait | null {
  const season = resolveSeason(plan.field).rules;
  const { ownOffsetS } = getAllianceState();
  return smallestClearingWait(
    { plan, ...(waypoints === undefined ? {} : { waypoints }), season },
    partners.map((partner) => partner.robot),
    finding,
    allianceOptions(ownOffsetS, partners.map((partner) => partner.entry)),
  );
}

/** "Add a wait step": finds the smallest clearing wait and inserts it through the edit path. */
export function addClearingWait(plan: Plan, partners: readonly AlignedPartner[], finding: Finding): void {
  const waypoints = getState().project?.waypoints;
  const wait = clearingWaitFor(plan, waypoints, partners, finding);
  if (wait === null) {
    setStatus(
      "error",
      `No wait of up to 10 s before that step clears ${clearsWhat(finding)}. Try delaying your start, or route around your partner.`,
    );
    return;
  }
  const added: { waitId: string | null } = { waitId: null };
  tryEdit((current) => {
    const inserted = insertWaitBefore(current, wait.stepId, wait.seconds);
    added.waitId = inserted.waitId;
    return inserted.auto;
  });
  if (added.waitId !== null) {
    selectStep(added.waitId);
    setStatus("ok", `Added a ${wait.seconds.toFixed(1)} s wait before ${wait.stepId}. Undo removes it.`);
  }
}

/**
 * The last "Make it a wait step", so that undoing it brings the start offset back: the offset is a
 * view setting and not part of the auto, so the undo stack alone cannot. `before` and `after` are
 * the auto in canonical form either side of the edit, as the undo and redo stacks hold it.
 */
let madeWait: { fileName: string | null; before: string; after: string; offsetS: number } | null = null;
let followingUndo = false;

/**
 * Watches the editor for the undo of the last "Make it a wait step" (the auto is `before` again,
 * with `after` on top of the redo stack) and puts the offset back, and for its redo (the auto is
 * `after`, with `before` on top of the undo stack) and sets the offset to 0 s again. An offset the
 * user has changed since is theirs and is left alone.
 */
function followUndo(): void {
  if (followingUndo) return;
  followingUndo = true;
  let seen: Auto | null = getState().auto;
  subscribeEditor(() => {
    const state = getState();
    if (state.auto === seen) return;
    seen = state.auto;
    restoreOffsetOnUndo(state);
  });
}

function restoreOffsetOnUndo(state: State): void {
  if (madeWait === null || state.auto === null) return;
  if (state.fileName !== madeWait.fileName) {
    madeWait = null;
    return;
  }
  const now = canonicalize("auto", state.auto);
  const { ownOffsetS } = getAllianceState();
  if (now === madeWait.before && state.redo[state.redo.length - 1]?.auto === madeWait.after) {
    if (ownOffsetS === 0) setOwnOffset(madeWait.offsetS);
  } else if (now === madeWait.after && state.undo[state.undo.length - 1]?.auto === madeWait.before) {
    if (ownOffsetS === madeWait.offsetS) setOwnOffset(0);
  }
}

/**
 * "Make it a wait step": puts a wait of the user's start offset in front of the auto's first step,
 * as one undoable edit, and sets the offset back to 0 s, so the robot and the lanes look as they
 * did. Does nothing while the offset is 0 s. Undo takes the wait out and puts the offset back.
 */
export function offsetToWait(): void {
  const { ownOffsetS } = getAllianceState();
  const before = getState().auto;
  if (!(ownOffsetS > 0) || before === null) return;
  followUndo();
  const added: { waitId: string | null } = { waitId: null };
  tryEdit((current) => {
    const inserted = insertStartWait(current, ownOffsetS);
    added.waitId = inserted.waitId;
    return inserted.auto;
  });
  // Only once the edit is really in the auto: a refused edit leaves the offset where it was.
  const after = getState().auto;
  if (added.waitId === null || after === null || after.steps[0]?.id !== added.waitId) return;
  madeWait = {
    fileName: getState().fileName,
    before: canonicalize("auto", before),
    after: canonicalize("auto", after),
    offsetS: ownOffsetS,
  };
  setOwnOffset(0);
  selectStep(added.waitId);
  setStatus(
    "ok",
    `Your ${ownOffsetS.toFixed(1)} s start offset is now a wait at the start of the auto, and the offset is back to 0 s. Undo removes the wait and puts the offset back.`,
  );
}
