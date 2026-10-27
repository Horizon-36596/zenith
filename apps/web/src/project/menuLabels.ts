/**
 * The native menu's words for the items that run one of the web build's actions: the palette's own
 * label for that action, with the `&` that marks the menu's access key, and a trailing `…` where the
 * item opens a dialog or a picker (UI_GUIDE "One thing, many names"). `menuLabels.test.ts` holds each
 * one to its action's label in `app/actions.ts`, so the menu and the palette cannot drift apart.
 *
 * Kept free of anything but strings, because the desktop app's main process imports it (main/menu.ts).
 */
export const MENU_LABELS = {
  "project.open": "Open &project…",
  "project.openFolder": "&Open a folder…",
  "project.example": "Open the &example",
  "run.save": "&Save",
  "edit.undo": "&Undo",
  "edit.redo": "&Redo",
  "view.palette": "&Search actions",
  "help.docs": "&Documentation",
  "help.tour": "&Take the tour",
  "help.fullTour": "Take the &full tour",
  "help.shortcuts": "Keyboard &shortcuts",
  "desktop.sim": "Run &high-fidelity sim",
  "desktop.deploy": "&Deploy autos into the robot repo",
  "desktop.git": "Commit, push and open a &pull request…",
} as const;

export type MenuLabelId = keyof typeof MENU_LABELS;

/** A menu label as the palette shows it: no access-key marker and no trailing ellipsis. */
export const plainMenuLabel = (label: string): string => label.replace(/&(?!&)/g, "").replace(/…$/, "");
