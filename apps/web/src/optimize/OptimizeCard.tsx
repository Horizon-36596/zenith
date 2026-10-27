/**
 * The Optimize card (UI_GUIDE 9.18, issue #308): docked at the top of the Inspector's column, not
 * modal. It shows the options, then the run's progress with Stop, then the result, with Apply (Enter)
 * and Discard (Esc). The state is `state.ts`; the field draws the preview.
 *
 * The result says each thing once (issue #413): one headline, "0.70 s faster in the instant sim",
 * the before → after table, the problems the route adds as plain sentences in a list that starts
 * open, and the rest (what changes, the closest clearance, the markers that move and the run's notes)
 * under a "What changes" disclosure that starts closed. A run the safety stop's time box ended says
 * "Searched for 5 s: the best route so far." once, a run the person stopped says "Stopped early: the
 * best route so far.", and the button is Search longer. Finding codes and structure ids never show: a
 * structure is named by its field label.
 *
 * The headline has a tone (0.1.2 UX review): `ok` for a route that helps, `neutral` for nothing found,
 * and `blocked` for a step or spot no route can clear, each with its own glyph and colour. The option
 * rows fold under "Options" once a run starts, so the result has the room.
 *
 * The action row (the Apply line, then Run, Stop, Search longer, Apply or Run again, and Discard) sits
 * under the scrolling body, so it stays in view however long the result is. When the route adds
 * problems the Apply line says so, "Adds 1 warning", in the worst one's colour, and a disabled Apply
 * says why on hover.
 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, CircleCheck, Info, RotateCcw, TriangleAlert, WandSparkles, type LucideIcon } from "lucide-react";
import type { Finding, OptimizedRoute, OptimizeResult, Severity } from "@horizon36596/zenith-core";
import { CheckboxField, NumberField, SelectField } from "../components/fields";
import { Button, RowButton } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { HelpTip } from "../help/HelpTip";
import { helpOfFinding } from "../help/content";
import { getSetting, settingEntry } from "../settings/registry";
import { useFeature } from "../state/features";
import type { OptimizeScorer } from "../state/prefs";
import { setSetting, useSelector, type State } from "../state/store";
import {
  MARGIN_MAX_IN,
  MARGIN_MIN_IN,
  MARGIN_STEP_IN,
  allTotalLine,
  applyOptimize,
  canApply,
  canRetryOptimizeStep,
  chosenRoute,
  continueOptimize,
  discardOptimize,
  optimizeRoutes,
  retryOptimizeStep,
  runOptimizeCard,
  savedS,
  setOptimizeAllAccepted,
  setOptimizeMargin,
  stepOptimizeRoute,
  stopOptimize,
  useOptimizeCard,
  type OptimizeAllStep,
  type OptimizeCardState,
} from "./state";
import { SAFETY_STOP_MS } from "./host";
import { overlapWords, thingLabel } from "./thingWords";
import styles from "./OptimizeCard.module.css";

export { thingLabel } from "./thingWords";

const SCORERS = [
  { value: "sim" as const, label: "Instant sim" },
  { value: "estimate" as const, label: "Estimate" },
];

const MARGIN_HINT =
  "How far the route keeps from structures, in inches. It starts at the robot's clearance in Settings, Robot, and a change here is for this run only: it is never saved. The route runs again 0.3 s after a change.";

/** The card's title for a clear path, which has no step of the auto yet to name. */
export const CLEAR_PATH_TITLE = "Add a clear path";

/** The line the running card shows, with the safety stop's time. */
export const SEARCHING_LINE = `Searching, up to ${String(SAFETY_STOP_MS / 1000)} s`;

/** The line a result that the person's Stop ended shows, once. */
export const STOPPED_LINE = "Stopped early: the best route so far.";

const SEARCH_S = String(SAFETY_STOP_MS / 1000);

/**
 * How the search ended, as the start of a line: "Searched for 5 s" when the safety stop's time box
 * ended it, the ordinary end of a run, "Searched 5 s more" after Search longer, and "Stopped early"
 * only for the person's own Stop (0.1.2 UX review).
 */
export function searchEndWords(card: OptimizeCardState): string {
  if (card.stopReason === "stop") return "Stopped early";
  return card.continued ? `Searched ${SEARCH_S} s more` : `Searched for ${SEARCH_S} s`;
}

/** The line a result that a stop ended shows once, under the headline. */
export const stoppedLine = (card: OptimizeCardState): string => `${searchEndWords(card)}: the best route so far.`;

/** The headline of a clear path with no route round the structures to its spot. */
export const CLEAR_PATH_NONE_LINE = "No clear path to this spot was found round the structures. Try a spot further from them.";

/** Why Apply is off on a stopped run that has found nothing yet. */
export const NOTHING_YET_REASON = "Nothing to apply yet. Search longer to keep looking.";

/**
 * The headline of a stopped run with no route yet, by what the run was looking for: a clear path to
 * a spot, a clear route round a blocked original, or a faster one (issue #434).
 */
export function stoppedEmptyLine(card: OptimizeCardState, result: OptimizeResult): string {
  const how = searchEndWords(card);
  if (card.draft !== null) return `${how}: no clear path yet.`;
  if (result.originalBlocked !== null) return `${how}: no clear route yet.`;
  return `${how}: no faster route yet.`;
}

const selectPrefs = (state: State) => state.prefs;

const seconds = (value: number): string => `${value.toFixed(2)} s`;

/**
 * Whether the result's routes go round an original that `check()` finds going through something
 * (issue #388), so each route's first change sentence says what the original goes through and the
 * route's time against it, and the card shows that sentence as its headline.
 */
const blockedLead = (card: OptimizeCardState, result: OptimizeResult): boolean => card.draft === null && result.originalBlocked !== null;

/** True when the result is infeasible because the step's own start or end is inside something. */
const ownEndInside = (result: OptimizeResult): boolean =>
  result.status === "infeasible" && result.closest !== null && result.closest.step === null;

/** The seconds a route saves under the model the run was scored with: below 0 when it is slower. */
function gainOf(result: OptimizeResult, route: OptimizedRoute): number {
  const sim = result.scorer === "sim" && route.t1 !== null;
  const times = sim && route.t1 !== null ? route.t1 : route.t0;
  return route.gainS ?? times.before.ownS - times.after.ownS;
}

/** "0.70 s faster in the instant sim", by the time the run was scored with. */
export function gainLine(result: OptimizeResult, route: OptimizedRoute): string {
  const gain = gainOf(result, route);
  const model = result.scorer === "sim" && route.t1 !== null ? "the instant sim" : "the estimate";
  if (seconds(Math.abs(gain)) === seconds(0)) return `The same time in ${model}, to the hundredth of a second`;
  return `${seconds(Math.abs(gain))} ${gain < 0 ? "slower" : "faster"} in ${model}`;
}

/** The result's one headline, in plain words. */
export function resultLine(card: OptimizeCardState, result: OptimizeResult): string {
  const route = chosenRoute(card);
  if (ownEndInside(result) && result.closest !== null) {
    const where = overlapWords(result.closest.kind, result.closest.id);
    return card.draft === null
      ? `An end of this path is ${where}, so no route between its ends can be clear. Move that end clear first.`
      : `That spot is ${where}. Right-click somewhere clear of it.`;
  }
  // A stop before anything was found says so, whatever the run was looking for.
  if (route === null && (card.paused || result.status === "stoppedEarly")) return stoppedEmptyLine(card, result);
  if (card.draft !== null) {
    if (result.status === "noBetter") return "The straight path is already clear and nothing was faster, so Apply adds it as it is.";
    if (route !== null) return "A clear path, the fastest found.";
    // A clear path has no original of its own, so core's sentence about one does not fit (issue #434).
    return CLEAR_PATH_NONE_LINE;
  }
  if (route !== null) {
    // Round a blocked original the route may be slower: its own first sentence says so, with its time.
    if (blockedLead(card, result)) return route.changes[0] ?? "The fastest clear route found.";
    return gainLine(result, route);
  }
  return result.changes[0] ?? "No faster route was found.";
}

/**
 * The headline's tone (0.1.2 UX review): `ok` for a route that helps (faster, or clear of what the
 * original goes through), `neutral` when the search found nothing better, and `blocked` when no route
 * can be clear, so "nothing found" and "cannot" never look like success.
 */
export type ResultTone = "ok" | "neutral" | "blocked";

export function resultTone(card: OptimizeCardState, result: OptimizeResult): ResultTone {
  const route = chosenRoute(card);
  if (ownEndInside(result)) return "blocked";
  if (route === null && (card.paused || result.status === "stoppedEarly")) return "neutral";
  if (card.draft !== null) return route !== null || result.status === "noBetter" ? "ok" : "blocked";
  if (route !== null) return blockedLead(card, result) || (gainOf(result, route) > 0 && seconds(gainOf(result, route)) !== seconds(0)) ? "ok" : "neutral";
  return result.originalBlocked === null ? "neutral" : "blocked";
}

const TONE_ICONS: Record<ResultTone, LucideIcon> = { ok: CircleCheck, neutral: Info, blocked: TriangleAlert };

/**
 * The change sentences core writes that the card already says elsewhere: the time (the headline and
 * the table), the problems cleared and added (their own list), the markers (their own line) and the
 * safety stop (said once).
 */
const RESTATED: readonly RegExp[] = [
  /^It is \d+\.\d+ s (faster|slower) in /,
  /^It takes the same time in /,
  /^The step takes /,
  /^The estimate has the step at /,
  /^It clears the /,
  /^It adds a /,
  /^Marker \d+ \(/,
  /^The search stopped before it /,
];

/** The route's change sentences for What changes, without those the card says elsewhere. */
export function changeLines(route: OptimizedRoute, headline: string): string[] {
  return route.changes.filter((change) => change !== headline && !RESTATED.some((pattern) => pattern.test(change)));
}

/** The run's notes for What changes: the safety stop is said once already, and a note needs a result. */
export const noteLines = (notes: readonly string[]): string[] => notes.filter((note) => !RESTATED.some((pattern) => pattern.test(note)));

const SEVERITY_ORDER: readonly Severity[] = ["error", "warning", "info"];
const SEVERITY_WORDS: Record<Severity, [string, string]> = {
  error: ["error", "errors"],
  warning: ["warning", "warnings"],
  info: ["note", "notes"],
};

/** The worst severity among `findings`, or null for none. */
const worstOf = (findings: readonly Finding[]): Severity | null =>
  SEVERITY_ORDER.find((severity) => findings.some((finding) => finding.severity === severity)) ?? null;

/** "Adds 1 warning", "Adds 1 error and 2 warnings": the Apply line for the problems a route adds; null for none. */
export function addsLine(findings: readonly Finding[]): string | null {
  const parts = SEVERITY_ORDER.flatMap((severity) => {
    const count = findings.filter((finding) => finding.severity === severity).length;
    return count === 0 ? [] : [`${String(count)} ${SEVERITY_WORDS[severity][count === 1 ? 0 : 1]}`];
  });
  if (parts.length === 0) return null;
  const last = parts.pop() as string;
  return `Adds ${parts.length === 0 ? last : `${parts.join(", ")} and ${last}`}`;
}

/** A finding's title as the card says it, lower case: "driving sideways", never its code. */
const findingTitle = (finding: Finding): string => {
  const title = helpOfFinding(finding)?.title ?? "a problem on this path";
  return `${title.charAt(0).toLowerCase()}${title.slice(1)}`;
};

/** One finding the route adds or clears in words, "a warning: driving sideways", never its code. */
export function findingPhrase(finding: Finding): string {
  const word = SEVERITY_WORDS[finding.severity][0];
  return `${finding.severity === "error" ? "an" : "a"} ${word}: ${findingTitle(finding)}`;
}

/**
 * The findings in words, each kind said once with its count (issue #434): "3 errors: hits a field
 * element", not that phrase three times. In the order each kind first appears, with its severity.
 */
export function findingKinds(findings: readonly Finding[]): { phrase: string; severity: Severity }[] {
  const kinds = new Map<string, { finding: Finding; count: number }>();
  for (const finding of findings) {
    const key = `${finding.severity} ${findingTitle(finding)}`;
    const kind = kinds.get(key);
    if (kind === undefined) kinds.set(key, { finding, count: 1 });
    else kind.count += 1;
  }
  return [...kinds.values()].map(({ finding, count }) => ({
    phrase: count === 1 ? findingPhrase(finding) : `${String(count)} ${SEVERITY_WORDS[finding.severity][1]}: ${findingTitle(finding)}`,
    severity: finding.severity,
  }));
}

/** A phrase as a sentence of its own: a capital and a full stop, unless it ends in a question. */
const asSentence = (phrase: string): string => {
  const said = `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;
  return /[.?!]$/.test(said) ? said : `${said}.`;
};

/** "a warning", "3 errors": a count of one severity in words. */
const countWords = (severity: Severity, count: number): string =>
  count === 1 ? `${severity === "error" ? "an" : "a"} ${SEVERITY_WORDS[severity][0]}` : `${String(count)} ${SEVERITY_WORDS[severity][1]}`;

/**
 * The line for the problems a route clears, one plain sentence grouped by severity (0.1.2 UX review):
 * "Clears 3 errors (hits a field element).", or "Clears 4 errors (hits a field element 3 times,
 * crosses the centre line) and a warning (driving sideways)." A kind is counted only when its
 * severity has more than one kind.
 */
export function clearsLine(findings: readonly Finding[]): string {
  const groups = SEVERITY_ORDER.flatMap((severity) => {
    const ofSeverity = findings.filter((finding) => finding.severity === severity);
    if (ofSeverity.length === 0) return [];
    const titles = new Map<string, number>();
    for (const finding of ofSeverity) titles.set(findingTitle(finding), (titles.get(findingTitle(finding)) ?? 0) + 1);
    const kinds = [...titles].map(([title, count]) => (titles.size === 1 || count === 1 ? title : `${title} ${String(count)} times`));
    return [`${countWords(severity, ofSeverity.length)} (${kinds.join(", ")})`];
  });
  return asSentence(`Clears ${groups.join(" and ")}`);
}

/** Why Apply is disabled, for its tooltip; null while it is enabled. */
export function applyBlockedReason(card: OptimizeCardState): string | null {
  if (canApply(card)) return null;
  if (card.all !== null) return "Tick at least one path with a faster route to apply it.";
  const result = card.result;
  if (result !== null && ownEndInside(result)) {
    return card.draft !== null
      ? "There is no clear path to this spot. Right-click somewhere clear of the structures."
      : "There is no route to apply. Move the path's end clear of what it is inside, then run again.";
  }
  // A stop before the search found anything: Search longer may still find one.
  if (card.paused) return NOTHING_YET_REASON;
  if (card.draft !== null) return "There is no clear path to this spot. Right-click somewhere clear of the structures.";
  return "There is no faster route to apply.";
}

function Times({ pick }: { pick: OptimizedRoute }) {
  return (
    <dl className={styles.times} data-testid="optimize-times">
      <dt>Instant sim</dt>
      <dd data-testid="optimize-time-sim">
        {pick.t1 === null ? "not run" : `${seconds(pick.t1.before.ownS)} → ${seconds(pick.t1.after.ownS)}`}
      </dd>
      <dt>Estimate</dt>
      <dd data-testid="optimize-time-estimate">{`${seconds(pick.t0.before.ownS)} → ${seconds(pick.t0.after.ownS)}`}</dd>
    </dl>
  );
}

/**
 * The alternatives switcher (issue #310): "Route 2 of 3" with the buttons that step through the
 * pick and its alternatives. Shown only when there is more than one route.
 */
function Switcher({ card }: { card: OptimizeCardState }) {
  const routes = optimizeRoutes(card);
  if (routes.length < 2) return null;
  const route = chosenRoute(card);
  const label = route?.label ?? (card.choice === 0 ? "the fastest found" : "another way round");
  return (
    <div className={styles.switcher} data-testid="optimize-switcher">
      <span className={styles.switcherLabel} data-testid="optimize-route" data-choice={card.choice}>
        {`Route ${String(card.choice + 1)} of ${String(routes.length)}: ${label}`}
      </span>
      <RowButton
        icon={ChevronLeft}
        label="Previous route"
        hint="Show the route before this one. Every route passed the final check."
        testId="optimize-route-previous"
        onClick={() => {
          stepOptimizeRoute(-1);
        }}
      />
      <RowButton
        icon={ChevronRight}
        label="Next route"
        hint="Show the next route. Every route passed the final check."
        testId="optimize-route-next"
        onClick={() => {
          stepOptimizeRoute(1);
        }}
      />
    </div>
  );
}

/** A disclosure in the card's own type: a summary line that opens what is under it. */
function Disclosure({ summary, open, testId, children }: { summary: string; open: boolean; testId: string; children: ReactNode }) {
  return (
    <details className={styles.details} open={open} data-testid={testId}>
      <summary className={styles.summary}>{summary}</summary>
      {children}
    </details>
  );
}

/**
 * The chosen route's details: the table, the problems it adds (open) and clears, then What changes
 * (closed). `headline` is left out of the change sentences, which may have given it.
 */
function ResultDetails({ route, headline, notes }: { route: OptimizedRoute | null; headline: string; notes: readonly string[] }) {
  if (route === null) {
    return notes.length === 0 ? null : (
      <Disclosure summary="About this run" open={false} testId="optimize-details">
        {notes.map((note) => (
          <p key={note} className={`${styles.line} ${styles.quiet}`} data-testid="optimize-note">
            {note}
          </p>
        ))}
      </Disclosure>
    );
  }
  const closest = route.closest;
  const changes = changeLines(route, headline);
  return (
    <>
      <Times pick={route} />
      {route.findingsAdded.length === 0 ? null : (
        <Disclosure summary="New problems" open testId="optimize-added">
          <ul className={styles.list}>
            {findingKinds(route.findingsAdded).map((kind) => (
              <li key={kind.phrase} data-testid="optimize-added-item" data-severity={kind.severity}>
                {asSentence(kind.phrase)}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {route.findingsRemoved.length === 0 ? null : (
        <p className={`${styles.line} ${styles.quiet}`} data-testid="optimize-removed">
          {clearsLine(route.findingsRemoved)}
        </p>
      )}
      <Disclosure summary="What changes" open={false} testId="optimize-details">
        <ul className={styles.list} data-testid="optimize-changes">
          {changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
        <p className={`${styles.line} ${styles.quiet}`} data-testid="optimize-closest">
          {closest === null
            ? "Closest clearance: this field has no structure or keep-out."
            : `Closest clearance: ${closest.clearanceIn.toFixed(2)} in, to ${thingLabel(closest.kind, closest.id)}.`}
        </p>
        <p className={`${styles.line} ${styles.quiet}`} data-testid="optimize-markers">
          {route.movedMarkers.length === 0
            ? "No marker moves."
            : `${String(route.movedMarkers.length)} ${route.movedMarkers.length === 1 ? "marker moves" : "markers move"}: ${route.movedMarkers
                .map((marker) => `${marker.name} by ${marker.movedIn.toFixed(1)} in`)
                .join(", ")}.`}
        </p>
        {notes.map((note) => (
          <p key={note} className={`${styles.line} ${styles.quiet}`} data-testid="optimize-note">
            {note}
          </p>
        ))}
      </Disclosure>
    </>
  );
}

/**
 * One step's line in Optimize every path's result: its times, or why nothing changes. A step whose
 * original went through something (issue #388) says it is cleared and what it went through, and its
 * time is not a saving. A step with no route reads "No faster route found", or "No clear route found"
 * when it went through something.
 */
export function allStepLine(step: OptimizeAllStep): string {
  const result = step.result;
  if (result === null) return `${step.stepId}: ${step.message ?? "The run failed."}`;
  const pick = result.pick;
  const blocked = result.originalBlocked;
  if (pick === null) {
    // A stop ended this path's search before it found a route: that is not "none found". The
    // safety stop's time box is the ordinary end; only the person's Stop is "stopped early".
    if (result.status === "stoppedEarly") {
      const how = step.stopReason === "stop" ? "stopped early" : `searched for ${SEARCH_S} s`;
      return `${step.stepId}: ${how}, ${blocked === null ? "no faster route yet" : "no clear route yet"}`;
    }
    return `${step.stepId}: ${blocked === null ? "No faster route found" : "No clear route found"}`;
  }
  const sim = result.scorer === "sim" && pick.t1 !== null;
  const times = sim && pick.t1 !== null ? pick.t1 : pick.t0;
  const model = sim ? "instant sim" : "estimate";
  if (blocked !== null) {
    return `${step.stepId}: cleared, ${seconds(times.before.ownS)} → ${seconds(times.after.ownS)} (${model}). The original ${blocked.phrase}.`;
  }
  return `${step.stepId}: ${seconds(times.before.ownS)} → ${seconds(times.after.ownS)}, ${savedS(step).toFixed(2)} s faster (${model}).`;
}

/**
 * Optimize every path's progress and results (issue #366): which path runs now, then one row per
 * path step with a box that takes it in or leaves it out of Apply, and the total time saved.
 */
function AllResults({ card }: { card: OptimizeCardState }) {
  const all = card.all;
  if (all === null) return null;
  const running = card.phase === "running" || card.phase === "stopping";
  return (
    <>
      {running ? (
        <p className={styles.line} data-testid="optimize-all-progress">
          {`Path ${String(Math.min(all.index + 1, all.stepIds.length))} of ${String(all.stepIds.length)}: ${card.stepId}`}
        </p>
      ) : null}
      {all.results.length === 0 ? null : (
        <ul className={styles.allList} data-testid="optimize-all-results">
          {all.results.map((step) => (
            <li key={step.stepId} className={styles.allItem} data-failed={step.result === null ? "true" : undefined}>
              <label className={styles.allRow}>
                <input
                  type="checkbox"
                  checked={step.accepted}
                  disabled={step.result?.pick == null || card.phase !== "result"}
                  data-testid={`optimize-all-accept-${step.stepId}`}
                  onChange={(event) => {
                    setOptimizeAllAccepted(step.stepId, event.target.checked);
                  }}
                />
                <span>{allStepLine(step)}</span>
              </label>
              {/* A failed row was never searched: Try again runs that path alone (0.1.2 UX review). */}
              {canRetryOptimizeStep(card, step.stepId) ? (
                <RowButton
                  icon={RotateCcw}
                  label="Try again"
                  hint={`Search ${step.stepId} again on its own. The other rows stay as they are.`}
                  testId={`optimize-all-retry-${step.stepId}`}
                  onClick={() => {
                    retryOptimizeStep(step.stepId);
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {card.phase === "result" ? (
        <p className={styles.line} data-testid="optimize-all-total">
          {allTotalLine(card)}
        </p>
      ) : null}
    </>
  );
}

/** "Searching, up to 5 s" and a bar that fills over the safety stop's time; it starts again for each path. */
function Searching({ card }: { card: OptimizeCardState }) {
  const best = card.progress?.bestJ ?? null;
  return (
    <div className={styles.searching}>
      <p className={styles.line} data-testid="optimize-progress">
        {SEARCHING_LINE}
        {best === null ? null : <span className={styles.best}>{` · best ${seconds(best)}`}</span>}
      </p>
      <div
        key={`${card.stepId}-${String(card.all?.index ?? 0)}`}
        className={styles.bar}
        role="progressbar"
        aria-label={SEARCHING_LINE}
        data-testid="optimize-progress-bar"
        style={{ animationDuration: `${String(SAFETY_STOP_MS)}ms` }}
      />
    </div>
  );
}

/** The folded options' summary line: what the run uses, so they need not be opened to be read. */
function optionsSummary(card: OptimizeCardState, scorer: OptimizeScorer): string {
  const using = SCORERS.find((option) => option.value === scorer)?.label ?? "Instant sim";
  return `Options: ${card.marginIn.toFixed(2)} in margin, ${using.toLowerCase()}`;
}

/** The heading holds the card offers (issue #448), start first. */
const HOLD_IDS = ["optimizer.holdStartHeadingIn", "optimizer.holdEndHeadingIn"] as const;

/** One heading hold as a number field, in inches, 0 off, remembered as the person's last choice. */
function HoldField({ id }: { id: (typeof HOLD_IDS)[number] }) {
  const prefs = useSelector(selectPrefs);
  const entry = settingEntry(id);
  const { control } = entry;
  if (control.type !== "number") return null;
  return (
    <NumberField
      label={entry.label}
      unit={control.unit}
      value={getSetting(prefs, id)}
      step={control.step}
      min={control.min}
      max={control.max}
      digits={0}
      hint={entry.description}
      testId={`optimize-${entry.storage}`}
      onChange={(value: number) => {
        setSetting(id, Math.round(value / control.step) * control.step);
      }}
    />
  );
}

export function OptimizeCard() {
  const card = useOptimizeCard();
  const on = useFeature("optimizer");
  const prefs = useSelector(selectPrefs);
  const root = useRef<HTMLElement | null>(null);
  const phase = card?.phase;
  const open = card !== null;

  // The card takes the focus when it opens and when its result arrives, unless the person is
  // somewhere else, so Enter applies and Esc discards without a click.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active === null || active === document.body || root.current?.contains(active) === true) {
      if (!(active instanceof HTMLInputElement)) root.current?.focus({ preventScroll: true });
    }
  }, [open, phase]);

  if (card === null || !on) return null;
  const result = card.result;
  const running = card.phase === "running" || card.phase === "stopping";
  const single = card.phase === "result" && result !== null && card.all === null;
  const headline = single ? resultLine(card, result) : null;
  const tone = single ? resultTone(card, result) : null;
  const ToneIcon = tone === null ? null : TONE_ICONS[tone];
  const route = single ? chosenRoute(card) : null;
  const adds = route === null || card.stale ? null : addsLine(route.findingsAdded);
  const addsSeverity = route === null ? null : worstOf(route.findingsAdded);
  const reason = applyBlockedReason(card);
  const title = card.draft !== null ? CLEAR_PATH_TITLE : card.all === null ? "Optimize path" : "Optimize every path";

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    if (event.key === "Enter" && !(target instanceof HTMLInputElement) && !(target instanceof HTMLButtonElement) && !(target instanceof HTMLSelectElement) && target.tagName !== "SUMMARY") {
      event.preventDefault();
      event.stopPropagation();
      applyOptimize();
    } else if (event.key === "Escape" && !(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) {
      event.preventDefault();
      event.stopPropagation();
      discardOptimize();
    }
  };

  const apply = (
    <Button kind="primary" testId="optimize-apply" disabled={reason !== null} onClick={applyOptimize}>
      Apply <kbd className={styles.key}>Enter</kbd>
    </Button>
  );

  return (
    <section
      ref={root}
      className={styles.card}
      aria-label={title}
      tabIndex={-1}
      data-testid="optimize-card"
      data-phase={card.phase}
      data-status={result?.status}
      data-mode={card.action?.routeAround === true ? "routeAround" : card.mode}
      data-stale={card.stale ? "true" : undefined}
      data-clear-path={card.draft === null ? undefined : card.draft.chainId === null ? "new" : "extend"}
      data-all={card.all === null ? undefined : "true"}
      onKeyDown={onKeyDown}
    >
      <header className={styles.head}>
        <WandSparkles size={16} strokeWidth={1.75} aria-hidden />
        <h2 className={styles.title} data-testid="optimize-title">
          {title}
        </h2>
        <HelpTip id="optimize" />
        {/* A clear path's step does not exist yet, so it has no name to show. */}
        {card.draft !== null ? null : (
          <span className={styles.step} data-testid="optimize-step">
            {card.all === null ? card.stepId : `${String(card.all.stepIds.length)} ${card.all.stepIds.length === 1 ? "path" : "paths"}`}
          </span>
        )}
      </header>
      <div className={styles.body} data-testid="optimize-body">
        {card.action === null || card.draft !== null ? null : (
          <p className={styles.line} data-testid="optimize-action">
            {card.action.label}
          </p>
        )}
        {/* The options fold away once a run starts, so the result owns the space (0.1.2 UX review). */}
        <Disclosure
          summary={optionsSummary(card, getSetting(prefs, "optimizer.scorer"))}
          open={card.phase === "options"}
          testId="optimize-options"
        >
          <NumberField
            label="Margin"
            unit="in"
            value={card.marginIn}
            step={MARGIN_STEP_IN}
            min={MARGIN_MIN_IN}
            max={MARGIN_MAX_IN}
            digits={2}
            hint={MARGIN_HINT}
            testId="optimize-margin"
            onChange={(value: number) => {
              setOptimizeMargin(value);
            }}
          />
          <SelectField<OptimizeScorer>
            label={settingEntry("optimizer.scorer").label}
            value={getSetting(prefs, "optimizer.scorer")}
            options={SCORERS}
            testId="optimize-scorer"
            onChange={(value) => {
              setSetting("optimizer.scorer", value);
            }}
          />
          <CheckboxField
            label={settingEntry("optimizer.allowSplit").label}
            checked={getSetting(prefs, "optimizer.allowSplit")}
            onChange={(checked) => {
              setSetting("optimizer.allowSplit", checked);
            }}
          />
          <CheckboxField
            label={settingEntry("optimizer.allowRanges").label}
            checked={getSetting(prefs, "optimizer.allowRanges")}
            onChange={(checked) => {
              setSetting("optimizer.allowRanges", checked);
            }}
          />
          {HOLD_IDS.map((id) => (
            <HoldField key={id} id={id} />
          ))}
        </Disclosure>

        {running ? <Searching card={card} /> : null}

        <AllResults card={card} />

        {single && headline !== null ? (
          <>
            <p className={`${styles.line} ${styles.headline}`} data-testid="optimize-status" data-tone={tone ?? undefined}>
              {ToneIcon === null ? null : <ToneIcon className={styles.toneIcon} size={16} strokeWidth={1.75} aria-hidden />}
              <span>{headline}</span>
            </p>
            {card.paused && route !== null ? (
              <p className={`${styles.line} ${styles.quiet}`} data-testid="optimize-stopped">
                {stoppedLine(card)}
              </p>
            ) : null}
            <Switcher card={card} />
            <ResultDetails route={route} headline={headline} notes={noteLines(result.notes)} />
          </>
        ) : null}

        {card.message === null || (card.phase === "result" && !card.stale) ? null : (
          <p className={`${styles.line} ${styles.warn}`} data-testid="optimize-message">
            {card.message}
          </p>
        )}
      </div>

      {/* Outside the scrolling body, so Apply is always in view (issue #413). */}
      <div className={styles.actions} data-testid="optimize-actions">
        {adds === null ? null : (
          <p className={styles.adds} data-severity={addsSeverity ?? undefined} data-testid="optimize-adds">
            {adds}
          </p>
        )}
        <div className={styles.buttons}>
          {card.phase === "options" ? (
            <Button kind="primary" testId="optimize-run" onClick={runOptimizeCard}>
              Run
            </Button>
          ) : null}
          {running ? (
            <Button testId="optimize-stop" disabled={card.phase === "stopping"} onClick={stopOptimize}>
              {card.phase === "stopping" ? "Stopping…" : "Stop"}
            </Button>
          ) : null}
          {card.phase === "result" && card.paused && !card.stale ? (
            <Button testId="optimize-continue" onClick={continueOptimize}>
              Search longer
            </Button>
          ) : null}
          {card.phase === "result" || card.phase === "failed" ? (
            card.stale || card.phase === "failed" ? (
              <Button kind="primary" testId="optimize-rerun" onClick={runOptimizeCard}>
                Run again
              </Button>
            ) : reason === null ? (
              apply
            ) : (
              // A disabled button takes no pointer, so its reason hangs on the box round it.
              <Tooltip label="Apply" hint={reason}>
                <span className={styles.disabledWrap} data-testid="optimize-apply-wrap">
                  {apply}
                </span>
              </Tooltip>
            )
          ) : null}
          <Button testId="optimize-discard" onClick={discardOptimize}>
            Discard <kbd className={styles.key}>Esc</kbd>
          </Button>
        </div>
      </div>
    </section>
  );
}
