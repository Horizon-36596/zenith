/**
 * "Download share file": the projection a share of the open auto would send, as a file, with no
 * cloud (spec 13 section 8.2). It is built by the share dialog's own `buildProjection`, from the
 * editor's plan and a run of the instant sim with the same options the editor uses, so the file is
 * byte for byte what a share at that level would send and what `zenith projection` writes. A
 * partner loads it in the Partners panel or passes it to `zenith alliance`.
 *
 * DOM-free apart from the one download call, so the building is tested in node.
 */
import { simulateRun, type Plan } from "@horizon36596/zenith-core";
import { buildProjection, kilobytes, type BuiltProjection } from "../cloud/projectionModel";
import type { Level } from "../cloud/types";
import { downloadText } from "../project/fallback";
import { errorsHidden, hiddenErrorsWhere, turnOnWords } from "../state/features";
import { currentAllFindings, currentDerived, getState, setStatus, type State } from "../state/store";
import { previewSimOptions } from "../state/ledgerRun";

/** The file name a share file is downloaded as: `<auto name>.<level>.projection.json`. */
export const shareFileName = (autoName: string, level: Level): string => `${autoName}.${level}.projection.json`;

/**
 * The projection of `plan` at `level`, with the fine rounding and no title, as the share dialog
 * builds it by default; or the reason there is none (an auto the sim refuses, a run over 300 s).
 */
export function buildShareFile(plan: Plan, level: Level): BuiltProjection {
  let trace;
  try {
    trace = simulateRun(plan, plan.robot, plan.field, previewSimOptions(plan, plan.field)).trace;
  } catch (error) {
    return { ok: false, reason: `The instant sim could not run this auto: ${error instanceof Error ? error.message : String(error)}` };
  }
  return buildProjection({ plan, trace }, { level, coarsen: false });
}

/** Why no share file can be downloaded right now, or null when one can. */
export function shareFileBlockedReason(state: State): string | null {
  if (state.auto === null) return "Open an auto first.";
  // Held to the same rule as `zenith projection`: an auto with an error has nothing to share yet,
  // an error in a feature the switches hide too, and then the reason says where it is.
  const counted = errorsHidden(currentAllFindings(), state.auto, state.prefs.features);
  if (counted.hidden > 0) {
    const one = counted.errors === 1;
    const fix =
      counted.hidden === counted.errors
        ? `Fix ${one ? "it" : "them"} or ${turnOnWords(counted.features)}.`
        : `Fix them; ${turnOnWords(counted.features)} to see the hidden ${counted.hidden === 1 ? "one" : "ones"}.`;
    return `This auto has ${String(counted.errors)} error${one ? "" : "s"}${hiddenErrorsWhere(counted)}, so there is nothing to share yet. ${fix}`;
  }
  if (currentDerived().plan === null || counted.errors > 0) {
    return "This auto has errors, so there is nothing to share yet. Fix them first.";
  }
  return null;
}

/** Downloads the open auto's projection at `level`, and says on the status line what it wrote. */
export function downloadShareFile(level: Level): void {
  const state = getState();
  const blocked = shareFileBlockedReason(state);
  const plan = currentDerived().plan;
  if (blocked !== null || plan === null || state.auto === null) {
    setStatus("error", blocked ?? "Open an auto first.");
    return;
  }
  const built = buildShareFile(plan, level);
  if (!built.ok) {
    setStatus("error", built.reason);
    return;
  }
  const fileName = shareFileName(state.auto.name, level);
  downloadText(fileName, built.canonical);
  setStatus(
    "ok",
    level === "propose"
      ? `Downloaded ${fileName} (${kilobytes(built.bytes)}), a share file a partner can suggest changes to. They load it in the Partners panel.`
      : `Downloaded ${fileName} (${kilobytes(built.bytes)}), a share file. A partner loads it in the Partners panel.`,
  );
}
