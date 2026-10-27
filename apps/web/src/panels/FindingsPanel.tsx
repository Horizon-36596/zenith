/**
 * The problems panel of UI_GUIDE section 9.7: a header with the region title, its `?`, the severity
 * counts as filter toggles and the clip ghosts toggle, then one row per finding: the severity icon,
 * the message, the code as a muted chip whose tooltip says what it means and how to fix it (core's
 * `FINDING_HELP`), and the step. Rows are not tinted. Settings, Editor, Finding codes
 * (`display.findingCodes`, off in Basic) leaves the chip out; the sentence always shows.
 *
 * Every row but the selected one is one line, `--row-h` tall, with the message cut to that line and
 * its full text in the row's tooltip, so pointing at a row never moves another (issue #413). Clicking
 * a row selects the step the finding points at and moves the playhead to where on it the finding is.
 * The selected step's rows show the whole message, and their fixes as short ghost buttons on a line
 * of their own. The buttons are the how-to, so there is no "How to fix" line; the longer advice stays
 * behind the code chip. `findingRows.ts` decides which findings are listed and what the fixes say:
 * the time budget's info note is neither listed nor counted.
 *
 * Findings from switched-off features stay out of the list, and one last line counts the errors and
 * warnings among them, "2 more problems in hidden features. Show", where Show turns those switches
 * on. The check itself always runs whole.
 *
 * A fix button of kind `optimizeRoute` (Route around, and Find faster heading on a strafing leg)
 * writes nothing: it opens the Optimize card on the step (`optimize/state.ts`, issue #309), as the
 * Timeout fix puts the cursor in the Inspector's field.
 *
 * The header's ghost toggle, an icon, shows or hides the robot drawn in red where a path clips the
 * wall, a structure or a keep-out zone (`canvas/clipGhosts.ts`), remembered per browser. Pointing at
 * or focusing a row emphasises that finding's ghost on the field, even while the ghosts are hidden.
 *
 * `collapsed` leaves the header alone, with its counts, and a click on a count opens the panel. An
 * auto that opens with an error or a warning makes the panel four rows tall, unless the person set
 * its height (`bottomTab.ts`).
 *
 * `derived.findingsReason` (`check()` threw, so `findings` fell back to the plan's own) and each
 * `derived.seasonWarnings` line (an unknown or missing season plugin, so every season-dependent
 * check is silently absent) render as a banner row above the list, so "No problems found" never
 * reads as a clean bill of health when it is really a gap in what got checked (finding 25).
 */
import { useEffect, useMemo, type ReactNode } from "react";
import { Ghost, Info, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import { applyFix } from "@horizon36596/zenith-core";
import type { Finding, Fix, Severity } from "@horizon36596/zenith-core";
import { Tooltip } from "../components/Tooltip";
import { HelpTip } from "../help/HelpTip";
import { helpOfFinding } from "../help/content";
import { FindingCodeChip, FindingMessage } from "./findingParts";
import { severityCounts, sortFindings } from "../state/derived";
import { findingTimeS, idealFor } from "../state/playback";
import { moveStartToLegal, tryEdit, undoWords } from "../app/edits";
import { openOptimizeFix } from "../optimize/state";
import { offersLegalStartFix } from "../project/legalStart";
import { CLIP_GHOST_CODES, findingKey } from "../canvas/clipGhosts";
import { setHoveredFinding } from "../lib/findingHover";
import {
  currentDerived,
  getState,
  selectStep,
  setPlayback,
  setPlaying,
  setPrefs,
  setSelection,
  setSeverityFilter,
  setStatus,
  toggleClipGhosts,
  useAllFindings,
  useDerived,
  useEditor,
} from "../state/store";
import {
  featureLabel,
  fixShown,
  hiddenErrorsHint,
  hiddenProblems,
  hiddenProblemsLine,
  emptyProblemsLine,
  turnOnFeatures,
  useFeatures,
  type Feature,
  type FeatureSwitches,
} from "../state/features";
import type { Auto } from "@horizon36596/zenith-schema";
import { findEntry, indexSteps } from "../lib/stepOps";
import { thingLabel } from "../optimize/OptimizeCard";
import { AllianceFindings } from "../alliance/AllianceFindings";
import { useAlliance } from "../alliance/useAlliance";
import {
  MOVE_START_HINT,
  MOVE_START_LABEL,
  fixHint,
  fixLabel,
  fixStatusLine,
  noFixReason,
  offeredFixes,
  problemsListed,
  routeAroundShownAbove,
  stepsEndingInside,
} from "./findingRows";
import { PROBLEMS_OPEN_PX, raiseBottomPanel } from "./bottomTab";
import styles from "./FindingsPanel.module.css";

/** The fixes the row offers, without those a switch that is off hides (Route around goes with Optimize path). */
const fixesOf = (finding: Finding, features: FeatureSwitches, endsInside: ReadonlySet<string>, routeAroundAbove: boolean): Fix[] =>
  offeredFixes(finding, endsInside, routeAroundAbove).filter((fix) => fixShown(fix.kind, features));

const SEVERITY_ICON: Record<Severity, LucideIcon> = {
  error: OctagonAlert,
  warning: TriangleAlert,
  info: Info,
};

const SEVERITY_WORD: Record<Severity, [string, string]> = {
  error: ["error", "errors"],
  warning: ["warning", "warnings"],
  info: ["info", "info"],
};

/** The clip ghosts toggle's words, which are its tooltip and its name: it is an icon. */
export const CLIP_GHOSTS_LABEL = "Show where the robot hits the wall";

/**
 * The step a finding opens: its own, or for a finding about the whole routine (TIME_BUDGET on
 * `total`), the first step its message names, so the inspector shows that step and not nothing.
 */
export const findingStepId = (finding: Finding): string => finding.stepIds?.[0] ?? finding.stepId;

/** The `stepId` of a finding about the routine's start pose, such as START_ILLEGAL; it names no step. */
export const START_FINDING_STEP_ID = "start";

/** True when the finding is about the start: its `stepId` is `"start"` and no step has that id. */
const aboutStart = (finding: Finding, auto: Auto | null): boolean =>
  finding.stepId === START_FINDING_STEP_ID && (auto === null || findEntry(auto, START_FINDING_STEP_ID) === undefined);

/**
 * Opens a finding: selects its step and, when the finding says where along the step it is, stops
 * playback there so the robot outline sits on the problem (for a clip, on its ghost). A finding
 * about the start, which is not a step, selects the start mark instead and puts the playhead at 0,
 * where the robot stands on the start (issue #155).
 */
export function openFinding(finding: Finding): void {
  if (aboutStart(finding, getState().auto)) {
    setSelection({ start: true });
    setPlaying(false);
    setPlayback(0);
    return;
  }
  selectStep(findingStepId(finding));
  const derived = currentDerived();
  const atS = findingTimeS(finding, idealFor(derived.plan, derived.estimate));
  if (atS === null) return;
  setPlaying(false);
  setPlayback(atS);
}

/** Opens a collapsed panel, for a click on its header that asks to see the list. */
const expand = (): void => {
  if (getState().prefs.findingsCollapsed) setPrefs({ findingsCollapsed: false });
};

/**
 * The severity counts in the bottom panel's header, as buttons. In the Problems tab they are the
 * severity filter's toggles; in the Code tab's header they lead back to Problems, so a collapsed
 * panel says something is wrong whichever tab it shows (issue #413). `pressed` is the filter shown
 * as pressed, if any. `hiddenErrors` is how many errors the feature switches hide: the error count
 * says so in its tooltip, so "0 errors" is never all it says about an auto that has one.
 */
export function SeverityCounts({
  counts,
  pressed,
  testIdPrefix,
  ariaLabel = "Filter the problems by severity",
  labelOf,
  onPick,
  hiddenErrors = 0,
}: {
  counts: Readonly<Record<Severity, number>>;
  pressed: Severity | null;
  testIdPrefix: string;
  ariaLabel?: string;
  labelOf: (severity: Severity) => string;
  onPick: (severity: Severity) => void;
  hiddenErrors?: number;
}) {
  return (
    <div className={styles.counts} role="toolbar" aria-label={ariaLabel}>
      {(["error", "warning", "info"] as const).map((severity, index) => {
        const hint = severity === "error" ? hiddenErrorsHint(hiddenErrors) : undefined;
        return (
          <span key={severity} className={styles.countWrap} data-zero={counts[severity] === 0 ? "true" : undefined}>
            {index === 0 ? null : <span className={styles.sep} aria-hidden>·</span>}
            <Tooltip label={labelOf(severity)} {...(hint === undefined ? {} : { hint })}>
              <button
                type="button"
                className={styles.count}
                data-severity={severity}
                data-hidden-errors={severity === "error" && hiddenErrors > 0 ? String(hiddenErrors) : undefined}
                aria-pressed={pressed === severity}
                data-testid={`${testIdPrefix}-${severity}`}
                onClick={() => {
                  onPick(severity);
                }}
              >
                {counts[severity]}{" "}
                <span className={styles.countWord}>{SEVERITY_WORD[severity][counts[severity] === 1 ? 0 : 1]}</span>
              </button>
            </Tooltip>
          </span>
        );
      })}
    </div>
  );
}

/**
 * `tabs`, when given, takes the place of the Problems title: the bottom panel's tab list, so the
 * Problems and Code tabs share one header row (`BottomPanel.tsx`).
 */
export function FindingsPanel({ tabs, collapsed = false }: { tabs?: ReactNode; collapsed?: boolean } = {}) {
  const { auto, severityFilter, selection, prefs, project, fileName } = useEditor();
  const derived = useDerived();
  const alliance = useAlliance(derived.plan);

  // The time budget's info note is not a problem to list or count (findingRows.ts).
  const listed = useMemo(() => problemsListed(derived.findings), [derived.findings]);
  const counts = useMemo(() => severityCounts(listed), [listed]);
  const allFindings = useAllFindings();
  const hidden = useMemo(() => hiddenProblems(allFindings, auto, prefs.features), [allFindings, auto, prefs.features]);
  const shown = useMemo(() => {
    const sorted = sortFindings(listed);
    return severityFilter === null
      ? sorted
      : sorted.filter((finding) => finding.severity === severityFilter);
  }, [listed, severityFilter]);
  // A hovered row that goes away with the panel must not leave its ghost emphasised on the field.
  useEffect(
    () => () => {
      setHoveredFinding(null);
    },
    [],
  );
  // An auto that opens with an error or a warning gets room for four rows. Only opening does it:
  // an edit that adds a problem never resizes the field under the pointer.
  const opened = auto === null ? null : `${project?.name ?? ""}/${fileName ?? auto.name}`;
  useEffect(() => {
    if (opened === null) return;
    if (problemsListed(currentDerived().findings).some((finding) => finding.severity !== "info")) raiseBottomPanel(PROBLEMS_OPEN_PX);
  }, [opened]);
  const startFix = useMemo(() => offersLegalStartFix(derived.plan, derived.findings), [derived.plan, derived.findings]);
  // Steps whose own end is inside something: Route around on any of their rows could only say so.
  const endsInside = useMemo(() => stepsEndingInside(derived.findings), [derived.findings]);
  // One Route around per step among its STRUCTURE rows, on the first one shown (K20).
  const routeAroundAbove = useMemo(() => routeAroundShownAbove(shown, endsInside), [shown, endsInside]);
  // The path steps, so a CLEARANCE row at a path's own end can say why it offers no Route around.
  const pathSteps = useMemo(
    () => new Set(auto === null ? [] : indexSteps(auto).filter((entry) => entry.step.kind === "path").map((entry) => entry.id)),
    [auto],
  );
  const hasGhosts = useMemo(
    () => derived.findings.some((finding) => CLIP_GHOST_CODES.has(finding.code) && finding.geometry?.poseIn !== undefined),
    [derived.findings],
  );

  if (auto === null) return null;

  return (
    <div className={styles.panel} data-collapsed={collapsed ? "true" : undefined}>
      <div className={styles.head} data-testid="findings-head">
        {tabs ?? <h2 className={styles.title}>Problems</h2>}
        <HelpTip id="findings" />
        <SeverityCounts
          counts={counts}
          pressed={severityFilter}
          testIdPrefix="findings-count"
          hiddenErrors={hidden.errors}
          labelOf={(severity) =>
            collapsed ? "Show the problems" : severityFilter === severity ? "Show every problem" : `Show only ${SEVERITY_WORD[severity][1]}`
          }
          onPick={(severity) => {
            // Collapsed, a count opens the panel and leaves the filter as it was.
            if (collapsed) {
              expand();
              return;
            }
            setSeverityFilter(severityFilter === severity ? null : severity);
          }}
        />
        <Tooltip label={CLIP_GHOSTS_LABEL} hint="Pointing at a problem shows its ghost either way.">
          <button
            type="button"
            className={styles.ghostToggle}
            aria-label={CLIP_GHOSTS_LABEL}
            aria-pressed={prefs.clipGhosts}
            data-has-ghosts={hasGhosts ? "true" : undefined}
            data-testid="findings-clip-ghosts"
            onClick={toggleClipGhosts}
          >
            <Ghost size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </Tooltip>
      </div>

      {collapsed || (derived.findingsReason === null && derived.seasonWarnings.length === 0) ? null : (
        <div className={styles.banners} data-testid="findings-banners">
          {derived.findingsReason === null ? null : (
            <div className={styles.banner} data-kind="error" data-testid="findings-banner-reason">
              <OctagonAlert size={16} strokeWidth={1.75} aria-hidden />
              <span>{derived.findingsReason}</span>
            </div>
          )}
          {derived.seasonWarnings.map((warning) => (
            <div
              key={warning}
              className={styles.banner}
              data-kind="warning"
              data-testid="findings-banner-season"
            >
              <TriangleAlert size={16} strokeWidth={1.75} aria-hidden />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      )}

      {collapsed ? null : (
        <div className={styles.rows}>
          <div role="list" data-testid="findings-list">
            {shown.length === 0 ? (
              <p className={styles.empty} data-testid="findings-empty">
                {emptyProblemsLine(listed.length, hidden.count)}
                {/* The checks run on every edit, so a time since the last Validate would read as stale. */}
                <span className={styles.when}> Checked as you edit.</span>
              </p>
            ) : (
              shown.map((finding, index) => (
                <FindingRow
                  key={`${finding.code}-${finding.stepId}-${String(index)}`}
                  finding={finding}
                  selected={
                    (aboutStart(finding, auto) && selection.start === true) ||
                    (selection.stepId !== undefined &&
                      (selection.stepId === finding.stepId || selection.stepId === findingStepId(finding)))
                  }
                  startFix={finding.code === "START_ILLEGAL" && startFix}
                  showCode={prefs.findingCodes}
                  endsInside={endsInside}
                  routeAroundAbove={routeAroundAbove.has(finding)}
                  pathSteps={pathSteps}
                />
              ))
            )}
          </div>
          {hidden.count === 0 ? null : <HiddenProblemsLine count={hidden.count} errors={hidden.errors} features={hidden.features} />}
          {/* Predicted, in their own group, and never in the counts above (spec 13 section 9). */}
          {derived.plan === null || !prefs.features.partners ? null : <AllianceFindings plan={derived.plan} view={alliance} />}
        </div>
      )}
    </div>
  );
}

/**
 * "2 more problems in hidden features. Show": Show turns on every switch that hides one of them. With
 * an error among them the line names it and takes the error colour.
 */
function HiddenProblemsLine({ count, errors, features }: { count: number; errors: number; features: readonly Feature[] }) {
  const names = features.map(featureLabel).join(" and ");
  return (
    <p className={styles.hidden} data-testid="findings-hidden" data-has-errors={errors > 0 ? "true" : undefined}>
      <span>{hiddenProblemsLine(count, errors)}</span>
      <Tooltip label={`Turn on ${names}`} hint="Turns it on in Settings, General, so these problems are listed here again. Your files stay the same either way.">
        <button
          type="button"
          className={styles.hiddenShow}
          data-testid="findings-hidden-show"
          onClick={() => {
            turnOnFeatures(features);
            setStatus("ok", `Turned on ${names} in Settings, General.`);
          }}
        >
          Show
        </button>
      </Tooltip>
    </p>
  );
}

/** Carries out one of a finding's fixes. */
function runFix(fix: Fix): void {
  if (fix.kind === "focusTimeout") {
    focusTimeoutField(fix.stepId);
    setStatus("info", "Type how long the robot may wait in Give up after.");
  } else if (fix.kind === "optimizeRoute") openOptimizeFix(fix);
  else {
    const before = getState().auto;
    tryEdit((current) => applyFix(current, fix));
    const line = fixStatusLine(fix, undoWords());
    if (getState().auto !== before && line !== null) setStatus("ok", line);
  }
}

function FindingRow({
  finding,
  selected,
  startFix,
  showCode,
  endsInside,
  routeAroundAbove,
  pathSteps,
}: {
  finding: Finding;
  selected: boolean;
  /** A START_ILLEGAL row whose start can be moved: it offers Move start. */
  startFix: boolean;
  /** Whether the code chip shows (`display.findingCodes`); the sentence always does. */
  showCode: boolean;
  /** The steps whose own end is inside something (`stepsEndingInside`), which get no Route around. */
  endsInside: ReadonlySet<string>;
  /** True when an earlier STRUCTURE row of the step offers Route around, so this one leaves it off (K20). */
  routeAroundAbove: boolean;
  /** The ids of the auto's path steps, for `noFixReason`. */
  pathSteps: ReadonlySet<string>;
}) {
  const Icon = SEVERITY_ICON[finding.severity];
  const features = useFeatures();
  const fixes = fixesOf(finding, features, endsInside, routeAroundAbove);
  // The finding's own help: its severity's words (TIME_BUDGET's warning) and a segment gap's own
  // words (issue #146) both come through core's helpForFinding.
  const help = helpOfFinding(finding);
  const hasFixes = selected && (fixes.length > 0 || startFix);
  // Why a row offers nothing, when that is only because its path's end is inside something (W2-7).
  const noFix =
    !selected || startFix
      ? null
      : noFixReason(finding, fixes, fixShown("optimizeRoute", features), endsInside, {
          pathSteps,
          obstacleName: (id) => thingLabel("structure", id),
          routeAroundAbove,
        });
  return (
    <div
      role="listitem"
      className={`${styles.row} ${styles.problem}`}
      data-severity={finding.severity}
      data-selected={selected ? "true" : undefined}
      // The code, as the alliance and proposal rows carry theirs, so a test can find a finding by
      // its code whether or not the code chip shows, and not by text another row may also contain.
      data-code={finding.code}
      data-testid="finding-row"
      onClick={() => {
        openFinding(finding);
      }}
      onMouseEnter={() => {
        setHoveredFinding(findingKey(finding));
      }}
      onMouseLeave={() => {
        setHoveredFinding(null);
      }}
      onFocus={() => {
        setHoveredFinding(findingKey(finding));
      }}
      onBlur={() => {
        setHoveredFinding(null);
      }}
    >
      <Icon className={styles.icon} size={16} strokeWidth={1.75} aria-label={finding.severity} />
      {/* The message is the row's button, so a keyboard user can jump to the problem's step (QA-11).
          Cut to one line until selected; the row's tooltip has all of it. */}
      <FindingMessage
        message={finding.message}
        title={help?.title ?? SEVERITY_WORD[finding.severity][0]}
        ariaLabel={finding.stepId === undefined ? finding.message : `${finding.message} Select ${findingStepId(finding)}.`}
        pressed={selected}
        testId="finding-select"
        onOpen={() => {
          openFinding(finding);
        }}
      />
      {!showCode ? null : (
        <FindingCodeChip
          code={finding.code}
          help={help}
          testId="finding-code"
          onOpen={() => {
            openFinding(finding);
          }}
        />
      )}
      <span className={styles.step}>{finding.stepId}</span>
      {/* Only the selected row has its fixes, so no row grows under the pointer. */}
      {!hasFixes ? null : (
        <span className={styles.fixes} data-testid="finding-fixes">
          {!startFix ? null : (
            <Tooltip label={MOVE_START_LABEL} hint={MOVE_START_HINT}>
              <button
                type="button"
                className={styles.fix}
                data-testid="fix-moveStartToLegal"
                onClick={(event) => {
                  event.stopPropagation();
                  moveStartToLegal();
                }}
              >
                {MOVE_START_LABEL}
              </button>
            </Tooltip>
          )}
          {fixes.map((fix, at) => (
            <Tooltip key={`${fix.kind}-${String(at)}`} label={fixLabel(fix)} hint={fixHint(fix) ?? undefined}>
              <button
                type="button"
                className={styles.fix}
                data-testid={`fix-${fix.kind}`}
                onClick={(event) => {
                  event.stopPropagation();
                  runFix(fix);
                }}
              >
                {fixLabel(fix)}
              </button>
            </Tooltip>
          ))}
        </span>
      )}
      {noFix === null ? null : (
        <span className={styles.fixes} data-testid="finding-nofix">
          {noFix}
        </span>
      )}
    </div>
  );
}

/** How many frames the Timeout fix waits for the inspector to show the step before it gives up. */
const FOCUS_FRAMES = 10;

/**
 * WAIT_NO_TIMEOUT's fix: selects the step and puts the cursor in the inspector's Timeout field,
 * writing no number, since only the person knows how long the robot may wait. The inspector shows
 * the step on a later render, so this looks for the field for a few frames.
 */
function focusTimeoutField(stepId: string): void {
  selectStep(stepId);
  let frames = FOCUS_FRAMES;
  const attempt = (): void => {
    const field = document.querySelector<HTMLInputElement>('[data-testid="inspector-timeout"]');
    if (field !== null) {
      field.focus();
      return;
    }
    frames -= 1;
    if (frames > 0) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

export const severityOrder: Severity[] = ["error", "warning", "info"];
