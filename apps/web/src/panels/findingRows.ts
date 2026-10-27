/**
 * What the Problems list shows of `check()`'s findings, as pure logic (issue #413). The check itself
 * always runs whole: Validate, Save and Propose read every finding, and only the list leaves some out
 * or words them shorter.
 *
 * - The time budget's info note (TIME_BUDGET at info) is not listed and not counted. It says why the
 *   total is a bound, which the timeline's estimate chip already carries, so a clean auto opens on
 *   "No problems found." A TIME_BUDGET warning or error, which says the routine may not fit, stays.
 * - A fix button says a verb and a noun, "Push end clear" or "Route around", and the obstacle is
 *   named only in the message. Core's longer label stays on the button's tooltip.
 * - Route around is left off a collision whose own step starts or ends inside the obstacle: the
 *   optimizer keeps both ends where they are, so it could only say the end overlaps and offer nothing
 *   to apply. Push end clear is the fix there.
 * - Route around is offered once per step among its STRUCTURE rows (0.1.2 UX sweep K20). One path
 *   through the hive frame touches its base bar and two legs, one finding each, and Route around on
 *   any of them opens the same run, which keeps clear of every structure whichever one the row
 *   names. The first of those rows keeps the button and the others say it covers them.
 */
import type { Finding, Fix } from "@horizon36596/zenith-core";

/** True for a finding the Problems list shows and counts: everything but the time budget's info note. */
export const listedInProblems = (finding: Pick<Finding, "code" | "severity">): boolean =>
  !(finding.code === "TIME_BUDGET" && finding.severity === "info");

/** The findings the Problems list shows and counts, in the order given. */
export const problemsListed = <T extends Pick<Finding, "code" | "severity">>(findings: readonly T[]): T[] =>
  findings.filter(listedInProblems);

/** How close to a path's start (0) or end (1) a sample's `t` must be to count as that end. */
const END_T = 1e-3;

/**
 * True when the collision `finding` touches its step's own start or end: a STRUCTURE whose contact
 * runs to t 0 or t 1, or a PERIMETER whose worst point is there.
 */
export function endInsideObstacle(finding: Pick<Finding, "code" | "t" | "geometry">): boolean {
  const atEnd = (t: number | undefined): boolean => t !== undefined && (t <= END_T || t >= 1 - END_T);
  if (finding.code === "STRUCTURE") {
    const range = finding.geometry?.tRange;
    return range === undefined ? atEnd(finding.t) : atEnd(range[0]) || atEnd(range[1]);
  }
  if (finding.code === "PERIMETER") return atEnd(finding.t);
  return false;
}

/** Whether the fix is Route around (an `optimizeRoute` fix that is not Find a faster heading). */
export const isRouteAround = (fix: Fix): boolean => fix.kind === "optimizeRoute" && fix.params.mode !== "headingOnly";

/**
 * The steps whose own start or end is inside something, by the collision findings among `findings`.
 * The optimizer keeps both ends, so Route around on any of their findings could only say so.
 */
export const stepsEndingInside = (findings: readonly Finding[]): Set<string> =>
  new Set(findings.filter(endInsideObstacle).map((finding) => finding.stepId));

/**
 * The finding's fixes the list offers: Route around goes when its step's own end is inside the
 * obstacle, or inside anything else (`endsInside`, from every finding of the check), and when an
 * earlier STRUCTURE row of the step offers it already (`routeAroundAbove`, from `routeAroundShownAbove`).
 */
export function offeredFixes(
  finding: Finding,
  endsInside: ReadonlySet<string> = stepsEndingInside([finding]),
  routeAroundAbove = false,
): Fix[] {
  return (finding.fixes ?? []).filter(
    (fix) => !(isRouteAround(fix) && (routeAroundAbove || endsInside.has(fix.stepId) || endInsideObstacle(finding))),
  );
}

/**
 * The STRUCTURE findings among `findings`, in the order the list shows them, that leave Route around
 * to an earlier STRUCTURE row of the same step (K20): every one that would offer it but the first.
 */
export function routeAroundShownAbove(
  findings: readonly Finding[],
  endsInside: ReadonlySet<string> = stepsEndingInside(findings),
): Set<Finding> {
  const offered = new Set<string>();
  const above = new Set<Finding>();
  for (const finding of findings) {
    if (finding.code !== "STRUCTURE" || !offeredFixes(finding, endsInside).some(isRouteAround)) continue;
    if (offered.has(finding.stepId)) above.add(finding);
    else offered.add(finding.stepId);
  }
  return above;
}

/** What a STRUCTURE row says when it leaves Route around to the step's first one (K20). */
export const ROUTE_AROUND_ABOVE = "Route around on this step's first structure row goes round this one too.";

/** What `noFixReason` needs to know beyond the finding, to word a CLEARANCE row at a path's end. */
export interface NoFixAbout {
  /** The ids of the auto's path steps: a CLEARANCE on a wait or a command has no end to move. */
  pathSteps?: ReadonlySet<string>;
  /** How the row names an obstacle, as the season labels it ("the west base bar of the hive frame"). */
  obstacleName?: (obstacleId: string) => string;
  /** True when an earlier STRUCTURE row of the step offers Route around for this one (`routeAroundShownAbove`). */
  routeAroundAbove?: boolean;
}

/**
 * The one line a selected row says when it offers no fix only because Route around was left off for
 * an end inside something (0.1.2 UX sweep W2-7), or null. Without it a STRUCTURE row whose path
 * ends inside the hive frame offered nothing and said nothing. `offered` is what the row shows, and
 * `routeAroundShown` whether Route around's switch is on: with Optimize path off there is nothing
 * Route around could do anyway.
 *
 * A PERIMETER row says the path ends outside the field, where the robot is. A CLEARANCE row whose
 * closest point is a path's own end gets no Route around from core (it keeps both ends, so it could
 * never clear the warning), and says so with the gap and the obstacle when `about` says the step is
 * a path.
 */
export function noFixReason(
  finding: Finding,
  offered: readonly Fix[],
  routeAroundShown: boolean,
  endsInside: ReadonlySet<string> = stepsEndingInside([finding]),
  about: NoFixAbout = {},
): string | null {
  if (offered.length > 0 || !routeAroundShown) return null;
  if (about.routeAroundAbove === true) return ROUTE_AROUND_ABOVE;
  const clearance = clearanceAtEndReason(finding, about);
  if (clearance !== null) return clearance;
  const routeAround = (finding.fixes ?? []).find(isRouteAround);
  if (routeAround === undefined) return null;
  const then = "then Route around can help.";
  if (finding.code === "PERIMETER" && endInsideObstacle(finding)) {
    return (finding.t ?? 1) >= 1 - END_T
      ? `This path ends outside the field: move its end in first, ${then}`
      : `This path starts outside the field: move its start in first, ${then}`;
  }
  if (endInsideObstacle(finding)) {
    const name = routeAround.label.startsWith("Route around ") ? routeAround.label.slice("Route around ".length) : "it";
    const range = finding.geometry?.tRange;
    const last = range?.[1] ?? finding.t ?? 1;
    return last >= 1 - END_T
      ? `This path ends inside ${name}: move its end out first, ${then}`
      : `This path starts inside ${name}: move its start out first, ${then}`;
  }
  if (endsInside.has(routeAround.stepId)) return `This path starts or ends inside something: move that end out first, ${then}`;
  return null;
}

/** The reason a CLEARANCE row at a path's own start or end offers no Route around, or null. */
function clearanceAtEndReason(finding: Finding, about: NoFixAbout): string | null {
  const { t, geometry } = finding;
  if (finding.code !== "CLEARANCE" || t === undefined || geometry?.gapIn === undefined) return null;
  if (about.pathSteps?.has(finding.stepId) !== true) return null;
  const atStart = t <= END_T;
  if (!atStart && t < 1 - END_T) return null;
  const id = geometry.obstacleId;
  const name = id === undefined ? "an obstacle" : (about.obstacleName?.(id) ?? id);
  const end = atStart ? "start" : "end";
  return `The ${end} of this path is ${geometry.gapIn.toFixed(2)} in from ${name}: move the ${end}, Route around keeps both ends.`;
}

/** The words a fix button says: a verb and a noun. The obstacle and the numbers stay in the message and the tooltip. */
export function fixLabel(fix: Fix): string {
  switch (fix.kind) {
    case "optimizeRoute":
      return fix.params.mode === "headingOnly" ? "Find faster heading" : "Route around";
    case "pushBack":
      // Core names the obstacle in `clearOf` for a structure and leaves it out for the wall.
      return fix.params.clearOf === undefined ? "Push end back" : "Push end clear";
    case "joinSegments":
      return "Join paths";
    case "raiseTimeout":
      return "Raise timeout";
    case "focusTimeout":
      return "Set timeout";
    case "makeTangent":
      return fix.params.reversed === true ? "Point back along path" : "Point nose along path";
    case "turnAtPreviousStop":
      return "Turn at last stop";
    case "slowSweep":
      return "Slow sweep";
    case "moveToLegalApproach":
      return "Move to approach";
    case "splitSegment":
      return "Split path";
    case "splitHeadingRange":
      return "Split range";
    case "startFromCurrent":
      return "Start from robot";
    case "linearHeading":
      return "Turn while driving";
    default:
      return fix.label;
  }
}

/**
 * The second line of a fix button's tooltip: what it does, with core's numbers where the label
 * carries some ("Raise the timeout to 2.50 s"). Route around and Push end clear say what they do
 * without the obstacle's name, which the message already gives. Null when the short label says it all.
 */
export function fixHint(fix: Fix): string | null {
  if (fix.kind === "optimizeRoute") {
    return fix.params.mode === "headingOnly"
      ? "Opens Optimize path on this step to search its heading only. Nothing changes until Apply."
      : "Opens Optimize path on this step to find a clear route. Nothing changes until Apply.";
  }
  if (fix.kind === "pushBack") return "Moves the path's end just far enough to clear it.";
  // It writes no number: it puts the cursor in Give up after for the person to type one.
  if (fix.kind === "focusTimeout") return "Type how long the robot may wait in Give up after.";
  const label = fix.label.endsWith(".") ? fix.label : `${fix.label}.`;
  return fix.label === fixLabel(fix) ? null : label;
}

/** "Press Ctrl Z to undo.", from `undoWords()` ("press Ctrl Z to undo" or "use Undo"), as a sentence. */
const undoSentence = (undo: string): string => `${undo.charAt(0).toUpperCase()}${undo.slice(1)}.`;

/**
 * The status line after a one-click fix changed the auto, as a delete, an insert or a rename has
 * one (0.1.2 UX sweep W2-22): what changed, in plain words, and how to undo it, in `undo`'s words
 * (`undoWords()` in `app/edits.ts`, which reads the person's own Undo key). Null for a fix that
 * writes nothing: Set timeout puts the cursor in a field, and Route around opens Optimize path,
 * whose Apply says what it wrote.
 */
export function fixStatusLine(fix: Fix, undo: string): string | null {
  const said = ((): string | null => {
    const step = fix.stepId;
    switch (fix.kind) {
      case "pushBack": {
        const name = fix.params.clearOf;
        return name === undefined ? `Moved the end of ${step} back from the wall.` : `Moved the end of ${step} clear of ${name}.`;
      }
      case "moveToLegalApproach": {
        const turned = fix.params.aim === "turret" ? "turned so the target is in the turret's range" : "turned so the same side faces the target";
        const warning = fix.params.addsWarning;
        const added = warning === undefined ? "" : ` No spot nearby was free of new warnings, so this adds one: ${warning}`;
        return `Moved the end of ${step} to a legal spot to launch from, ${turned}.${added}`;
      }
      case "makeTangent":
        return `${step} points its ${fix.params.reversed === true ? "back" : "nose"} along the path now.`;
      case "turnAtPreviousStop":
        return `${step} drives nose-first now, and the robot turns at the end of ${fix.params.turnInStepId ?? "the path before it"} instead.`;
      case "slowSweep":
        return `Slowed ${step} to ${String(Math.round(fix.params.speedFraction * 100))} % speed for the sweep.`;
      case "linearHeading":
        return `${step} turns while it drives now.`;
      case "splitSegment":
        return `Split path ${String(fix.params.segmentIndex + 1)} of ${step}.`;
      case "splitHeadingRange":
        return `Split heading range ${String(fix.params.rangeIndex + 1)} of ${step} into ${String(fix.params.parts)}.`;
      case "startFromCurrent":
        return `${step} starts from where the robot is now.`;
      case "joinSegments":
        return `Path ${String(fix.params.segmentIndex + 1)} of ${step} starts where the path before it ends now.`;
      case "raiseTimeout":
        return `Raised the timeout of ${step} to ${String(fix.params.timeoutS)} s.`;
      case "replaceRoute":
        return `Gave ${step} the new route.`;
      case "renameStep":
        return `Renamed ${step} to ${fix.params.newId}.`;
      case "focusTimeout":
      case "optimizeRoute":
        return null;
    }
  })();
  return said === null ? null : `${said} ${undoSentence(undo)}`;
}

/** The start fix the panel adds to START_ILLEGAL, in the same verb-and-noun words. */
export const MOVE_START_LABEL = "Move start";
/** Its tooltip: what it does in full. */
export const MOVE_START_HINT = "Moves the start to the nearest legal spot.";

/** The words a finding code chip's tooltip needs from the code's help (core's `FindingHelp`). */
export interface CodeHelp {
  title: string;
  means: string;
  fix: string;
}

/**
 * A finding code chip's tooltip (0.1.2 UX sweep K22), the same in the Problems list and the Alliance
 * group: the help's title with the code it explains, so the bubble names what the chip says, then
 * what the code means and how to fix it as two short paragraphs. A code with no help has only its
 * name.
 */
export function codeChipTip(code: string, help: CodeHelp | null): { label: string; hint?: string[] } {
  if (help === null) return { label: code };
  return { label: `${help.title} (${code})`, hint: [help.means, `To fix: ${help.fix}`] };
}
