/**
 * Back and forward between screens (issue #83). On Windows a mouse's side buttons, and a keyboard's
 * Back and Forward keys, reach the window as `app-command` events named `browser-backward` and
 * `browser-forward`. Main forwards those two, and nothing else, to the page, which goes back or
 * forward through its own history of screens (apps/web/src/app/navigation.ts). The page also hears
 * the side buttons as mouse events, and counts a press that arrives both ways once.
 *
 * Kept free of Electron so the mapping can be tested without a window.
 */
import type { DesktopNavigation } from "../../../web/src/project/desktopBridge.js";

/** The direction an `app-command` names, or null for every other command (media keys, search, and so on). */
export function appCommandDirection(command: string): DesktopNavigation | null {
  if (command === "browser-backward") return "back";
  if (command === "browser-forward") return "forward";
  return null;
}

/** Sends `command` on to the page when it is back or forward. True when it was sent. */
export function forwardAppCommand(command: string, send: (direction: DesktopNavigation) => void): boolean {
  const direction = appCommandDirection(command);
  if (direction === null) return false;
  send(direction);
  return true;
}
