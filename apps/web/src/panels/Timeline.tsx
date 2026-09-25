/**
 * The timeline above the step list: the routine's total against the period budget, one 10 px bar
 * per step in the same bar language as the step rows and the ledger (UI_GUIDE section 4), the
 * actual bars a loaded trace adds beside them (site/docs/simulation.md),
 * and the playback scrubber that feeds `playbackS` to the canvas.
 *
 * The playback level (site/docs/simulation.md, "Playback levels") decides what the scrubber, the
 * readouts and the main bars run on, and the control under the scrubber chooses it:
 *
 * - **Ideal** (the default): the estimate's bars, with a hatched block wherever the ideal robot has
 *   to turn or drive across a gap before a step (`core.idealTrajectory`), on the ideal clock.
 * - **Instant sim**: the instant sim's per-step times are the main bars, and the kinematic estimate
 *   becomes a thin band under them. A path step's sim bar ends where Pedro ends the path, at 97.5 %
 *   of it; the hold after it settles later, and that settling is the thin tail past the bar's end.
 * - **Full sim**: the loaded trace's own clock; its recorded bars are the track under the estimate.
 */
import { useEffect, useMemo, useRef, type ReactElement } from "react";
import { SkipBack, SkipForward } from "lucide-react";
import {
  totalBound,
  traceDurationS,
  traceStepDurations,
  type IdealSpan,
  type IdealTrajectory,
} from "@horizon36596/zenith-core";
import { RowButton, Unavailable } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { seconds as fmtSeconds } from "../lib/format";
import { estimateByStep } from "../state/derived";
import { SCRUB_STEP_S, SHORTCUTS } from "../app/shortcuts";
import {
  getState,
  selectStep,
  setPlayback,
  setPlaybackLevel,
  setPlaying,
  useDerived,
  useEditor,
} from "../state/store";
import { advancePlayhead, type PlayClock } from "./playClock";
import { indexSteps } from "../lib/stepOps";
import { simSpans, simTotalS, useSim, type SimSpan } from "../state/sim";
import { HelpTip } from "../help/HelpTip";
import {
  effectiveLevel,
  idealFor,
  LEVEL_HINT,
  LEVEL_LABEL,
  LEVEL_SHORT,
  LEVEL_WORD,
  levelInputs,
  levelUnavailable,
  PLAYBACK_LEVELS,
  type PlaybackLevel,
} from "../state/playback";
import styles from "./Timeline.module.css";

export function Timeline() {
  const { auto, project, playbackS, playing, trace, selection, prefs } = useEditor();
  const derived = useDerived();

  const perStep = useMemo(() => estimateByStep(derived.estimate), [derived.estimate]);
  const bound = derived.estimate === null ? null : totalBound(derived.estimate);
  const topLevel = useMemo(
    () => (auto === null ? [] : indexSteps(auto).filter((entry) => entry.depth === 0)),
    [auto],
  );
  const actualByStep = useMemo(
    () => (trace === null ? new Map<string, number>() : traceStepDurations(trace)),
    [trace],
  );

  const robot = derived.plan?.robot ?? null;
  const field = derived.plan?.field ?? null;
  const sim = useSim(derived.plan, robot, field);
  const spans = useMemo(() => simSpans(sim.trace), [sim.trace]);
  const simS = simTotalS(sim.trace);
  const preview = sim.trace !== null && spans.size > 0;
  const inputs = levelInputs(sim, trace);
  const level = effectiveLevel(prefs.playbackLevel, inputs);
  const ideal = idealFor(derived.plan, derived.estimate);
  const idealSpans = useMemo(() => idealSpansById(ideal), [ideal]);

  const budgetS = project?.field.periods?.autoS ?? null;
  const totalS = derived.totalS;
  const recordedS = trace === null ? null : traceDurationS(trace);
  const actualTotalS = useMemo(
    () => [...actualByStep.values()].reduce((sum, value) => sum + value, 0),
    [actualByStep],
  );

  // The scrubber runs on the level's own clock, so it and the robot the canvas plays back agree.
  const idealS = ideal?.totalS ?? totalS;
  const runS = level === "full" ? recordedS : level === "instant" ? simS : idealS;
  const showPreview = level === "instant" && preview;

  // Playback is driven by requestAnimationFrame against the chosen clock, never a transition, and
  // advances by the wall time between frames (`playClock.ts`), so fewer frames never mean slower. The
  // loop starts once per press of Play and reads the playhead from the store and the run's length
  // from a ref each frame, so nothing it causes can restart it: restarting it on every tick lost a
  // frame's time each time, and playback ran at about half real time (QA-08).
  const runRef = useRef(runS);
  runRef.current = runS;
  useEffect(() => {
    if (!playing) return;
    const startRun = runRef.current;
    if (startRun === null || startRun <= 0) {
      setPlaying(false);
      return;
    }
    // Play with the playhead at the end starts again from the beginning (QA-07).
    if ((getState().playbackS ?? 0) >= startRun - 1e-3) setPlayback(0);
    let raf = 0;
    let clock: PlayClock = { lastMs: null };
    const tick = (now: number) => {
      const run = runRef.current;
      const advanced = advancePlayhead(clock, getState().playbackS ?? 0, now);
      clock = advanced.clock;
      const next = advanced.playheadS;
      if (run === null || run <= 0) {
        setPlaying(false);
        return;
      }
      if (next >= run) {
        setPlayback(run);
        setPlaying(false);
        return;
      }
      setPlayback(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [playing]);

  if (auto === null) return null;

  const over = budgetS !== null && totalS !== null && totalS > budgetS;
  /** Both tracks are drawn against the same scale, so a longer actual bar means a longer run. */
  const scaleS = Math.max(totalS ?? 0, idealS ?? 0, actualTotalS, simS ?? 0, 1e-6);

  return (
    <div className={styles.timeline} aria-label="Timeline" data-tour="timeline">
      <div className={styles.head}>
        <span
          className={styles.total}
          data-testid="timeline-total"
          data-seconds={totalS === null ? undefined : totalS.toFixed(3)}
          data-over={over ? "true" : undefined}
        >
          {totalS === null ? "—" : fmtSeconds(totalS)}
          <span className="unit">s</span>
        </span>
        {budgetS === null ? null : (
          <span className={styles.budget}>
            of {fmtSeconds(budgetS)}
            <span className="unit">s</span>
          </span>
        )}
        {trace === null ? null : (
          <Tooltip
            label="Recorded total"
            hint="The sum of the recorded step durations in the loaded trace."
          >
            <span className={styles.actualTotal} data-testid="timeline-actual-total">
              {fmtSeconds(actualTotalS)}
              <span className="unit">s actual</span>
            </span>
          </Tooltip>
        )}
        {runS === null ? null : (
          <Tooltip label={`${LEVEL_LABEL[level]} total`} hint={LEVEL_TOTAL_HINT[level]}>
            <span
              className={styles.simTotal}
              data-testid="timeline-level-total"
              data-level={level}
              data-seconds={runS.toFixed(3)}
              data-stale={level === "instant" && sim.stale ? "true" : undefined}
            >
              {LEVEL_WORD[level]} {fmtSeconds(runS)}
              <span className="unit">s</span>
            </span>
          </Tooltip>
        )}
        {bound === "lower" ? (
          <Tooltip
            label="The total is a lower bound"
            hint="At least one step has no predictable duration, so it counts as zero and its block is hatched."
          >
            <span className={styles.bound} data-testid="timeline-bound">at least</span>
          </Tooltip>
        ) : bound === "upper" ? (
          <Tooltip
            label="The total is an upper bound"
            hint="At least one path ends on a condition, so it is timed as if it drove the whole path."
          >
            <span className={styles.bound} data-testid="timeline-bound">at most</span>
          </Tooltip>
        ) : null}
        <span className={styles.headHelp}>
          <HelpTip id="timeline" />
        </span>
      </div>

      {derived.estimateReason === null ? (
        <div className={styles.tracks}>
          {showPreview ? (
            <div
              className={`${styles.track} ${styles.previewTrack}`}
              data-testid="timeline-preview-track"
              data-stale={sim.stale ? "true" : undefined}
            >
              {topLevel.map((entry) => (
                <PreviewBlock
                  key={entry.id}
                  id={entry.id}
                  span={spans.get(entry.id) ?? null}
                  estimateS={perStep.get(entry.id) ?? null}
                  scaleS={scaleS}
                  selected={selection.stepId === entry.id}
                />
              ))}
            </div>
          ) : null}
          <div
            className={showPreview ? styles.band : styles.track}
            data-testid="timeline-track"
            data-role={showPreview ? "estimate-band" : undefined}
            data-level={showPreview ? undefined : level}
          >
            {topLevel.map((entry) => {
              const value = perStep.get(entry.id) ?? null;
              const span = totalS === null || totalS === 0 ? 1 / topLevel.length : (value ?? 0) / scaleS;
              const gapS = level === "ideal" ? (idealSpans.get(entry.id)?.transitionS ?? 0) : 0;
              const block = (
                <Tooltip
                  key={entry.id}
                  label={entry.id}
                  hint={
                    value === null
                      ? "No estimate for this step."
                      : `${fmtSeconds(value)} s estimated from the drivetrain's speed and acceleration`
                  }
                >
                  <button
                    type="button"
                    className={value === null ? styles.blockUnknown : styles.block}
                    style={{ flexGrow: Math.max(0.02, span) }}
                    tabIndex={showPreview ? -1 : undefined}
                    aria-label={entry.id}
                    data-selected={selection.stepId === entry.id ? "true" : undefined}
                    onClick={() => {
                      selectStep(entry.id);
                    }}
                  />
                </Tooltip>
              );
              if (gapS <= 0 || ideal === null) return block;
              return (
                <TransitionBlock key={entry.id} id={entry.id} ideal={ideal} gapS={gapS} scaleS={scaleS}>
                  {block}
                </TransitionBlock>
              );
            })}
          </div>

          {trace === null ? null : (
            <div className={styles.track} data-testid="timeline-actual-track">
              {topLevel.map((entry) => {
                const value = actualByStep.get(entry.id) ?? null;
                const estimated = perStep.get(entry.id) ?? null;
                const delta = value === null || estimated === null ? null : value - estimated;
                return (
                  <Tooltip
                    key={entry.id}
                    label={entry.id}
                    hint={
                      value === null
                        ? "The trace never reached this step."
                        : `${fmtSeconds(value)} s actual${delta === null ? "" : ` (${delta >= 0 ? "+" : ""}${fmtSeconds(delta)} s)`}`
                    }
                  >
                    <button
                      type="button"
                      className={value === null ? styles.blockMissing : styles.blockActual}
                      style={{ flexGrow: Math.max(0.02, (value ?? 0) / scaleS) }}
                      aria-label={`${entry.id} actual`}
                      data-selected={selection.stepId === entry.id ? "true" : undefined}
                      onClick={() => {
                        selectStep(entry.id);
                      }}
                    />
                  </Tooltip>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <Unavailable>{derived.estimateReason}</Unavailable>
      )}

      <div className={styles.scrub}>
        <RowButton
          icon={SkipBack}
          label="Step back 0.1 s"
          shortcut=","
          onClick={() => {
            setPlayback(Math.max(0, (playbackS ?? 0) - SCRUB_STEP_S));
          }}
        />
        <input
          type="range"
          className={styles.slider}
          aria-label={`Playback position in ${LEVEL_WORD[level]} seconds`}
          data-testid="playback"
          min={0}
          max={runS ?? 0}
          step={0.01}
          disabled={runS === null || runS === 0}
          value={playbackS ?? 0}
          onChange={(event) => {
            setPlayback(Number(event.target.value));
          }}
        />
        <RowButton
          icon={SkipForward}
          label="Step forward 0.1 s"
          shortcut="."
          onClick={() => {
            setPlayback(Math.min(runS ?? 0, (playbackS ?? 0) + SCRUB_STEP_S));
          }}
        />
        <Tooltip
          label="Playback position"
          shortcut={SHORTCUTS.playPause}
          hint={`Seconds into the routine on the ${LEVEL_WORD[level]} clock.`}
        >
          <span className={styles.clock} data-testid="playhead-readout" data-level={level}>
            {fmtSeconds(playbackS ?? 0)}
            <span className="unit">s {LEVEL_SHORT[level]}</span>
          </span>
        </Tooltip>
      </div>

      <div className={styles.levelRow}>
        <span className={styles.levelLabel} id="playback-level-label">
          Playback
        </span>
        <div
          className={styles.levelSwitch}
          role="group"
          aria-labelledby="playback-level-label"
          data-testid="playback-level"
          data-level={level}
        >
          {PLAYBACK_LEVELS.map((option) => {
            const why = levelUnavailable(option, inputs);
            return (
              <Tooltip key={option} label={LEVEL_LABEL[option]} hint={why ?? LEVEL_HINT[option]}>
                <button
                  type="button"
                  className={styles.levelOption}
                  aria-pressed={level === option}
                  aria-disabled={why === null ? undefined : true}
                  data-testid={`playback-level-${option}`}
                  onClick={() => {
                    if (why !== null) return;
                    setPlaybackLevel(option);
                    const limit = (option === "full" ? recordedS : option === "instant" ? simS : idealS) ?? 0;
                    setPlayback(Math.min(playbackS ?? 0, limit));
                  }}
                >
                  {LEVEL_LABEL[option]}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** What each level's total is, for the readout's tooltip. */
const LEVEL_TOTAL_HINT: Readonly<Record<PlaybackLevel, string>> = {
  ideal:
    "How long the routine takes driving the planned path exactly, on the estimate's clock, plus any turn or drive across a gap between steps.",
  instant:
    "How long the instant sim took to run the routine, following each path the way Pedro does. It runs again after every edit.",
  full: "How long the routine ran in the robot repository's own sim, from the loaded trace.",
};

/** The ideal spans by step id. A step id is unique in a routine, so each has one span. */
function idealSpansById(ideal: IdealTrajectory | null): Map<string, IdealSpan> {
  const out = new Map<string, IdealSpan>();
  if (ideal === null) return out;
  for (const span of ideal.spans) out.set(span.stepId, span);
  return out;
}

/**
 * A step's block with the ideal robot's transition in front of it: a hatched block as long as the
 * turn or drive across the gap, which the estimate alone does not count.
 */
function TransitionBlock({
  id,
  ideal,
  gapS,
  scaleS,
  children,
}: {
  id: string;
  ideal: IdealTrajectory;
  gapS: number;
  scaleS: number;
  children: ReactElement;
}) {
  const first = ideal.transitions.find((transition) => transition.stepId === id);
  const parts =
    first === undefined
      ? []
      : [
          first.translateIn > 0 ? `drives ${fmtSeconds(first.translateIn)} in` : null,
          Math.abs(first.turnRad) > 0 ? `turns ${String(Math.round(Math.abs((first.turnRad * 180) / Math.PI)))}°` : null,
        ].filter((part): part is string => part !== null);
  const what =
    first === undefined
      ? "A step inside this one does not start where the robot is, so the ideal robot closes the gap first."
      : `This step does not start where the robot is, so the ideal robot ${parts.join(" and ")} to reach it first.`;
  return (
    <>
      <Tooltip label={`Into ${id} · ideal`} hint={`${fmtSeconds(gapS)} s. ${what}`}>
        <button
          type="button"
          className={styles.blockTransition}
          style={{ flexGrow: Math.max(0.02, gapS / scaleS) }}
          aria-label={`Transition into ${id}`}
          data-testid={`timeline-transition-${id}`}
          onClick={() => {
            selectStep(id);
          }}
        />
      </Tooltip>
      {children}
    </>
  );
}

/**
 * One step's sim bar: from when the sim started the step to when it ended it, and, for a path
 * whose hold settled after that, a thin tail out to the settling time.
 */
function PreviewBlock({
  id,
  span,
  estimateS,
  scaleS,
  selected,
}: {
  id: string;
  span: SimSpan | null;
  estimateS: number | null;
  scaleS: number;
  selected: boolean;
}) {
  const durationS = span === null ? 0 : Math.max(0, span.endS - span.startS);
  const tailS = span?.settledS === null || span === null ? 0 : Math.max(0, span.settledS - span.endS);
  const lines = [
    span === null ? "The sim did not reach this step." : `${fmtSeconds(durationS)} s in the sim`,
    tailS > 0 ? `The hold settles ${fmtSeconds(tailS)} s after the path ends.` : null,
    span?.unknown === true ? (span.unknownReason ?? "The sim cannot predict this step.") : null,
    estimateS === null ? null : `${fmtSeconds(estimateS)} s estimated`,
  ].filter((line): line is string => line !== null);
  return (
    <Tooltip label={`${id} · instant sim`} hint={lines.join(" ")}>
      <button
        type="button"
        className={span === null || span.unknown ? styles.blockUnknown : styles.block}
        style={{ flexGrow: Math.max(0.02, durationS / scaleS) }}
        aria-label={`${id} sim`}
        data-selected={selected ? "true" : undefined}
        data-testid={`timeline-preview-${id}`}
        onClick={() => {
          selectStep(id);
        }}
      >
        {tailS > 0 && durationS > 0 ? (
          <span
            className={styles.tail}
            style={{ width: `${String((tailS / durationS) * 100)}%` }}
            aria-hidden
          />
        ) : null}
      </button>
    </Tooltip>
  );
}
