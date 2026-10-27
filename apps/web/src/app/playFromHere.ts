/**
 * "Play from here" (issue #141): move the playhead to where a step starts at the playback level
 * that plays now (Ideal, Instant sim or Full sim) and start playing. The start comes from the same
 * timing the step list's running highlight reads (`lib/activeSteps.ts`), so the step a person
 * chose is the one that lights up as the robot sets off. The step menu and the palette's "Play from
 * the selected step" both come here.
 */
import { getAllianceState } from "../alliance/store";
import { stepStartS } from "../lib/activeSteps";
import { indexSteps } from "../lib/stepOps";
import { hiddenStepIds } from "../state/features";
import { LEVEL_WORD, effectiveLevel, idealFor, levelInputs, type PlaybackLevel } from "../state/playback";
import { currentSimView } from "../state/sim";
import { currentDerived, getState, setPlayback, setPlaying, type State } from "../state/store";

export type PlayFrom =
  | { ok: true; level: PlaybackLevel; /** On the playhead's clock, the alliance offset included. */ atS: number }
  | { ok: false; reason: string };

const parentsCache = new WeakMap<object, ReadonlyMap<string, string | undefined>>();

function parentsOf(auto: NonNullable<State["auto"]>): ReadonlyMap<string, string | undefined> {
  const hit = parentsCache.get(auto);
  if (hit !== undefined) return hit;
  const parents = new Map(indexSteps(auto).map((entry) => [entry.id, entry.parentId]));
  parentsCache.set(auto, parents);
  return parents;
}

/** Why a level has no start for a step, in a few words for a disabled menu item's tooltip. */
const NEVER_REACHED: Readonly<Record<PlaybackLevel, string>> = {
  ideal: "The ideal run never reaches this step.",
  instant: "The instant sim never reaches this step.",
  full: "The full sim run never reached this step.",
};

/** Where playing from `stepId` would put the playhead, or why it cannot. */
export function playFrom(stepId: string | undefined, state: State = getState()): PlayFrom {
  const auto = state.auto;
  if (auto === null) return { ok: false, reason: "Open an auto first." };
  if (stepId === undefined) return { ok: false, reason: "Select a step first." };
  const parentOf = parentsOf(auto);
  if (!parentOf.has(stepId)) return { ok: false, reason: "Select a step first." };
  if (hiddenStepIds(auto, state.prefs.features).has(stepId)) {
    return { ok: false, reason: "Commands are off in Settings, so this step is hidden." };
  }
  const derived = currentDerived();
  const sim = currentSimView(derived.plan);
  const level = effectiveLevel(state.prefs.playbackLevel, levelInputs(sim, state.trace, state.host, state.prefs.features.fullSim));
  const ideal = idealFor(derived.plan, derived.estimate);
  const startS = stepStartS(stepId, { level, ideal, instant: sim.trace, full: state.trace, parentOf });
  if (startS === null) {
    return { ok: false, reason: level === "ideal" && ideal === null ? `The routine has no ${LEVEL_WORD.ideal} timing yet.` : NEVER_REACHED[level] };
  }
  // With partners loaded the playhead is on the alliance clock, where the own routine waits out its offset.
  const alliance = getAllianceState();
  const offsetS = state.prefs.features.partners && alliance.partners.length > 0 ? alliance.ownOffsetS : 0;
  return { ok: true, level, atS: startS + offsetS };
}

/** Moves the playhead to the step's start and plays; does nothing when it has no start. */
export function playFromStep(stepId: string | undefined): void {
  const from = playFrom(stepId);
  if (!from.ok) return;
  setPlayback(from.atS);
  setPlaying(true);
}
