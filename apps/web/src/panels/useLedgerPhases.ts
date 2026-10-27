/**
 * Where each of the Ledger's steps is relative to the playhead, on the same level, clock and
 * sources as the step list's highlight (`useActiveSteps.ts`): the ideal trajectory at Ideal, the
 * instant sim at Instant sim and the loaded trace at Full sim, with the alliance offset while
 * partners are loaded. So the Ledger's running step is the step list's, and at the end of playback
 * every step has run.
 *
 * The playhead moves every animation frame while playing, but the phases change only when a step
 * starts or ends, so the hook subscribes to a key of the phases rather than to the playhead.
 */
import { useCallback, useMemo } from "react";
import { timings } from "../lib/activeSteps";
import { ownLocalS } from "../alliance/model";
import { useAlliance } from "../alliance/useAlliance";
import { effectiveLevel, idealFor, levelInputs } from "../state/playback";
import { useSim } from "../state/sim";
import { useDerived, useSelector, type State } from "../state/store";
import { stepPhases, type StepPhase } from "./ledgerView";

const selectTrace = (state: State): State["trace"] => state.trace;
const selectHost = (state: State): State["host"] => state.host;
const selectLevel = (state: State): State["prefs"]["playbackLevel"] => state.prefs.playbackLevel;
const selectPartners = (state: State): boolean => state.prefs.features.partners;
const selectFullSim = (state: State): boolean => state.prefs.features.fullSim;

const NO_PARENTS: ReadonlyMap<string, string | undefined> = new Map();

/** Each of `stepIds`' phase at the playhead, in the same order. */
export function useLedgerPhases(stepIds: readonly string[]): readonly StepPhase[] {
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
  const alliance = useAlliance(plan);
  const offsetS = partners && alliance.active ? alliance.ownOffsetS : 0;
  const instant = sim.trace;
  const spans = useMemo(
    () => [...timings({ level, ideal, instant, full: trace, parentOf: NO_PARENTS })],
    [level, ideal, instant, trace],
  );

  const select = useCallback(
    (state: State): string => {
      const phaseOf = stepPhases(spans, state.playbackS === null ? null : ownLocalS(state.playbackS, offsetS));
      return stepIds.map(phaseOf).join(",");
    },
    [spans, stepIds, offsetS],
  );
  const key = useSelector(select);
  return useMemo(() => (key === "" ? [] : (key.split(",") as StepPhase[])), [key]);
}
