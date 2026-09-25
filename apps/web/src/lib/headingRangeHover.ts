/**
 * Which piecewise heading range the inspector's pointer is over, so the canvas can light up that
 * stretch of the path (site/docs/editor.md, "Inspector"). A view concern only: it is not
 * part of the document, the undo stack or the editor store, and nothing is saved.
 */
import { useSyncExternalStore } from "react";

export interface HoveredRange {
  stepId: string;
  startT: number;
  endT: number;
}

let hovered: HoveredRange | null = null;
const listeners = new Set<() => void>();

export function setHoveredRange(next: HoveredRange | null): void {
  const same =
    next === hovered ||
    (next !== null &&
      hovered !== null &&
      next.stepId === hovered.stepId &&
      next.startT === hovered.startT &&
      next.endT === hovered.endT);
  if (same) return;
  hovered = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useHoveredRange = (): HoveredRange | null => useSyncExternalStore(subscribe, () => hovered);
