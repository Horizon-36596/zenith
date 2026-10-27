/**
 * Descriptions of the Inspector's rows (issue #238). The Inspector lanes fill this table, and a row
 * takes an entry with `describe="inspector.…"`. Text that states a fact about the selection, warns,
 * names an empty state or explains an active tool mode is not a description: it stays in the
 * component and never collapses.
 */
import { keyLabel } from "../../app/shortcuts";
import type { Description } from "./types";

export const INSPECTOR_DESCRIPTIONS = {
  "inspector.estimated": {
    label: "Estimated",
    brief: "How long the plan expects this step to take",
    more: "'at most' means the time comes from the step's envelope, and 'what-if' from its Actual time.",
  },
  "inspector.strafeFraction": {
    label: "Strafe fraction",
    brief: "How much of this path the robot drives sideways",
    more: "From 0 to 1. Sideways is slower than nose first.",
  },
  "inspector.envelope": {
    label: "Envelope",
    brief: "Optional: where you stay, for partners",
    more: "A box your robot promises to stay inside during this step. Partners see it.",
  },
  "inspector.rejoin": {
    label: "Rejoin",
    brief: "Where this path picks the robot up again",
    more: "The step before drives the robot by itself, so set the pose the robot usually ends at.",
  },
  // Rows 12 to 16 of the description rewrite (issue #241): the path chain's own words.
  // Each row's brief shows once in an Inspector (issue #409): From and To have their own, and a
  // later path of a chain takes the To entry with no brief.
  "inspector.endSource": {
    label: "From",
    brief: "Where this path starts",
    more: "The end before it, a pose of its own, or a waypoint it follows. Moving a waypoint moves every end that follows it.",
  },
  "inspector.endSourceTo": {
    label: "To",
    brief: "Where this path ends",
    more: "A pose of its own, or a waypoint it follows. Moving a waypoint moves every end that follows it.",
  },
  "inspector.endSourceLater": {
    label: "To",
    more: "Where this path of the chain ends: a pose of its own, or a waypoint it follows.",
  },
  "inspector.headingMode": {
    label: "Mode",
    brief: "Which way the robot faces as it drives",
    more: "Hover a choice to see what it does. Tangent follows the path; Linear and Constant hold angles you type.",
  },
  "inspector.speed": {
    label: "Speed",
    brief: "How fast it drives, as a share of its top",
    more: "A share of the robot's velocity cap, not a power. Applied only if your ZenithRobot implements atSpeed.",
  },
  "inspector.endCondition": {
    label: "Stop early",
    brief: "A sensor condition that ends the drive",
    more: "The path ends as soon as this condition from robot.json is true, short of its end. Never drives it all the way.",
  },
  "inspector.pointHeading": {
    label: "Heading",
    brief: "Which way the robot faces at this end",
    // Turn's keys as the person has them (issue #290), read each time the hint shows. The turn is
    // the person's own Rotate setting (`editing.rotateDeg`).
    get more(): string {
      const turn = keyLabel("rotate")?.replace(" / ", " or ");
      return turn === undefined
        ? "Tangent follows the path. Linear lets you type it."
        : `Tangent follows the path. Linear lets you type it, and ${turn} turns it by your Rotate setting.`;
    },
  },
  // Rows 17 to 20 of the description rewrite (issue #242): the other kinds' own words.
  "inspector.standsStill": {
    label: "Stands still",
    more: "The robot must stand still while it runs.",
  },
  "inspector.waitUntil": {
    label: "Until",
    more: "Give up after, under it, caps the wait.",
  },
  "inspector.plannerOnly": {
    label: "Planner only",
    more: "The robot waits 0 s here. The generated code keeps it as a comment.",
  },
  "inspector.sequenceSteps": {
    label: "Steps",
    brief: "Run in order, as one block",
    more: "Select one by its row. Drag steps onto the group in the list to add them; right-click it and choose Unwrap to take them out.",
  },
  "inspector.parallelSteps": {
    label: "Steps",
    brief: "Run at the same time",
    more: "Select one by its row. Drag steps onto the group in the list to add them.",
  },
  "inspector.addMarker": {
    label: "Add marker",
    more: "Adds one at the middle of this path. Or pick the Marker tool (M) and click the path.",
  },
} as const satisfies Record<`inspector.${string}`, Description>;
