/**
 * The tour's content. Each stop names a `data-tour` anchor in the shell, a title, one or two plain
 * sentences, and optionally a thing to try that moves the tour on by itself. The core tour covers
 * what someone needs to make their first edit; the full tour covers every feature.
 */
import { modifierSentence } from "../help/canvasHelp";
import { SHORTCUTS } from "../app/shortcuts";
import type { TourStop, TourStops } from "./model";

export const CORE_STOPS: readonly TourStop[] = [
  {
    id: "field",
    anchor: "field",
    title: "This is the field",
    body: "The FTC field from above, with an example routine on it. The dots are where the robot drives to, and the outline is the robot itself.",
    task: { label: "Try it: drag one of the dots on the path.", signal: "pointDragged" },
    side: "right",
  },
  {
    id: "steps",
    anchor: "steps",
    title: "The steps",
    body: "The robot runs these top to bottom. A step drives a path, runs a command, waits, or groups other steps.",
    task: { label: "Try it: click a step to select it.", signal: "stepSelected" },
    side: "right",
  },
  {
    id: "insert",
    anchor: "insert",
    title: "Add a step",
    body: "Insert puts a new step straight after the selected one. A new path starts where that step ends, so you can add to the middle of a routine.",
    task: { label: "Try it: open Insert and add a Path.", signal: "stepInserted" },
    side: "right",
  },
  {
    id: "inspector",
    anchor: "inspector",
    title: "The inspector",
    body: "Every setting of the selected step: where it goes, which way the robot faces, how fast. Hover a ? for what a section means.",
    prepare: "selectFirstPath",
    side: "left",
  },
  {
    id: "findings",
    anchor: "findings",
    title: "Problems",
    body: "Zenith checks the routine as you edit: hitting a wall, running out of time, shooting with nothing loaded. Click a problem to jump to its step.",
    side: "top",
  },
  {
    id: "run",
    anchor: "run",
    title: "Play and save",
    body: `Play shows the robot running the routine, and Save writes the file back to your robot's repository.`,
    task: { label: `Try it: press ${SHORTCUTS.playPause} to play.`, signal: "playToggled" },
    side: "bottom",
  },
];

export const FULL_STOPS: readonly TourStop[] = [
  {
    id: "tool.select",
    anchor: "tool.select",
    title: "Select",
    body: `Click things on the field to select them and drag them to move them. ${SHORTCUTS.select} switches back to it from any tool.`,
    side: "bottom",
  },
  {
    id: "tool.addPath",
    anchor: "tool.addPath",
    title: "Add path",
    body: "Click the field to add a drive to that point. It continues from the selected step, so select a step first to add in the middle. C does the same for a command.",
    task: { label: `Try it: press ${SHORTCUTS.addPath}.`, signal: "toolChanged" },
    side: "bottom",
  },
  {
    id: "tool.marker",
    anchor: "tool.marker",
    title: "Marker",
    body: "Click a path to fire a command partway along it without stopping, such as starting the intake as the robot arrives.",
    side: "bottom",
  },
  {
    id: "tool.heading",
    anchor: "tool.heading",
    title: "Heading arrows",
    body: "The arrows at a path's ends show which way the robot faces; drag one to turn it. Constant arrows turn together, Linear ones apart, Tangent ones follow the path and do not drag, and right-clicking a path offers Split heading here.",
    task: { label: "Try it: drag one of the heading arrows on the selected path.", signal: "headingTurned" },
    prepare: "selectPathWithHeadingArrows",
    keepClear: ["field"],
    side: "bottom",
  },
  {
    id: "tool.measure",
    anchor: "tool.measure",
    title: "Measure",
    body: "Drag between two points on the field to read the distance and the angle between them. U picks it.",
    side: "bottom",
  },
  {
    id: "view.snap",
    anchor: "view.snap",
    title: "Snap",
    body: `Points stop at waypoints, walls and a grid, and headings at 15°. ${modifierSentence()}`.trim(),
    task: { label: `Try it: press ${SHORTCUTS.snap} to turn snap off and on.`, signal: "snapToggled" },
    side: "bottom",
  },
  {
    id: "section.heading",
    anchor: "section.heading",
    title: "Heading modes",
    body: "Tangent faces the way the robot drives, Constant holds one angle, Linear turns between two and Facing point keeps looking at a spot. Piecewise gives each stretch of the path its own mode.",
    prepare: "selectFirstPath",
    side: "left",
  },
  {
    id: "section.markers",
    anchor: "section.markers",
    title: "Markers",
    body: "Each marker is a command fired at a point along this path. Drag its pin on the field, or set where it fires here.",
    prepare: "selectPathWithMarker",
    side: "left",
  },
  {
    id: "groups",
    anchor: "insert",
    title: "Groups",
    body: "Parallel runs steps at the same time, Sequence chains them into one block, and Branch picks between two sets on a condition. Right-click steps to wrap them in a group.",
    side: "right",
  },
  {
    id: "timeline",
    anchor: "timeline",
    title: "Timeline",
    body: "Each bar is one step's time, against the autonomous period. A striped bar has no estimate yet. Drag the scrubber to move the robot through the routine.",
    side: "right",
  },
  {
    id: "ledger",
    anchor: "ledger",
    title: "Ledger",
    body: "What the robot is holding after each step. It is how Zenith catches a shot with nothing loaded or a robot carrying too much.",
    side: "right",
  },
  {
    id: "provenance",
    anchor: "provenance",
    title: "Where a number came from",
    body: "Each position carries a label: Measured on the real field, Set from editor when dragged here, Placeholder until someone checks it on the robot.",
    prepare: "selectPathWithPose",
    side: "left",
  },
  {
    id: "findings.fixes",
    anchor: "findings",
    title: "Fixing problems",
    body: "Hover a problem's code for what it means and how to fix it. When Zenith knows the fix, a button on the row applies it.",
    side: "top",
  },
  {
    id: "view.alliance",
    anchor: "view.alliance",
    title: "The other alliance",
    body: "Shows the routine mirrored for the other alliance. You always edit one side; the robot mirrors it at match time.",
    task: { label: `Try it: press ${SHORTCUTS.alliance}.`, signal: "allianceToggled" },
    side: "bottom",
  },
  {
    id: "run.simulate",
    anchor: "run.simulate",
    title: "Simulate",
    body: "Runs the routine through the robot's own simulator and lays the recorded drive over the plan, so you can compare them.",
    side: "bottom",
  },
  {
    id: "run.propose",
    anchor: "run.propose",
    title: "Share with GitHub",
    body: "When the project comes from GitHub, Propose commits the auto and a picture of it, and opens a pull request for the team to review.",
    side: "bottom",
  },
  {
    id: "context",
    anchor: "field",
    title: "Right-click menus",
    body: "Right-click a point, a path, a step or empty field for the actions that apply there, each with its shortcut.",
    side: "right",
  },
  {
    id: "palette",
    anchor: "palette",
    title: "Find any action",
    body: `${SHORTCUTS.palette} opens a search over every action, command, waypoint and auto in the project.`,
    task: { label: `Try it: press ${SHORTCUTS.palette}.`, signal: "paletteOpened" },
    side: "bottom",
  },
  {
    id: "help",
    anchor: "help",
    title: "Shortcuts and help",
    body: `${SHORTCUTS.help} lists every shortcut and gesture. The help menu replays this tour whenever you want it.`,
    prepare: "closeMenus",
    side: "bottom",
  },
];

export const TOUR_STOPS: TourStops = { core: CORE_STOPS, full: FULL_STOPS };
