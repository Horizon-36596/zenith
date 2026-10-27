import type { Finding, FindingCode, Severity } from "./types.js";

/** Plain-language help for one finding code: a short name, what it means, and how to fix it. */
export interface FindingHelp {
  /** A few words, for a chip or a heading. */
  title: string;
  /** What the finding is telling you, for someone new to FTC pathing. */
  means: string;
  /** What to change, in the editor's own words. */
  fix: string;
}

/**
 * What each finding code means and how to fix it, written for someone who has never planned an
 * FTC autonomous before (site/docs/editor.md). The editor shows it behind the
 * code chip, `zenith validate --explain` prints it under each finding, and the MCP server returns
 * it with findings, so all three say the same thing.
 */
export const FINDING_HELP: Readonly<Record<FindingCode, FindingHelp>> = {
  SCHEMA: {
    title: "File problem",
    means: "Something in the file is not allowed, such as a misspelled command, a missing value or a waypoint name that does not exist. The robot would refuse to load this file.",
    fix: "Read the message for the exact key that is wrong. Pick the name from the list the editor offers, or add the missing value.",
  },
  CONTINUITY: {
    title: "Path jumps",
    means: "A path starts away from where the robot is, so the robot would have to teleport. Between steps, that is where the previous step ended; inside a path chain, where the path before it ended.",
    fix: "Use the Start from where the robot is fix, which sets the path's start to \"current\". Or drag its first point onto the end of the step before it.",
  },
  HEADING_MISSING: {
    title: "No heading",
    means: "A path does not say which way the robot should face while it drives. Pedro, the path follower, stops the auto with an error when this is missing.",
    fix: "Choose a heading mode in the path's inspector. Tangent, which points the nose along the path, is the usual choice.",
  },
  HEADING: {
    title: "Heading differs on the robot",
    means: "The robot will not face the way this path asks: a turn of more than half a circle in one piece goes the short way round, and a face-point offset is not used yet.",
    fix: "Use the Split fix, which cuts the path so no piece turns more than half a circle and the robot still turns the way you wrote. Or set the heading at a waypoint in between.",
  },
  HEADING_RANGES: {
    title: "Heading ranges do not fit",
    means: "A piecewise heading must split its path into ranges that run from start to end in order, with no gap and no overlap. Pedro stops the auto when they do not.",
    fix: "Drag the range boundaries so each range starts where the one before it ends, the first at 0 and the last at 1.",
  },
  PERIMETER: {
    title: "Leaves the field",
    means: "Part of the robot, its body or an intake mouth, would go past the field wall. A real robot would hit the wall instead.",
    fix: "Move the point in from the wall; where the path ends past it, the Push the end back fix does it for you. Where a path turns as it leaves the wall, Turn while driving turns it gradually.",
  },
  STRUCTURE: {
    title: "Hits a field element",
    means: "The robot's outline overlaps something solid on the field, such as the hive or a flower base. The robot would crash into it.",
    fix: "Move the path around it or bend it clear with a point; Route around finds a way, and Push the end clear moves an end that stops in it. The tint shows where the robot touches it.",
  },
  CLEARANCE: {
    title: "Close to a field element",
    means: "The robot passes closer to something solid on the field than its clearance, 1 in unless robot.json sets one, without touching it. A robot that drifts off the path by that much would hit it.",
    fix: "Move the path a little further from the element, or add a point to bend it clear. If your robot follows its paths closely, set a smaller clearance in Settings, Robot.",
  },
  KEEPOUT: {
    title: "Enters a no-go zone",
    means: "The robot drives into an area the game rules restrict during the autonomous period. That can cost a penalty.",
    fix: "Reroute the path so the outline stays out of the shaded zone. The zone's rule is named in the message.",
  },
  OPPONENT_SIDE: {
    title: "Crosses the centre line",
    means: "During auto the robot, or an intake mouth, goes past the centre line into the other alliance's side. The rules make that a major foul, and a yellow card if the referees see it as strategic.",
    fix: "Keep the path on your own side of the line; Route around the centre line finds a way. The tint and the red outline show where the robot is over.",
  },
  START_ILLEGAL: {
    title: "Start not allowed",
    means: "The starting pose breaks a game rule, for example not touching a wall or starting in the wrong half. The referees would not let the match start like this.",
    fix: "Drag the start pose flush against your own alliance's wall; wall snap helps. The one-click fix moves it to the nearest legal spot that gives the auto no new problem.",
  },
  LEGAL_APPROACH: {
    title: "Shot from an illegal spot",
    means: "The robot shoots from a place the rules do not allow for the target it is aiming at. The scoring would not count or would draw a penalty.",
    fix: "Move the shooting pose to the allowed side of the target. The one-click fix moves it to a legal spot nearby that leaves the auto no worse, turned so the same side faces the target.",
  },
  TURRET_RANGE: {
    title: "Turret cannot aim",
    means: "At this shooting pose the target is outside the angle the turret can turn to. The robot would shoot in the wrong direction.",
    fix: "Turn the robot so the target is closer to straight ahead, or move the shooting pose.",
  },
  CAPACITY: {
    title: "Holds too many",
    means: "The plan has the robot holding more game pieces than it can carry or the rules allow. Something would fall out or draw a penalty.",
    fix: "Shoot or drop pieces before collecting more, or collect fewer. The ledger panel shows what the robot holds after each step.",
  },
  EMPTY_SHOT: {
    title: "Shooting nothing",
    means: "A shoot step runs when the plan says the robot holds no pieces. It wastes time in the autonomous period.",
    fix: "Collect before shooting, or remove the shot. Check the ledger panel to see when the robot is empty.",
  },
  LAUNCH_TARGET: {
    title: "Unknown launch target",
    means: "A step's expected launch target is not a name the field knows as a target, so the plan cannot score the pieces and counts them as loose on the floor.",
    fix: "In the step's expect, change launchesInto to the target the message names or another target on this field, or remove it so the step launches at the current target.",
  },
  STRAFE_FRACTION: {
    title: "Driving sideways",
    means: "A lot of this path is driven sideways, which on mecanum wheels is slower and stops less sharply than driving forward. The message says how many seconds it costs.",
    fix: "Use the fix that points the nose along the path or turn during the previous stop; Find a faster heading searches the heading alone. Keep sideways driving for short, deliberate moves.",
  },
  MOUTH_LEADING: {
    title: "Intake not in front",
    means: "The intake is running but its mouth is not facing the way the robot drives. The robot's body would push game pieces away instead of picking them up.",
    fix: "Choose a heading that puts the running mouth in front, for example tangent for a front mouth or reversed tangent for a back one.",
  },
  SWEEP_SPEED: {
    title: "Intaking too fast",
    means: "The robot drives quickly while its intake runs. Pieces get knocked away rather than collected at that speed.",
    fix: "Lower this path's speed to the sweep speed the robot file sets. The one-click fix does it for you.",
  },
  TIME_BUDGET: {
    title: "Over the time limit",
    means: "The whole routine may take longer than the autonomous period. Anything after the buzzer does not happen.",
    fix: "Cut or shorten steps, drive faster where it is safe, or move slow steps later. The timeline shows which steps take the longest.",
  },
  TIMEOUT_TIGHT: {
    title: "Timeout too short",
    means: "This step's timeout is shorter than, or close to, how long it is expected to take. The robot stops the step when its timeout runs out, finished or not.",
    fix: "Raise the step's timeout to a little more than its estimate. The one-click fix sets it to 1.2 times the estimate, rounded up.",
  },
  WAIT_NO_TIMEOUT: {
    title: "Wait with no timeout",
    means: "This step waits for a condition, such as the hopper reading full, and has no timeout. If it never comes true, the robot waits here for the rest of the period.",
    fix: "Type the longest the robot may wait into the step's Timeout field. The one-click fix puts the cursor there.",
  },
  STATIONARY_MARKER: {
    title: "Stop-only command while moving",
    means: "A command that needs the robot to stand still is set to fire in the middle of a path. It would run while the robot is still driving.",
    fix: "Make it its own step after the path instead of a marker on it.",
  },
  MOVES_ROBOT: {
    title: "Start after a moving command",
    means: "The step before this one moves the robot by itself, so nobody knows exactly where it ends. This path assumes a fixed starting point anyway.",
    fix: "Use the Start from where the robot is fix, which sets this path's start to \"current\" so it begins wherever the robot really is.",
  },
  ENVELOPE_SHAPE: {
    title: "Envelope shape is broken",
    means: "A step's envelope, the area its robot promises to stay inside, is not one simple shape. Its edges cross, or it has fewer than three distinct corners.",
    fix: "Edit the corners in the step's Envelope section so they run round the outside in order, or remove the envelope.",
  },
  TRANSFER: {
    title: "Transfer does not add up",
    means: "A transfer step moves game pieces between two places, such as your partner scoring into the hive. It names a place the ledger does not count, or asks for more pieces than its source holds.",
    fix: "Pick the from and to places from the list in the transfer's inspector. If the source runs short, lower the actual count, or add the step that fills the source earlier.",
  },
  STEP_ID: {
    title: "Step id breaks the rule",
    means: "A step's id has a space or a character an id cannot hold, or does not start with a letter. The file still loads and runs; ids now follow the waypoint name rule.",
    fix: "Use the Rename fix, which removes the characters and updates the deadline that named the step. Or rename the step yourself to letters, digits, _ and -.",
  },
  PROVENANCE: {
    title: "Where did this come from?",
    means: "A pose has no note saying where its numbers came from, such as measured on the field or set in the editor. This is only a reminder, not an error.",
    fix: "Nothing is required. Measure the pose on the field or save it as a named waypoint to record where it came from.",
  },
  ALLIANCE_COLLISION: {
    title: "Predicted crash with partner",
    means: "Your robot and your alliance partner's are predicted to be in the same place at the same time. Both routes come from the instant sim, so this is a forecast, not a certainty.",
    fix: "Delay your start by the offset the alliance view suggests, add a wait before the step named, or route around the partner.",
  },
  ALLIANCE_NEAR_MISS: {
    title: "Predicted close pass",
    means: "The two robots are predicted to pass close without touching. A small difference in speed on the field could turn it into a crash.",
    fix: "Nothing is required. For more room, delay your start or add a wait by the amount the alliance view suggests, or move your path further away.",
  },
  ALLIANCE_START_OVERLAP: {
    title: "Starts overlap partner",
    means: "Your start pose and your partner's overlap or sit on the same field tile, so both robots cannot be set up where the two autos say. Waiting does not help here.",
    fix: "Agree start poses with your partner and move one of them. The alliance view draws both outlines.",
  },
  ALLIANCE_ELEMENT_CONFLICT: {
    title: "Both go for one element",
    means: "Both autos plan to take from the same place or score into the same target. The robot that gets there second may find nothing left.",
    fix: "Agree with your partner who takes it, and change the other auto to collect or score somewhere else.",
  },
  ALLIANCE_ENVELOPE: {
    title: "Enters partner's area",
    means: "Your robot drives into an area your partner has reserved while their robot works there on its own. It is allowed but likely to meet them.",
    fix: "Route around the hatched area during its active time, or delay your start or add a wait by the amount the alliance view suggests.",
  },
  PROPOSAL_SHARE: {
    title: "Share takes no proposals",
    means: "Only a live share at the propose level takes proposed changes. This one is view only, revoked or expired.",
    fix: "Ask the team that shared the auto for a propose-level share, or for more time on this one.",
  },
  PROPOSAL_STALE: {
    title: "Made against an old version",
    means: "The proposal was made against a different version of the shared auto than the one it is checked against. Its steps may no longer line up.",
    fix: "Open the share again and make the changes against the version it holds now.",
  },
  PROPOSAL_TOKEN: {
    title: "Command token not allowed",
    means: "A proposal may move the share's own command and condition tokens, but not copy one or bring in one the share did not hold.",
    fix: "Remove the step that holds the token before placing it somewhere new, or leave the token where it is.",
  },
  PROPOSAL_CHANGE: {
    title: "Change does not fit",
    means: "A proposed change names a step that is not there, or asks for something that step cannot do, such as removing a command.",
    fix: "Read the message for the step and the change. Point the change at a step of the right kind, or drop it.",
  },
  PROPOSAL_CONFLICT: {
    title: "Step changed since share",
    means: "The step this change is about has changed in the auto since the version that was shared, so the change cannot be applied safely.",
    fix: "Reject this change. Share the auto again, and the other team can propose it against the new version.",
  },
  REGISTRY: {
    title: "Robot code disagrees",
    means: "robot.json lists a command, condition or argument differently from the robot's Java, so an auto made in the editor may fail when the robot starts it.",
    fix: "Run zenith import-commands to add what robot.json lacks. Where robot.json names something the Java does not register, fix whichever is wrong.",
  },
};

/**
 * CONTINUITY between two segments of one path step (issue #146). The code's own help is about a
 * step that starts away from where the robot is, and setting a start to "current" does not mend a
 * gap in the middle of a path, so this finding has words of its own.
 */
export const SEGMENT_GAP_HELP: FindingHelp = {
  title: FINDING_HELP.CONTINUITY.title,
  means: "Two paths of one path chain do not meet: one starts somewhere other than where the path before it ends, so the robot would have to teleport between them.",
  fix: "Use the Join fix, which starts the later path where the earlier one ends. Dragging or nudging the point where two paths meet moves both ends, so they stay joined.",
};

/**
 * Help for a code whose meaning changes with its severity. TIME_BUDGET as an info is not about
 * running over: the routine fits, and the note names the steps with no fixed time that make its
 * total a bound, so it gets its own words rather than the advice to cut steps.
 */
export const FINDING_HELP_BY_SEVERITY: Readonly<Partial<Record<FindingCode, Partial<Record<Severity, FindingHelp>>>>> = {
  TIME_BUDGET: {
    info: {
      title: "Total is not exact",
      means: "Some steps have no fixed time, such as a wait for a sensor, a path that ends on a condition or a command with no estimate, so the total is a bound. The message names them.",
      fix: "Nothing is required. To make the total firm, give each wait it names a timeout and each command it names an estimate in robot.json.",
    },
  },
};

/**
 * The help for one finding. A CONTINUITY gap between two segments, which is the one that offers the
 * join fix, gets `SEGMENT_GAP_HELP` (issue #146). Otherwise a code with words for the finding's
 * severity gets those, and every other finding gets its code's (`FINDING_HELP`).
 */
export function helpForFinding(
  finding: Pick<Finding, "code"> & Partial<Pick<Finding, "severity" | "fixes">>,
): FindingHelp {
  const joins = (finding.fixes ?? []).some((fix) => fix.kind === "joinSegments");
  if (finding.code === "CONTINUITY" && joins) return SEGMENT_GAP_HELP;
  const bySeverity = finding.severity === undefined ? undefined : FINDING_HELP_BY_SEVERITY[finding.code]?.[finding.severity];
  return bySeverity ?? FINDING_HELP[finding.code];
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { error: 0, warning: 1, info: 2 };

/**
 * The help for each code these findings raise, once per code, the way `zenith validate --explain`
 * and the MCP tools key it: the words for the most severe finding with that code, so a routine over
 * the period gets the advice to cut steps even when it also carries TIME_BUDGET's info note.
 */
export function helpByCode(
  findings: readonly Pick<Finding, "code" | "severity">[],
): Partial<Record<FindingCode, FindingHelp>> {
  const help: Partial<Record<FindingCode, FindingHelp>> = {};
  const rank: Partial<Record<FindingCode, number>> = {};
  for (const finding of findings) {
    const held = rank[finding.code];
    if (held !== undefined && held <= SEVERITY_RANK[finding.severity]) continue;
    rank[finding.code] = SEVERITY_RANK[finding.severity];
    // Only the code and severity decide the entry, so the CLI's and MCP's per-code help does not
    // change with which of a code's findings happens to offer the join fix.
    help[finding.code] = helpForFinding({ code: finding.code, severity: finding.severity });
  }
  return help;
}
