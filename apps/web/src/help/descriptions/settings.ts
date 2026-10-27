/**
 * Descriptions of the Settings rows (issues #238 and #246). A row takes an entry with
 * `describe="settings.…"`. By decision desc-default (b), the feature switches keep their one-line
 * description in both modes as `description` props, and the two project rows, Command library and
 * Pathing system, keep their brief in both modes (`always` on the row). Rows whose label says it all
 * (Theme, Ledger counts) have no description. Both project rows are under Follower in Robot (issue #414).
 */
import type { Description } from "./types";

export const SETTINGS_DESCRIPTIONS = {
  "settings.descriptions": {
    label: "Descriptions",
    brief: "A short line under each label, as here",
    more: "Labels only keeps the panels short. Either way, hover a label for a second or press Shift F1 to read what it does.",
  },
  "settings.commandLibrary": {
    label: "Command library",
    brief: "The runtime your code imports",
    more: "Every auto needs one, even paths only. Switching keeps your autos.",
  },
  "settings.pathingSystem": {
    label: "Pathing system",
    brief: "The path follower",
    more: "The only one Zenith supports. RoadRunner and MeepMeep paths come in through Import.",
  },
  "settings.fieldGrid": {
    label: "Grid",
    brief: "Tile seams, and finer lines over them",
    more: "Off draws the floor alone, Tiles the 24 in seams, 12 in and 6 in add lines between. Snap does not follow it.",
  },
  "settings.defaultHeading": {
    label: "Heading for new paths",
    brief: "How a new path turns the robot",
    more: "Tangent faces the way it drives, Linear turns to the end's heading, Constant holds the arrival heading. Paths you add from now on; never saved in a file.",
  },
  "settings.newPathKeepsHeading": {
    label: "Start a new path with the previous path's end heading",
    brief: "A new path starts at the last heading",
    more: "A new path starts at the heading the robot already has; a Linear one keeps it until you change it. Constant holds it. Tangent is unaffected.",
  },
  "settings.protectMeasuredPins": {
    label: "Protect measured waypoints",
    brief: "A measured pin selects before it moves",
    more: "A MEASURED or CALIBRATED FROM ROBOT pin only selects on its first press; the next press-drag moves it. Typing a number is always allowed.",
  },
  // The heading holds' rows (0.1.2 UX sweep, W1-15): a length, so "for" in the label, and a brief
  // in With descriptions, where they had none.
  "settings.holdStartHeading": {
    label: "Hold start heading for",
    brief: "How far the route keeps its starting heading",
    more: "Keeps the heading the robot starts with over the first this many inches of the route. 0 is off.",
  },
  "settings.holdEndHeading": {
    label: "Hold end heading for",
    brief: "How far before the end the heading is reached",
    more: "Reaches the heading the path ends with this many inches before its end, and keeps it. 0 is off.",
  },
  "settings.clipGhosts": {
    label: "Clip ghosts",
    more: "A red robot where a path leaves the field or hits a structure.",
  },
  "settings.clearanceOutline": {
    label: "Clearance outline",
    brief: "The robot's clearance from field elements",
    more: "A faint outline at the playhead, the footprint grown by the clearance in Settings, Robot. Only you see it; the CLEARANCE warning does not change.",
  },
} as const satisfies Record<`settings.${string}`, Description>;
