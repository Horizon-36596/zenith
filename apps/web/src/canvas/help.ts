/**
 * Every gesture and modifier the field canvas understands, as data, so the tour, the help overlay
 * and the tooltips all say the same thing the canvas does (site/docs/editor.md). The canvas's
 * behaviour is the source of truth; when it changes, this table changes in the same commit.
 *
 * Wording: sentence case, plain words for someone new to FTC pathing, one sentence each.
 */
import type { Alliance, Tool } from "./types.js";

export interface CanvasHelpEntry {
  /** Stable id, for a tour stop or a test to point at. */
  id: string;
  /** What the user does, keys in the display form the shortcut table uses. */
  gesture: string;
  /** What happens. */
  action: string;
  /** Which tool or situation it applies in. */
  context: "any" | "select" | "addPath" | "measure" | "drag" | "heading drag" | "handle drag";
}

export const CANVAS_HELP: readonly CanvasHelpEntry[] = [
  { id: "select", gesture: "Click", action: "Select a point, marker or path. Alt + click: the next overlapping path.", context: "select" },
  { id: "addToSelection", gesture: "Shift + click", action: "Add a point to the selection, or take it out.", context: "select" },
  { id: "marquee", gesture: "Drag on empty field", action: "Draw a box and select every point inside it. Hold Shift to add to the selection.", context: "select" },
  { id: "groupDrag", gesture: "Drag a point or a waypoint pin", action: "Move it and select it; a selected point carries the others, a pin the points after it.", context: "select" },
  { id: "startPose", gesture: "Drag the start mark", action: "Move the start, keeping its heading, with any path that starts on it. Drag its arrow to turn it; click it to nudge it. A start that follows a waypoint stops following it.", context: "select" },
  { id: "clear", gesture: "Esc", action: "Cancel a drag, close a menu, clear the measurement, leave a tool for Select, or clear the selection.", context: "any" },
  { id: "invertSnap", gesture: "Hold Ctrl while dragging", action: "Flip the snap toggle for this drag: snap when it is off, move freely when it is on.", context: "drag" },
  { id: "noQuantise", gesture: "Hold Alt while dragging", action: "Turn off the grid and the 15° heading steps only; waypoints and walls still snap.", context: "drag" },
  { id: "axis", gesture: "Hold Shift while dragging a point", action: "A path end stays on a line from its other end; the start and pins, on one axis.", context: "drag" },
  { id: "heading45", gesture: "Hold Shift while turning a heading", action: "Turn in 45° steps.", context: "heading drag" },
  { id: "breakMirror", gesture: "Hold Shift while dragging a curve handle", action: "Move this handle alone, without swinging the one opposite it.", context: "handle drag" },
  { id: "wallSnap", gesture: "Drag a point near a wall or waypoint", action: "Walls: the robot rests flush, intakes included. A waypoint pin: a path end follows it.", context: "drag" },
  { id: "headingHandle", gesture: "Drag a heading arrow", action: "Turn the heading: a Constant's two arrows turn together, a Linear's ends apart.", context: "select" },
  { id: "rangeBoundary", gesture: "Drag a tick across the path", action: "Move the boundary between two heading ranges along the path.", context: "select" },
  { id: "envelopeEdit", gesture: "Drag an envelope corner, side or inside", action: "Resize or move the selected step's envelope. It snaps like a point.", context: "select" },
  { id: "pathMenu", gesture: "Right-click a path", action: "Split heading here cuts the heading; Make curve bends it; Turn on the spot turns after it.", context: "select" },
  { id: "smooth", gesture: "S", action: "Make the selected curve point smooth: its two handles stay in a line.", context: "select" },
  { id: "corner", gesture: "C", action: "Make the selected curve point a corner: its handles move on their own.", context: "select" },
  { id: "contextMenu", gesture: "Right-click", action: "Open the menu for a point, path, pin or the field.", context: "any" },
  { id: "splitPath", gesture: "Double-click a path or pin", action: "Split a path, Del rejoins it. A pin: rename (F2).", context: "select" },
  { id: "addPoint", gesture: "Click the field", action: "Add a path to the dashed line after the selected step, or to its chain with Extend this chain on. The tool stays on until Esc.", context: "addPath" },
  { id: "hover", gesture: "Hover a path", action: "Show the robot there, how far along the step it is and when.", context: "any" },
  { id: "measure", gesture: "U, then drag", action: "Measure the distance and angle between two points; Shift keeps 45° steps.", context: "measure" },
  { id: "pan", gesture: "Middle-drag, Ctrl + right-drag, or Space + drag", action: "Pan the field, as in Onshape.", context: "any" },
  { id: "zoom", gesture: "Scroll", action: "Zoom about the pointer.", context: "any" },
  { id: "zoomSelection", gesture: "F", action: "Zoom to the selection, or to the whole routine when nothing is selected.", context: "any" },
  { id: "fit", gesture: "Double-click empty field", action: "Fit the field board and the routine in view.", context: "select" },
];

/** Tooltip text for the canvas's own controls and the tools the shell shows for it. */
export const CANVAS_TOOLTIPS = {
  measure: { label: "Measure", shortcut: "U", detail: "Drag to measure a distance and an angle. Esc clears it." },
  playPause: { label: "Play / pause", shortcut: "Space", detail: "Play the routine on the field." },
  fieldView: {
    label: "Field view",
    shortcut: "",
    detail: "Show the field picture, the picture with the outlines the checks use, or the outlines only.",
  },
  zoomSelection: { label: "Zoom to selection", shortcut: "F", detail: "Frame the selected points, or the whole routine." },
  zoomFit: { label: "Zoom to fit", shortcut: "", detail: "Frame the field board again. Double-click empty field does the same." },
  zoomIn: { label: "Zoom in", shortcut: "", detail: "Zoom in about the middle of the field view." },
  zoomOut: { label: "Zoom out", shortcut: "", detail: "Zoom out about the middle of the field view." },
  smooth: { label: "Make smooth", shortcut: "S", detail: "Keep the two curve handles at this point in a line." },
  corner: { label: "Make corner", shortcut: "C", detail: "Let the two curve handles at this point move on their own." },
} as const;

/** The keys the canvas itself handles while it has focus, for the shell's keyboard map to skip. */
export const CANVAS_KEYS = {
  smooth: "S",
  corner: "C",
  zoomSelection: "F",
  clear: "Esc",
} as const;

/**
 * The one hint line at the top of the field while a tool other than Select is on (issue #412): what
 * the tool does and how to leave it. With Add path armed and a step selected, it names the step the
 * new path goes after (`anchorStepId`). Select and the pan hand show none. While Add waypoint waits
 * for its click (`placingWaypoint`), the line says so whatever the tool, for as long as it waits,
 * since that click opens Add waypoint and not what the tool does (issue #505).
 */
export function toolHintLine(tool: Tool, anchorStepId: string | null, placingWaypoint = false): string | null {
  if (placingWaypoint) return PLACE_WAYPOINT_HINT;
  switch (tool) {
    case "addPath":
      return anchorStepId === null
        ? "Add path: click the field to add a path at the end. Esc to finish"
        : `Add path: click the field to add a path after ${anchorStepId}. Esc to finish`;
    case "addCommand":
      return "Add command: click the field to add a command. Esc to finish";
    case "marker":
      return "Marker: click a path to drop a marker. Esc to finish";
    case "heading":
      return "Heading: drag a heading arrow of the selected path. Esc to finish";
    case "measure":
      return "Measure: drag between two points. Esc to finish";
    default:
      return null;
  }
}

/** The field's line while Add waypoint waits for the click that places the waypoint. */
export const PLACE_WAYPOINT_HINT = "Add waypoint: click the field to place it. Esc to cancel";

/** The field's banner while it shows the other alliance (issue #412), naming the auto edits go to. */
export const mirrorBannerLine = (fileAlliance: Alliance): string => `Mirrored preview. Edits apply to the ${fileAlliance} auto.`;

/** The tools that draw on the field, which a mirrored preview turns off (issue #412). */
export const DRAWING_TOOLS: ReadonlySet<Tool> = new Set<Tool>(["addPath", "addCommand", "marker", "heading"]);
