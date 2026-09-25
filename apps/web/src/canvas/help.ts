/**
 * Every gesture and modifier the field canvas understands, as data, so the tour, the help overlay
 * and the tooltips all say the same thing the canvas does (site/docs/editor.md). The canvas's
 * behaviour is the source of truth; when it changes, this table changes in the same commit.
 *
 * Wording: sentence case, plain words for someone new to FTC pathing, one sentence each.
 */

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
  { id: "select", gesture: "Click", action: "Select a point, a marker or a path.", context: "select" },
  { id: "addToSelection", gesture: "Shift + click", action: "Add a point to the selection, or take it out.", context: "select" },
  { id: "marquee", gesture: "Drag on empty field", action: "Draw a box and select every point inside it. Hold Shift to add to the selection.", context: "select" },
  { id: "groupDrag", gesture: "Drag a point", action: "Move it, even on a step that is not selected; a selected point carries the others.", context: "select" },
  { id: "clear", gesture: "Esc", action: "Clear the selection, the measurement or an open menu.", context: "any" },
  { id: "invertSnap", gesture: "Hold Ctrl while dragging", action: "Flip the snap toggle for this drag: snap when it is off, move freely when it is on.", context: "drag" },
  { id: "noQuantise", gesture: "Hold Alt while dragging", action: "Turn off the grid and the 15° heading steps only; waypoints and walls still snap.", context: "drag" },
  { id: "axis", gesture: "Hold Shift while dragging a point", action: "Move along one field axis only.", context: "drag" },
  { id: "heading45", gesture: "Hold Shift while turning a heading", action: "Turn in 45° steps.", context: "heading drag" },
  { id: "breakMirror", gesture: "Hold Shift while dragging a curve handle", action: "Move this handle alone, without swinging the one opposite it.", context: "handle drag" },
  { id: "wallSnap", gesture: "Drag a point near a wall", action: "The robot rests flush against the wall, intakes included, so it never leaves the field.", context: "drag" },
  { id: "headingHandle", gesture: "Drag a heading arrow", action: "Turn the path's heading: a Constant's two arrows turn together, a Linear's start and end turn apart.", context: "select" },
  { id: "rangeBoundary", gesture: "Drag a tick across the path", action: "Move the boundary between two heading ranges along the path.", context: "select" },
  { id: "splitHeading", gesture: "Right-click a path, Split heading here", action: "Cut the heading into two ranges there, each with its own mode.", context: "select" },
  { id: "smooth", gesture: "S", action: "Make the selected curve point smooth: its two handles stay in a line.", context: "select" },
  { id: "corner", gesture: "C", action: "Make the selected curve point a corner: its handles move on their own.", context: "select" },
  { id: "contextMenu", gesture: "Right-click", action: "Open the menu for a point, a path or the field.", context: "any" },
  { id: "splitPath", gesture: "Double-click a path", action: "Add a point there, splitting the segment in two.", context: "select" },
  { id: "addPoint", gesture: "Click or double-click the field", action: "Add a path point, continuing from the last one or from the step you are inserting after.", context: "addPath" },
  { id: "hover", gesture: "Hover a path", action: "Show the robot there, with how far along the step it is and when it gets there.", context: "any" },
  { id: "measure", gesture: "U, then drag", action: "Measure the distance and angle between two points. Shift keeps the angle to 45° steps.", context: "measure" },
  { id: "pan", gesture: "Space + drag, or middle-drag", action: "Pan the field.", context: "any" },
  { id: "zoom", gesture: "Scroll", action: "Zoom about the pointer.", context: "any" },
  { id: "zoomSelection", gesture: "F", action: "Zoom to the selection, or to the whole routine when nothing is selected.", context: "any" },
  { id: "fit", gesture: "Double-click empty field", action: "Fit the whole field in view.", context: "select" },
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
  smooth: { label: "Smooth point", shortcut: "S", detail: "Keep the two curve handles at this point in a line." },
  corner: { label: "Corner point", shortcut: "C", detail: "Let the two curve handles at this point move on their own." },
} as const;

/** The keys the canvas itself handles while it has focus, for the shell's keyboard map to skip. */
export const CANVAS_KEYS = {
  smooth: "S",
  corner: "C",
  zoomSelection: "F",
  clear: "Esc",
} as const;
