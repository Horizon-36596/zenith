/**
 * Which finding the problems panel's pointer or focus is on, so the canvas can emphasise that
 * finding's clip ghost (`canvas/clipGhosts.ts`). A view concern only, like the inspector's hovered
 * heading range: it is not part of the document, the undo stack or the editor store, and nothing
 * is saved. The value is `findingKey(finding)`.
 */
import { useSyncExternalStore } from "react";

let hovered: string | null = null;
const listeners = new Set<() => void>();

export function setHoveredFinding(next: string | null): void {
  if (next === hovered) return;
  hovered = next;
  for (const listener of listeners) listener();
}

export const getHoveredFinding = (): string | null => hovered;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useHoveredFinding = (): string | null => useSyncExternalStore(subscribe, getHoveredFinding);
