/**
 * The steps running at the playhead, for the step list's highlight (issue #111). It reads the same
 * level, clock and sources the field's robot and the timeline play (`state/playback.ts`,
 * `state/sim.ts`, the alliance offset in `alliance/model.ts`), and works the set out in
 * `lib/activeSteps.ts`.
 *
 * The playhead moves every animation frame while playing, but the set changes only when a step
 * starts or ends, so the hook subscribes to the set's key rather than to the playhead: the list
 * draws again a few times a run, not sixty times a second.
 */
import { useCallback, useMemo } from "react";
import { activeKey, activeStepIds, fromActiveKey } from "../lib/activeSteps";
import { ownLocalS } from "../alliance/model";
import { useAlliance } from "../alliance/useAlliance";
import { effectiveLevel, idealFor, levelInputs } from "../state/playback";
import { useSim } from "../state/sim";
import { useDerived, useSelector, type State } from "../state/store";

const selectTrace = (state: State): State["trace"] => state.trace;
const selectHost = (state: State): State["host"] => state.host;
const selectLevel = (state: State): State["prefs"]["playbackLevel"] => state.prefs.playbackLevel;
const selectPartners = (state: State): boolean => state.prefs.features.partners;
const selectFullSim = (state: State): boolean => state.prefs.features.fullSim;

/** The ids of the steps running at the playhead, with the groups they sit in; `parentOf` from the step list. */
export function useActiveSteps(parentOf: ReadonlyMap<string, string | undefined>): ReadonlySet<string> {
  const derived = useDerived();
  const trace = useSelector(selectTrace);
  const host = useSelector(selectHost);
  const chosen = useSelector(selectLevel);
  const partners = useSelector(selectPartners);
  const fullSim = useSelector(selectFullSim);
  const plan = derived.plan;
  const sim = useSim(plan, plan?.robot ?? null, plan?.field ?? null);
  const level = effectiveLevel(chosen, levelInputs(sim, trace, host, fullSim));
  const ideal = idealFor(plan, derived.estimate);
  // While partners are loaded the playhead is on the alliance clock; the own robot waits out its offset.
  const alliance = useAlliance(plan);
  const offsetS = partners && alliance.active ? alliance.ownOffsetS : 0;
  const instant = sim.trace;

  const select = useCallback(
    (state: State): string =>
      activeKey(
        activeStepIds(state.playbackS === null ? null : ownLocalS(state.playbackS, offsetS), {
          level,
          ideal,
          instant,
          full: trace,
          parentOf,
        }),
      ),
    [level, ideal, instant, trace, parentOf, offsetS],
  );
  const key = useSelector(select);
  return useMemo(() => fromActiveKey(key), [key]);
}
