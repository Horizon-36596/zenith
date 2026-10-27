/**
 * The two zoom items that end every field menu, and the way something outside the canvas asks the
 * canvas to run them. The Inspector's Waypoints list opens a pin's menu from its ⋯ button (issue
 * #245) with the same items a right-click on the pin shows, so both build them here, and the list's
 * items send `CANVAS_ZOOM_EVENT`, which the canvas answers with the zoom its own items run.
 */
import { Maximize, ZoomIn } from "lucide-react";
import { CANVAS_TOOLTIPS } from "./help.js";
import type { CanvasAction, CanvasMenuTarget } from "./types.js";

/** The window event that asks the canvas to zoom: to the selection, or to fit the whole routine. */
export const CANVAS_ZOOM_EVENT = "zenith:canvas-zoom";

export type CanvasZoom = "selection" | "fit";

/** Asks the canvas to zoom, as its F key or its Zoom to fit item does. */
export function requestCanvasZoom(to: CanvasZoom): void {
  window.dispatchEvent(new CustomEvent<CanvasZoom>(CANVAS_ZOOM_EVENT, { detail: to }));
}

/** The menu's zoom items for a target: "Zoom to it" for a pin, else "Zoom to selection", then "Zoom to fit". */
export function zoomItems(kind: CanvasMenuTarget["kind"], run: Record<CanvasZoom, () => void>): CanvasAction[] {
  return [
    {
      id: "canvas.zoomSelection",
      label: kind === "waypoint" ? "Zoom to it" : CANVAS_TOOLTIPS.zoomSelection.label,
      icon: ZoomIn,
      shortcut: CANVAS_TOOLTIPS.zoomSelection.shortcut,
      enabled: true,
      run: run.selection,
    },
    // No key in the shortcut column (issue #412): a double-click means three things on the field.
    // Maximize, as the field's own Zoom to fit button draws it.
    { id: "canvas.fit", label: CANVAS_TOOLTIPS.zoomFit.label, icon: Maximize, enabled: true, run: run.fit },
  ];
}
