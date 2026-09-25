import type { FindingCode } from "./types.js";

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
    means: "A path starts somewhere other than where the robot is, so the robot would have to teleport. The gap is measured from where the previous step ended.",
    fix: "Set the path's start to \"current\" so it begins wherever the robot is. Or drag its first point onto the end of the step before it.",
  },
  HEADING_MISSING: {
    title: "No heading",
    means: "A path does not say which way the robot should face while it drives. Pedro, the path follower, stops the auto with an error when this is missing.",
    fix: "Choose a heading mode in the path's inspector. Tangent, which points the nose along the path, is the usual choice.",
  },
  HEADING: {
    title: "Heading differs on the robot",
    means: "The robot will not face the way this path asks: a turn of more than half a circle in one piece goes the short way round, and a face-point offset is not used yet.",
    fix: "Split the path so no piece turns more than half a circle, or set the heading at a waypoint in between.",
  },
  HEADING_RANGES: {
    title: "Heading ranges do not fit",
    means: "A piecewise heading must split its path into ranges that run from start to end in order, with no gap and no overlap. Pedro stops the auto when they do not.",
    fix: "Drag the range boundaries so each range starts where the one before it ends, the first at 0 and the last at 1.",
  },
  PERIMETER: {
    title: "Leaves the field",
    means: "Part of the robot, its body or an intake mouth, would go past the field wall. A real robot would hit the wall instead.",
    fix: "Move the point away from the wall until the outline stays inside. Snapping to the wall places the robot flush against it.",
  },
  STRUCTURE: {
    title: "Hits a field element",
    means: "The robot's outline overlaps something solid on the field, such as the hive or a flower base. The robot would crash into it.",
    fix: "Move the path around the element, or add a point to bend it clear. The finding marks where the overlap is deepest.",
  },
  KEEPOUT: {
    title: "Enters a no-go zone",
    means: "The robot drives into an area the game rules restrict during the autonomous period. That can cost a penalty.",
    fix: "Reroute the path so the outline stays out of the shaded zone. The zone's rule is named in the message.",
  },
  START_ILLEGAL: {
    title: "Start not allowed",
    means: "The starting pose breaks a game rule, for example not touching a wall or starting in the wrong half. The referees would not let the match start like this.",
    fix: "Drag the start pose to a legal spot, usually flush against your own alliance's wall. Wall snap helps.",
  },
  LEGAL_APPROACH: {
    title: "Shot from an illegal spot",
    means: "The robot shoots from a place the rules do not allow for the target it is aiming at. The scoring would not count or would draw a penalty.",
    fix: "Move the shooting pose to the allowed side of the target. The one-click fix moves it to the nearest legal spot.",
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
  STRAFE_FRACTION: {
    title: "Driving sideways",
    means: "A lot of this path is driven sideways, which on mecanum wheels is slower and stops less sharply than driving forward. The message says how many seconds it costs.",
    fix: "Use the fix that points the nose along the path, or turn during the previous stop. Keep sideways driving for short, deliberate moves.",
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
    means: "This step's timeout is close to how long it is expected to take. A slightly slow run would be cut off before it finishes.",
    fix: "Raise the step's timeout to at least a little more than its estimate. The estimate is shown beside the step.",
  },
  STATIONARY_MARKER: {
    title: "Stop-only command while moving",
    means: "A command that needs the robot to stand still is set to fire in the middle of a path. It would run while the robot is still driving.",
    fix: "Make it its own step after the path instead of a marker on it.",
  },
  MOVES_ROBOT: {
    title: "Start after a moving command",
    means: "The step before this one moves the robot by itself, so nobody knows exactly where it ends. This path assumes a fixed starting point anyway.",
    fix: "Set this path's start to \"current\" so it begins wherever the robot really is.",
  },
  PROVENANCE: {
    title: "Where did this come from?",
    means: "A pose has no note saying where its numbers came from, such as measured on the field or set in the editor. This is only a reminder, not an error.",
    fix: "Nothing is required. Measure the pose on the field or save it as a named waypoint to record where it came from.",
  },
};
