/**
 * Every piece of help text the shell shows, in one table per surface, written for someone who has
 * never planned an FTC path (site/docs/editor.md). Panels and inspector sections
 * read `PANEL_HELP`, the insert menu reads `INSERT_HELP`, and the findings panel reads
 * `findingHelp`. `help.test.ts` fails when a panel, a section, a toolbar button or a finding code
 * has no entry, so a new surface cannot ship without its explanation.
 */
import { FINDING_HELP, type FindingHelp } from "@horizon36596/zenith-core";

export type { FindingHelp };

export interface HelpEntry {
  title: string;
  /** One or two plain sentences: what this is for, not how it is built. */
  body: string;
}

/** Panel headers and inspector sections, by the id the `?` affordance is given. */
export const PANEL_HELP = {
  field: {
    title: "Field",
    body: "The FTC field seen from above, with your routine drawn on it. Drag a point to move where the robot drives; the outline shows the robot's size.",
  },
  steps: {
    title: "Steps",
    body: "The routine, in the order the robot runs it, top to bottom. Click a step to edit it; drag a step to reorder it or to move it into a group.",
  },
  timeline: {
    title: "Timeline",
    body: "How long each step takes, against the 30 second autonomous period. Drag the scrubber or press Play to watch the robot. Playback picks its source: Ideal (the planned path exactly), Instant sim (a rough estimate) or Full sim (the robot code's own sim).",
  },
  ledger: {
    title: "Ledger",
    body: "What the robot is carrying after each step: game pieces picked up and scored. It is how Zenith knows a shot has something to shoot.",
  },
  findings: {
    title: "Problems",
    body: "Everything Zenith noticed that could go wrong on the real field, worst first. Click one to jump to its step; some have a one-click fix.",
  },
  changes: {
    title: "Changed steps",
    body: "Every step the proposal adds, removes or changes, against the version it started from. Click one to see both on the field.",
  },
  inspector: {
    title: "Inspector",
    body: "Every setting of the selected step. Pick a step in the list or on the field, then change its numbers here.",
  },
  "section.step": {
    title: "Step",
    body: "How long this step is expected to take, an optional time limit, and notes for your team.",
  },
  "section.segment": {
    title: "Segment",
    body: "One leg of the drive: where it starts, where it ends, and whether it is a straight line or a curve.",
  },
  "section.heading": {
    title: "Heading",
    body: "Which way the robot faces while it drives, by Pedro Pathing's names. Hover a mode to see what it does. Piecewise uses a different mode on each stretch of the path. Drag the arrows on the path to set the angles.",
  },
  "section.speed": {
    title: "Speed and end",
    body: "How fast this drive goes, as a share of the robot's top speed, and an optional sensor condition that ends it early.",
  },
  "section.markers": {
    title: "Markers",
    body: "Commands that fire partway along this path without stopping, such as starting the intake as you approach a piece.",
  },
  "section.command": {
    title: "Command",
    body: "An action from your robot's code, such as running the intake or shooting. The list comes from robot.json.",
  },
  "section.wait": {
    title: "Wait",
    body: "Pause for a number of seconds, or until a sensor condition from robot.json becomes true.",
  },
  "section.parallel": {
    title: "Parallel group",
    body: "Steps that run at the same time. All waits for every one; race ends when the first finishes; deadline ends when the one you pick finishes.",
  },
  "section.sequence": {
    title: "Sequence",
    body: "Steps that run one after another as a single block. Useful inside a parallel group, where one lane needs several steps.",
  },
  "section.branch": {
    title: "Branch",
    body: "Runs one set of steps if a condition is true and another if it is not, such as skipping a pickup when the robot is already full.",
  },
  "section.start": {
    title: "Start of the routine",
    body: "Where the robot is placed on the field before autonomous begins. Every path that says 'continue from the last step' starts here first.",
  },
} as const satisfies Record<string, HelpEntry>;

export type PanelHelpId = keyof typeof PANEL_HELP;

/** The step kinds the insert menu offers, with the one-line tooltip each one carries. */
export const INSERT_HELP = {
  path: {
    title: "Path",
    body: "Drive to a new point, starting where the selected step ends.",
  },
  command: {
    title: "Command",
    body: "Run an action from your robot's code, such as the intake or the launcher.",
  },
  wait: {
    title: "Wait",
    body: "Pause for some seconds, or until a sensor says something happened.",
  },
  sequence: {
    title: "Sequence",
    body: "A block of steps that run one after another.",
  },
  parallel: {
    title: "Parallel",
    body: "Steps that run at the same time, such as driving while the intake spins.",
  },
  branch: {
    title: "Branch",
    body: "Do one thing if a condition is true and another if it is not.",
  },
} as const satisfies Record<string, HelpEntry>;

export type InsertKind = keyof typeof INSERT_HELP;

/**
 * What a finding code means and how to fix it: core's `FINDING_HELP`, which the CLI's
 * `validate --explain` and the MCP server print as well, so all three say the same thing.
 */
export function findingHelp(code: string): FindingHelp | null {
  return (FINDING_HELP as Readonly<Record<string, FindingHelp | undefined>>)[code] ?? null;
}
