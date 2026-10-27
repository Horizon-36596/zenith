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
 *   to drive across a gap before a step (`core.idealTrajectory`), on the ideal clock.
 *
 * At every level a path's estimate bar opens with a hatched lead-in for its joint turn, the turn in
 * place it makes first where it starts facing another way from how the robot arrives. That turn is
 * part of the estimate (`StepEstimate.turnS`), so it is inside the bar rather than a block before it.
 * - **Instant sim**: the instant sim's per-step times are the main bars, and the kinematic estimate
 *   becomes a thin band under them. A path step's sim bar ends where Pedro ends the path, at 97.5 %
 *   of it; the hold after it settles later, and that settling is the thin tail past the bar's end.
 * - **Full sim**: the loaded trace's own clock; its recorded bars are the track under the estimate.
 */
import { useEffect, useMemo, useRef, type ReactElement } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import {
  totalBound,
  traceStepDurations,
  type IdealSpan,
  type IdealTrajectory,
} from "@horizon36596/zenith-core";
import { RowButton, Unavailable } from "../components/primitives";
import { Segmented } from "../components/Segmented";
import { Tooltip } from "../components/Tooltip";
import { seconds as fmtSeconds } from "../lib/format";
import { estimateByStep } from "../state/derived";
import { useKeyLabel } from "../app/shortcuts";
import { editingNumbers, formatSeconds } from "../settings/editingNumbers";
import {
  autoFieldOf,
  getState,
  selectStep,
  setPlayback,
  setPlaybackLevel,
  setPlaying,
  useDerived,
  useEditor,
} from "../state/store";
import { advancePlayhead, playFrame, type PlayClock } from "./playClock";
import { indexSteps } from "../lib/stepOps";
import { hiddenStepIds } from "../state/features";
import { simSpans, simTotalS, useSim, type SimSpan } from "../state/sim";
import { HelpTip } from "../help/HelpTip";
import {
  effectiveLevel,
  idealFor,
  LEVEL_HINT,
  LEVEL_LABEL,
  LEVEL_WORD,
  levelInputs,
  levelUnavailable,
  setRunLength,
  shownLevels,
  type PlaybackLevel,
} from "../state/playback";
import { AllianceLanes, OwnOffsetBlock } from "../alliance/AllianceLanes";
import { allianceRunS } from "../alliance/model";
import { useAlliance } from "../alliance/useAlliance";
import { BOUND_HINT, fullSimLengths, headTotal } from "./timelineHead";
import { fullSimSentence, RECORDED_ROUTINE_HINT, recordedTotal, signedSeconds } from "./recordedTotal";
import { instantSimNote } from "./instantSimNote";
import styles from "./Timeline.module.css";

export function Timeline() {
  const editor = useEditor();
  const { auto, playbackS, playing, trace, traceStreaming, selection, prefs, host } = editor;
  const derived = useDerived();
  const playKey = useKeyLabel("playPause");

  const perStep = useMemo(() => estimateByStep(derived.estimate), [derived.estimate]);
  const bound = derived.estimate === null ? null : totalBound(derived.estimate, derived.plan ?? undefined);
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
  const inputs = levelInputs(sim, trace, host, prefs.features.fullSim);
  const level = effectiveLevel(prefs.playbackLevel, inputs);
  const { scrubStepS } = editingNumbers(prefs);
  const ideal = idealFor(derived.plan, derived.estimate);
  const idealSpans = useMemo(() => idealSpansById(ideal), [ideal]);

  // The auto period of the field this auto is planned on, its own when it sets one (issue #403).
  const budgetS = autoFieldOf(editor)?.periods?.autoS ?? null;
  const totalS = derived.totalS;
  // The Full level's total is when the routine ended, not the whole recording, which runs on for the
  // rest of the period; its run is the part received so far while the run is still streaming in.
  const full = fullSimLengths(trace, traceStreaming);
  // The recorded total ends where the routine did, as the Full level's does, never every step added
  // up, which counted a group and its steps twice (W4-4).
  const recorded = useMemo(() => (trace === null ? null : recordedTotal(trace)), [trace]);
  const actualTotalS = recorded?.seconds ?? 0;

  // The scrubber runs on the level's own clock, so it and the robot the canvas plays back agree.
  const idealS = ideal?.totalS ?? totalS;
  const levelRunS = level === "full" ? full.runS : level === "instant" ? simS : idealS;
  const levelTotalS = level === "full" ? full.totalS : levelRunS;
  // With a partner loaded it runs on the alliance clock instead: the user's routine after its
  // start offset, and every visible partner after theirs (alliance/model.ts).
  // Partner sharing switched off in Settings takes the partners and their clock with it.
  const alliance = useAlliance(derived.plan);
  const allianceOn = prefs.features.partners && alliance.active;
  const ownOffsetS = allianceOn ? alliance.ownOffsetS : 0;
  const hidden = useMemo(() => hiddenStepIds(auto, prefs.features), [auto, prefs.features]);
  const runOn = (ownS: number | null): number | null =>
    allianceOn ? allianceRunS(ownS, ownOffsetS, alliance.state.partners) : ownS;
  const runS = runOn(levelRunS);
  const showPreview = level === "instant" && preview;
  // Why the instant sim's total is under the estimate, when it is (W2-18): a branch side, a group
  // that ended first, a wait that ended at once, a run that stopped.
  const simNote = useMemo(
    () =>
      level !== "instant" || sim.trace === null || auto === null
        ? null
        : instantSimNote(sim.trace, indexSteps(auto), perStep, { instantS: simS, idealS }),
    [level, sim.trace, auto, perStep, simS, idealS],
  );

  // Playback is driven by requestAnimationFrame against the chosen clock, never a transition, and
  // advances by the wall time between frames (`playClock.ts`), so fewer frames never mean slower. The
  // loop starts once per press of Play and reads the playhead from the store and the run's length
  // from a ref each frame, so nothing it causes can restart it: restarting it on every tick lost a
  // frame's time each time, and playback ran at about half real time (QA-08).
  const runRef = useRef(runS);
  runRef.current = runS;
  // A Full sim run still streaming in: the playhead waits at the last time received (`playFrame`).
  const streaming = level === "full" && traceStreaming;
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  // The run's end is the playhead's end too: the `,` and `.` keys read it, and an edit or a level
  // switch that makes the run shorter brings a playhead past the new end back to it (issue #316).
  useEffect(() => {
    setRunLength(runS);
    if (runS === null) return;
    const at = getState().playbackS;
    if (at !== null && at > runS) setPlayback(runS);
  }, [runS]);
  useEffect(() => () => {
    setRunLength(null);
  }, []);
  useEffect(() => {
    if (!playing) return;
    const startRun = runRef.current;
    if ((startRun === null || startRun <= 0) && !streamingRef.current) {
      setPlaying(false);
      return;
    }
    // Play with the playhead at the end starts again from the beginning (QA-07); at the end of a
    // run still streaming in, it waits there instead.
    if (startRun !== null && !streamingRef.current && (getState().playbackS ?? 0) >= startRun - 1e-3) setPlayback(0);
    let raf = 0;
    let clock: PlayClock = { lastMs: null };
    const tick = (now: number) => {
      const run = runRef.current;
      const advanced = advancePlayhead(clock, getState().playbackS ?? 0, now);
      clock = advanced.clock;
      const frame = playFrame(advanced.playheadS, run, streamingRef.current);
      if (frame.playheadS !== null) setPlayback(frame.playheadS);
      if (!frame.playing) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [playing]);

  if (auto === null) return null;

  // The head's one total is the playback level's; with no level total yet, the estimate's, said as
  // the estimate's (`timelineHead.ts`).
  const head = headTotal({ level, levelS: levelTotalS, estimateS: totalS, bound });
  const headS = head.seconds;
  const over = budgetS !== null && headS !== null && headS > budgetS;
  /**
   * Both tracks are drawn against the same scale, so a longer actual bar means a longer run. It
   * takes the level's total rather than its run, so a Full sim run streaming in past its routine's
   * end does not squash the bars to the left.
   */
  const scaleS = Math.max(
    (totalS ?? 0) + ownOffsetS,
    (idealS ?? 0) + ownOffsetS,
    actualTotalS + ownOffsetS,
    (simS ?? 0) + ownOffsetS,
    runOn(levelTotalS) ?? 0,
    1e-6,
  );

  return (
    <div className={styles.timeline} aria-label="Timeline" data-tour="timeline">
      {/*
        One head row (issue #411): one total, the chosen playback level's, against the period, with a
        quiet "~" when it is rough, and the level switch beside it. The level's name is said on the
        switch alone. The estimate, when it differs, is in the total's tooltip.
      */}
      <div className={styles.head}>
        {/*
          The reading takes the room the switch leaves, so a long total never pushes the switch or the
          ? along (layout rule 8). "of 30 s" wraps out of sight, whole, when there is no room for it.
        */}
        <div className={styles.reading}>
          <span className={styles.totalUnit}>
            {bound === null || !head.rough ? null : (
              <Tooltip label="Rough total" hint={BOUND_HINT[bound]}>
                <span className={styles.bound} data-testid="timeline-bound" data-bound={bound}>
                  ~
                </span>
              </Tooltip>
            )}
            {/* The period is in the tooltip too, for a column too narrow to show "of 30 s". */}
            <Tooltip
              label={head.label}
              hint={[head.hint, simNote, budgetS === null ? null : `The period is ${budgetWords(budgetS)} s.`]
                .filter((part) => part !== null)
                .join(" ")}
            >
              <span
                className={styles.total}
                data-testid="timeline-total"
                data-seconds={totalS === null ? undefined : totalS.toFixed(3)}
                data-over={over ? "true" : undefined}
              >
                <span
                  data-testid="timeline-level-total"
                  data-level={level}
                  data-seconds={headS === null ? undefined : headS.toFixed(3)}
                  data-stale={level === "instant" && sim.stale ? "true" : undefined}
                >
                  {headS === null ? "—" : fmtSeconds(headS)}
                  <span className="unit">s</span>
                </span>
              </span>
            </Tooltip>
          </span>
          {budgetS === null ? null : (
            <span className={styles.budget} data-testid="timeline-budget">
              of {budgetWords(budgetS)}
              <span className="unit">s</span>
            </span>
          )}
        </div>
        <Segmented<PlaybackLevel>
          label="Playback level"
          options={shownLevels(inputs).map((option) => ({
            value: option,
            label: SWITCH_WORD[option],
            ariaLabel: LEVEL_LABEL[option],
            does: LEVEL_HINT[option],
            whyDisabled: levelUnavailable(option, inputs),
          }))}
          value={level}
          onChange={(option) => {
            setPlaybackLevel(option);
            const limit = runOn(option === "full" ? full.runS : option === "instant" ? simS : idealS) ?? 0;
            setPlayback(Math.min(playbackS ?? 0, limit));
          }}
          testId="playback-level"
          // A press never takes focus, so Space keeps playing and pausing after it (issue #161).
          keepFocus
          className={styles.levelSwitch}
          groupData={{ "data-level": level }}
        />
        <span className={styles.headHelp}>
          <HelpTip id="timeline" />
        </span>
      </div>
      {derived.estimateReason === null ? (
        <div className={styles.tracks}>
          {/*
            The main track and, at Instant sim, the preview track above it with the estimate as a
            band beneath. The pair keeps the same height at every level, so the scrubber below never
            moves when the level changes (sweep A16).
          */}
          <div className={styles.levelTracks}>
            {showPreview ? (
              <div
                className={`${styles.track} ${styles.previewTrack}`}
                data-testid="timeline-preview-track"
                data-stale={sim.stale ? "true" : undefined}
              >
                <OwnOffsetBlock offsetS={ownOffsetS} scaleS={scaleS} />
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
              {showPreview ? null : <OwnOffsetBlock offsetS={ownOffsetS} scaleS={scaleS} />}
              {topLevel.map((entry) => {
                const value = perStep.get(entry.id) ?? null;
                const span = totalS === null || totalS === 0 ? 1 / topLevel.length : (value ?? 0) / scaleS;
                const gapS = level === "ideal" ? (idealSpans.get(entry.id)?.transitionS ?? 0) : 0;
                const turnS = derived.estimate?.byStepId[entry.id]?.turnS ?? 0;
                const estimatedHint = `${fmtSeconds(value ?? 0)} s estimated from the drivetrain's speed and acceleration`;
                const block = hidden.has(entry.id) ? (
                  // A command step while Commands is off: it still takes its time, but cannot be picked.
                  <Tooltip key={entry.id} label="A command step" hint="Turn on Commands in Settings, General to see it.">
                    <button
                      type="button"
                      className={value === null ? styles.blockUnknown : styles.block}
                      style={{ flexGrow: Math.max(0.02, span) }}
                      tabIndex={-1}
                      aria-label="A hidden command step"
                      aria-disabled="true"
                      data-hidden="true"
                    />
                  </Tooltip>
                ) : (
                  <Tooltip
                    key={entry.id}
                    label={entry.id}
                    hint={
                      value === null
                        ? "No estimate for this step."
                        : derived.estimate?.byStepId[entry.id]?.fromActualDuration === true
                          ? `What-if ${fmtSeconds(value)} s: the actual run time its envelope previews, shorter than the longest it runs`
                          : derived.estimate?.byStepId[entry.id]?.fromEnvelope === true
                          ? `At most ${fmtSeconds(value)} s: the longest its envelope says it runs, since it has no estimate of its own`
                          : turnS > 0
                            ? `${estimatedHint}. The hatched start is the ${fmtSeconds(turnS)} s it first turns in place, because this path starts facing another way from how the robot arrives.`
                            : estimatedHint
                    }
                  >
                    <button
                      type="button"
                      className={value === null ? styles.blockUnknown : styles.block}
                      style={{ flexGrow: Math.max(0.02, span) }}
                      tabIndex={showPreview ? -1 : undefined}
                      aria-label={entry.id}
                      data-step-key={entry.id}
                      data-selected={selection.stepId === entry.id ? "true" : undefined}
                      onClick={() => {
                        selectStep(entry.id);
                      }}
                    >
                      {turnS > 0 && value !== null && value > 0 ? (
                        <span
                          className={styles.leadIn}
                          style={{ width: `${String(Math.min(100, (turnS / value) * 100))}%` }}
                          data-testid={`timeline-turn-${entry.id}`}
                          data-seconds={turnS.toFixed(3)}
                          aria-hidden
                        />
                      ) : null}
                    </button>
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
          </div>

          {prefs.features.partners ? <AllianceLanes partners={alliance.result?.partners ?? []} scaleS={scaleS} /> : null}

          {trace === null ? null : (
            // The recorded run's bars, with its total at their end rather than as a second total in
            // the head (issue #411).
            <div className={styles.actualRow}>
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
                          : `Full sim ${fmtSeconds(value)} s${delta === null ? "" : `, ${signedSeconds(delta)} on the plan`}`
                      }
                    >
                      <button
                        type="button"
                        className={value === null ? styles.blockMissing : styles.blockActual}
                        style={{ flexGrow: Math.max(0.02, (value ?? 0) / scaleS) }}
                        aria-label={`${entry.id} actual`}
                        data-step-key={entry.id}
                        data-selected={selection.stepId === entry.id ? "true" : undefined}
                        onClick={() => {
                          selectStep(entry.id);
                        }}
                      />
                    </Tooltip>
                  );
                })}
              </div>
              {/* Beside the run it describes, not in the head, where it would push the level switch. */}
              {streaming ? (
                <Tooltip
                  label="Simulating"
                  hint="The full sim is still running. The timeline shows the part received so far, and playback waits at its end until more arrives."
                >
                  <span className={styles.simulating} data-testid="timeline-simulating" role="status">
                    Simulating
                  </span>
                </Tooltip>
              ) : null}
              {/* One name and one sentence for the recorded run, as the Simulate dialog says it (0.1.2 UX review). */}
              <Tooltip
                label={fullSimSentence(actualTotalS, totalS)}
                hint={recorded?.hint ?? RECORDED_ROUTINE_HINT}
              >
                <span className={styles.actualTotal} data-testid="timeline-actual-total">
                  <span className="unit">Full sim </span>
                  {fmtSeconds(actualTotalS)}
                  <span className="unit">s</span>
                  {totalS === null ? null : <span className="unit">{` ${signedSeconds(actualTotalS - totalS)}`}</span>}
                </span>
              </Tooltip>
            </div>
          )}
        </div>
      ) : (
        <Unavailable>{derived.estimateReason}</Unavailable>
      )}

      <div className={styles.scrub} data-testid="timeline-scrub">
        {/* Play and Pause where the person is looking while scrubbing (issue #411); Space still does both. */}
        <RowButton
          icon={playing ? Pause : Play}
          label={playing ? "Pause" : "Play"}
          hint="Animate the robot along the auto from the playhead."
          shortcut={playKey}
          keepFocus
          disabled={runS === null || runS === 0}
          whyDisabled="There is nothing to play yet."
          onClick={() => {
            setPlaying(!getState().playing);
          }}
          testId="timeline-play"
        />
        <RowButton
          icon={SkipBack}
          label={`Step back ${formatSeconds(scrubStepS)}`}
          shortcut=","
          keepFocus
          onClick={() => {
            setPlayback(Math.max(0, (playbackS ?? 0) - scrubStepS));
          }}
        />
        <input
          type="range"
          className={styles.slider}
          aria-label={`Playback position in ${LEVEL_WORD[level]} seconds`}
          data-testid="playback"
          data-scrubber=""
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
          label={`Step forward ${formatSeconds(scrubStepS)}`}
          shortcut="."
          keepFocus
          onClick={() => {
            setPlayback(Math.min(runS ?? 0, (playbackS ?? 0) + scrubStepS));
          }}
        />
        <Tooltip
          label="Playback position"
          shortcut={playKey}
          hint={
            allianceOn
              ? `Seconds on the alliance clock: every robot's start offset counts, and your robot follows the ${LEVEL_WORD[level]} clock after its own.`
              : `Seconds into the routine on the ${LEVEL_WORD[level]} clock.`
          }
        >
          <span className={styles.clock} data-testid="playhead-readout" data-level={level}>
            {fmtSeconds(playbackS ?? 0)}
            <span className="unit">s</span>
          </span>
        </Tooltip>
      </div>
      {/* Last, so the scrubber above it stays where it is when the level changes (sweep A16). */}
      {simNote === null ? null : (
        <p className={styles.simNote} data-testid="timeline-sim-note">
          {simNote}
        </p>
      )}
    </div>
  );
}

/** The level's word on the switch, short enough for the switch to share the head row with the total. */
const SWITCH_WORD: Readonly<Record<PlaybackLevel, string>> = {
  ideal: "Ideal",
  instant: "Instant",
  full: "Full",
};

/** The period on the head, as a person says it: "30", or "29.5" when it is not whole. */
function budgetWords(budgetS: number): string {
  return Number.isInteger(budgetS) ? String(budgetS) : fmtSeconds(budgetS);
}


/** The ideal spans by step id. A step id is unique in a routine, so each has one span. */
function idealSpansById(ideal: IdealTrajectory | null): Map<string, IdealSpan> {
  const out = new Map<string, IdealSpan>();
  if (ideal === null) return out;
  for (const span of ideal.spans) out.set(span.stepId, span);
  return out;
}

/**
 * A step's block with the ideal robot's transition in front of it: a hatched block as long as the
 * drive across the gap, which the estimate does not count. A turn in place at a joint is not one:
 * the estimate counts it, and the step's own block shows it as a hatched lead-in.
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
          data-step-key={id}
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
        data-step-key={id}
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
