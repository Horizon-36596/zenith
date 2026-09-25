/**
 * Every action the editor has, once. The toolbar renders its groups from it, the command palette
 * lists all of it, the canvas and step-list context menus are built from it, and the keyboard
 * handler dispatches into it, so a tooltip, a palette row, a menu item and a shortcut can never
 * describe different behaviour.
 *
 * Every action says what it does in plain words (`does`), which is the second line of its tooltip,
 * and every action that can be disabled says why when it is (`whyDisabled`). `help.test.ts`
 * holds both to that.
 */
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  Binoculars,
  CirclePlay,
  CircleCheck,
  Compass,
  Copy,
  FlaskConical,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequestArrow,
  Cpu,
  Hourglass,
  Image,
  KeyRound,
  Keyboard,
  Layers,
  Map as MapIcon,
  ListOrdered,
  LogOut,
  Magnet,
  MapPin,
  Moon,
  MousePointer2,
  Palette,
  Plus,
  Redo2,
  Rocket,
  Ruler,
  Save,
  ScrollText,
  Search,
  Settings2,
  Spline,
  Timer,
  Trash,
  Undo2,
  Ungroup,
  Upload,
  Zap,
} from "lucide-react";
import {
  addParallelStep,
  addPathStep,
  addSequenceStep,
  addWaitStep,
  deleteSelection,
  duplicateSelection,
  unwrapSelection,
  wrapSelection,
  wrapTargets,
} from "./edits";
import { loadExample, openFolder, save, saveCopy, validate } from "./projectActions";
import { isDesktop } from "../project/desktop";
import { DESKTOP_ACTIONS } from "../project/desktopActions";
import { proposeBlockedReason, signOutOfGitHub } from "../github/actions";
import { SHORTCUTS, type ShortcutId } from "./shortcuts";
import { findEntry } from "../lib/stepOps";
import { unwrapBlockedReason } from "../lib/structure";
import {
  getState,
  redo,
  setDialog,
  setPaletteOpen,
  setPlaying,
  setPrefs,
  setTool,
  toggleAlliance,
  toggleSnap,
  toggleTheme,
  undo,
  type State,
} from "../state/store";
import { openInsertMenu } from "../state/ui";
import { startCoreTour, startFullTour } from "../tour/store";
import type { FieldView } from "../state/prefs";
import { isWritable } from "../project/types";
import { readFieldImage } from "../canvas/fieldImage";

export type ActionGroup = "tool" | "run" | "view" | "edit" | "insert" | "project" | "help";

export interface ActionDef {
  id: string;
  label: string;
  /** What the action does, in one plain sentence: the tooltip's second line. */
  does: string;
  /** Live detail worth knowing, such as which alliance is showing. */
  hint?: (state: State) => string | undefined;
  /** Why the action cannot run right now. Required whenever `enabled` is. */
  whyDisabled?: (state: State) => string;
  shortcut?: ShortcutId;
  /**
   * Other words a person might type in the palette for this action (QA-02): "tour" finds "Show me
   * everything". Every action has some; the palette matches them as well as the label and group.
   */
  keywords?: readonly string[];
  group: ActionGroup;
  icon: LucideIcon;
  run: () => void | Promise<void>;
  enabled?: (state: State) => boolean;
  active?: (state: State) => boolean;
}

const hasDocument = (state: State): boolean => state.auto !== null;
const hasSelection = (state: State): boolean => state.selection.stepId !== undefined;
const NO_DOCUMENT = (): string => "Open an auto first.";
const NO_SELECTION = (): string => "Select a step first.";
const READ_ONLY = "Review mode is read only.";

const canEdit = (state: State): boolean => hasDocument(state) && state.review === null;
const whyNoEdit = (state: State): string => (state.auto === null ? NO_DOCUMENT() : READ_ONLY);

const conditionsOf = (state: State) =>
  state.autoRobot?.conditions ?? state.project?.robot.conditions ?? [];

/** Why the selected step cannot be unwrapped, or null when it can. */
function unwrapReason(state: State): string | null {
  if (state.auto === null) return NO_DOCUMENT();
  if (state.selection.stepId === undefined) return NO_SELECTION();
  const entry = findEntry(state.auto, state.selection.stepId);
  if (entry === undefined) return NO_SELECTION();
  return unwrapBlockedReason(entry.step);
}

const FIELD_VIEWS: FieldView[] = ["image+outlines", "image", "vector"];
const FIELD_VIEW_LABEL: Record<FieldView, string> = {
  "image+outlines": "picture with outlines",
  image: "picture only",
  vector: "outlines only",
};

export const ACTIONS: ActionDef[] = [
  /* ---- The modal tools -------------------------------------------------- */
  {
    id: "tool.select",
    label: "Select",
    keywords: ["pointer", "arrow", "pick", "choose"],
    does: "Click to select a point, a path or a marker, and drag to move it.",
    shortcut: "select",
    group: "tool",
    icon: MousePointer2,
    run: () => {
      setTool("select");
    },
    active: (state) => state.tool === "select",
  },
  {
    id: "tool.addPath",
    label: "Add path",
    keywords: ["draw", "drive", "route", "trajectory", "leg", "segment"],
    does: "Click the field to drive to that point, continuing from the selected step.",
    shortcut: "addPath",
    group: "tool",
    icon: Spline,
    run: () => {
      setTool("addPath");
    },
    active: (state) => state.tool === "addPath",
  },
  {
    id: "tool.addCommand",
    label: "Add command",
    keywords: ["action", "mechanism", "intake", "shoot", "event"],
    does: "Click the field to add a command from the robot's code after the selected step.",
    shortcut: "addCommand",
    group: "tool",
    icon: Zap,
    run: () => {
      setTool("addCommand");
    },
    active: (state) => state.tool === "addCommand",
  },
  {
    id: "tool.marker",
    label: "Marker",
    keywords: ["event marker", "trigger", "timing", "flag"],
    does: "Click a path to fire a command at that point without stopping. Alt + ← → slides it.",
    shortcut: "marker",
    group: "tool",
    icon: MapPin,
    run: () => {
      setTool("marker");
    },
    active: (state) => state.tool === "marker",
  },
  {
    id: "tool.heading",
    label: "Heading",
    keywords: ["rotate", "turn", "angle", "facing", "direction"],
    does: "Drag the heading arrow nearest the pointer on the selected path. R and Shift R turn the selected point 5°.",
    shortcut: "heading",
    group: "tool",
    icon: Compass,
    run: () => {
      setTool("heading");
    },
    active: (state) => state.tool === "heading",
  },
  {
    id: "tool.measure",
    label: "Measure",
    keywords: ["ruler", "distance", "tape", "angle"],
    does: "Drag between two points on the field to read the distance and the angle. Shift keeps the angle to 45° steps.",
    shortcut: "measure",
    group: "tool",
    icon: Ruler,
    run: () => {
      setTool("measure");
    },
    active: (state) => state.tool === "measure",
  },
  {
    id: "view.snap",
    label: "Snap",
    keywords: ["grid", "align", "magnet"],
    does: "Points stop at waypoints, walls and the grid, and headings at 15°. Ctrl flips it for one drag.",
    shortcut: "snap",
    group: "tool",
    icon: Magnet,
    run: toggleSnap,
    active: (state) => state.prefs.snap,
  },

  /* ---- Run -------------------------------------------------------------- */
  {
    id: "run.validate",
    label: "Validate",
    keywords: ["check", "problems", "errors", "lint", "findings"],
    does: "Re-check the routine now. Zenith also checks after every edit.",
    shortcut: "validate",
    group: "run",
    icon: CircleCheck,
    run: validate,
    enabled: hasDocument,
    whyDisabled: NO_DOCUMENT,
  },
  {
    id: "run.simulate",
    label: "Simulate",
    keywords: ["sim", "test", "run", "trace"],
    does: "Run the robot repository's own simulator and lay the recorded drive over the plan.",
    shortcut: "simulate",
    group: "run",
    icon: Cpu,
    run: () => {
      setDialog("simulate");
    },
    enabled: hasDocument,
    whyDisabled: NO_DOCUMENT,
  },
  {
    id: "run.save",
    label: "Save",
    keywords: ["write", "store", "keep", "commit"],
    does: "Write the auto back to the robot repository.",
    shortcut: "save",
    group: "run",
    icon: Save,
    hint: (state) =>
      state.review === null &&
      state.auto !== null &&
      state.project !== null &&
      state.project !== undefined &&
      !isWritable(state.project.source) &&
      state.backend?.kind !== "github"
        ? "This project is read only, so Save downloads the file instead."
        : undefined,
    run: () => {
      // A commit needs a message, so GitHub mode asks for one before it writes (06 section 1).
      if (getState().backend?.kind === "github") setDialog("commit");
      else void save();
    },
    enabled: canEdit,
    whyDisabled: whyNoEdit,
  },
  {
    id: "run.propose",
    label: "Propose",
    keywords: ["pull request", "pr", "github", "review"],
    does: "Commit the auto and a picture of it to the work branch, and open a pull request.",
    shortcut: "propose",
    group: "run",
    icon: GitPullRequestArrow,
    run: () => {
      setDialog("propose");
    },
    enabled: (state) => proposeBlockedReason(state) === null,
    whyDisabled: (state) => proposeBlockedReason(state) ?? "",
  },

  /* ---- View state ------------------------------------------------------- */
  {
    id: "view.alliance",
    label: "Mirror to the other alliance",
    keywords: ["red", "blue", "flip", "side"],
    does: "Show the routine as the other alliance would run it. You still edit one side.",
    shortcut: "alliance",
    group: "view",
    icon: ArrowLeftRight,
    hint: (state) => (state.auto === null ? undefined : `Showing ${state.alliance}.`),
    run: toggleAlliance,
    active: (state) => state.auto !== null && state.alliance !== state.auto.alliance,
    enabled: hasDocument,
    whyDisabled: NO_DOCUMENT,
  },
  {
    id: "view.play",
    label: "Play",
    keywords: ["pause", "preview", "animate", "playback"],
    does: "Animate the robot along the routine. Space plays and pauses from anywhere.",
    shortcut: "playPause",
    group: "view",
    icon: CirclePlay,
    run: () => {
      setPlaying(!getState().playing);
    },
    enabled: hasDocument,
    whyDisabled: NO_DOCUMENT,
    active: (state) => state.playing,
  },
  {
    id: "view.fieldView",
    label: "Field view",
    keywords: ["picture", "image", "outlines", "vector", "background"],
    does: "Switch between the field picture with outlines, the picture alone, and the outlines alone.",
    group: "view",
    icon: Image,
    hint: (state) => `Showing the ${FIELD_VIEW_LABEL[state.prefs.fieldView]}.`,
    run: () => {
      const at = FIELD_VIEWS.indexOf(getState().prefs.fieldView);
      setPrefs({ fieldView: FIELD_VIEWS[(at + 1) % FIELD_VIEWS.length] ?? "image+outlines" });
    },
  },
  {
    id: "view.fieldStyle",
    label: "Field style",
    keywords: ["dark", "black", "light", "tiles", "picture"],
    does: "Switch the field picture between the looks the field file names, such as dark, black and light.",
    group: "view",
    icon: Palette,
    hint: (state) => {
      const styles = fieldStyles(state);
      return styles.length === 0 ? undefined : `Showing ${state.prefs.fieldStyle ?? styles[0] ?? ""}.`;
    },
    run: () => {
      const state = getState();
      const styles = fieldStyles(state);
      if (styles.length === 0) return;
      const at = styles.indexOf(state.prefs.fieldStyle ?? styles[0] ?? "");
      setPrefs({ fieldStyle: styles[(at + 1) % styles.length] ?? null });
    },
    enabled: (state) => fieldStyles(state).length > 1,
    whyDisabled: () => "This field has one picture, or none, so there is no other style to show.",
  },
  {
    id: "view.theme",
    label: "Switch theme",
    keywords: ["dark mode", "light mode", "appearance", "colours", "colors"],
    does: "Switch between the dark and light themes.",
    group: "view",
    icon: Moon,
    hint: (state) => `Currently ${state.prefs.theme}.`,
    run: toggleTheme,
  },
  {
    id: "view.palette",
    label: "Search actions",
    keywords: ["command palette", "find", "commands"],
    does: "Find any action, command, waypoint or auto by typing its name.",
    shortcut: "palette",
    group: "view",
    icon: Search,
    run: () => {
      setPaletteOpen(true);
    },
  },

  /* ---- Editing ---------------------------------------------------------- */
  {
    id: "edit.undo",
    label: "Undo",
    keywords: ["back", "revert", "oops"],
    does: "Take back the last change.",
    shortcut: "undo",
    group: "edit",
    icon: Undo2,
    run: undo,
    enabled: (state) => state.undo.length > 0,
    whyDisabled: () => "There is nothing to undo.",
  },
  {
    id: "edit.redo",
    label: "Redo",
    keywords: ["again", "forward"],
    does: "Put back the change you just undid.",
    shortcut: "redo",
    group: "edit",
    icon: Redo2,
    run: redo,
    enabled: (state) => state.redo.length > 0,
    whyDisabled: () => "There is nothing to redo.",
  },
  {
    id: "edit.delete",
    label: "Delete step",
    keywords: ["remove", "erase", "backspace"],
    does: "Remove the selected step from the routine.",
    shortcut: "delete",
    group: "edit",
    icon: Trash,
    run: deleteSelection,
    enabled: (state) => hasSelection(state) && state.review === null,
    whyDisabled: (state) => (state.review !== null ? READ_ONLY : NO_SELECTION()),
  },
  {
    id: "edit.duplicate",
    label: "Duplicate step",
    keywords: ["copy", "clone", "repeat"],
    does: "Copy the selected step and put the copy straight after it.",
    shortcut: "duplicate",
    group: "edit",
    icon: Copy,
    run: duplicateSelection,
    enabled: (state) => hasSelection(state) && state.review === null,
    whyDisabled: (state) => (state.review !== null ? READ_ONLY : NO_SELECTION()),
  },
  {
    id: "edit.wrapSequence",
    label: "Wrap in a sequence",
    keywords: ["group", "series", "in order"],
    does: "Put the selected steps in a sequence, so they run one after another as one block.",
    group: "edit",
    icon: ListOrdered,
    run: () => {
      wrapSelection("sequence");
    },
    enabled: (state) => canEdit(state) && wrapTargets().length > 0,
    whyDisabled: (state) => (canEdit(state) ? NO_SELECTION() : whyNoEdit(state)),
  },
  {
    id: "edit.wrapParallel",
    label: "Wrap in a parallel group",
    keywords: ["group", "together", "at once", "simultaneous"],
    does: "Put the selected steps in a parallel group, so they run at the same time.",
    group: "edit",
    icon: Layers,
    run: () => {
      wrapSelection("parallel");
    },
    enabled: (state) => canEdit(state) && wrapTargets().length > 0,
    whyDisabled: (state) => (canEdit(state) ? NO_SELECTION() : whyNoEdit(state)),
  },
  {
    id: "edit.wrapBranch",
    label: "Wrap in a branch",
    keywords: ["if", "condition", "choose", "sensor"],
    does: "Run the selected steps only when a condition is true.",
    group: "edit",
    icon: GitBranch,
    run: () => {
      wrapSelection("branch");
    },
    enabled: (state) =>
      canEdit(state) && wrapTargets().length > 0 && conditionsOf(state).length > 0,
    whyDisabled: (state) =>
      !canEdit(state)
        ? whyNoEdit(state)
        : conditionsOf(state).length === 0
          ? "robot.json declares no conditions to branch on."
          : NO_SELECTION(),
  },
  {
    id: "edit.unwrap",
    label: "Unwrap group",
    keywords: ["ungroup", "flatten", "dissolve"],
    does: "Replace the selected group with the steps inside it.",
    group: "edit",
    icon: Ungroup,
    run: unwrapSelection,
    enabled: (state) => canEdit(state) && unwrapReason(state) === null,
    whyDisabled: (state) => (canEdit(state) ? (unwrapReason(state) ?? "") : whyNoEdit(state)),
  },

  /* ---- Inserting, after the selected step ------------------------------- */
  {
    id: "insert.menu",
    label: "Insert step",
    keywords: ["add", "new step"],
    does: "Open the insert menu, to add any kind of step straight after the selected one.",
    shortcut: "insertAfter",
    group: "insert",
    icon: Plus,
    run: () => {
      openInsertMenu("kinds");
    },
    enabled: canEdit,
    whyDisabled: whyNoEdit,
  },
  {
    id: "insert.path",
    label: "Insert a path",
    keywords: ["add", "drive", "route", "leg"],
    does: "Drive to a new point, starting where the selected step ends.",
    group: "insert",
    icon: Spline,
    run: () => {
      addPathStep();
    },
    enabled: canEdit,
    whyDisabled: whyNoEdit,
  },
  {
    id: "insert.command",
    label: "Insert a command",
    keywords: ["add", "action", "mechanism"],
    does: "Pick an action from the robot's code to run after the selected step.",
    group: "insert",
    icon: Zap,
    run: () => {
      openInsertMenu("command");
    },
    enabled: (state) => canEdit(state) && (state.project?.robot.commands.length ?? 0) > 0,
    whyDisabled: (state) =>
      canEdit(state) ? "robot.json registers no commands." : whyNoEdit(state),
  },
  {
    id: "insert.wait",
    label: "Insert a wait",
    keywords: ["add", "pause", "delay", "sleep"],
    does: "Pause for half a second after the selected step. Change the time in the inspector.",
    group: "insert",
    icon: Hourglass,
    run: () => {
      addWaitStep();
    },
    enabled: canEdit,
    whyDisabled: whyNoEdit,
  },
  {
    id: "insert.waitUntil",
    label: "Insert a wait until a condition",
    keywords: ["add", "sensor", "condition", "until"],
    does: "Pause until a sensor condition from robot.json is true.",
    group: "insert",
    icon: Timer,
    run: () => {
      openInsertMenu("wait");
    },
    enabled: (state) => canEdit(state) && conditionsOf(state).length > 0,
    whyDisabled: (state) =>
      canEdit(state) ? "robot.json declares no conditions to wait for." : whyNoEdit(state),
  },
  {
    id: "insert.sequence",
    label: "Insert a sequence",
    keywords: ["add", "group", "series"],
    does: "A block of steps that run one after another, starting with one path.",
    group: "insert",
    icon: ListOrdered,
    run: () => {
      addSequenceStep();
    },
    enabled: canEdit,
    whyDisabled: whyNoEdit,
  },
  {
    id: "insert.parallel",
    label: "Insert a parallel group",
    keywords: ["add", "group", "together", "at once"],
    does: "Drive and run a command at the same time; the group ends when both are done.",
    group: "insert",
    icon: Layers,
    run: () => {
      addParallelStep("all");
    },
    enabled: canEdit,
    whyDisabled: whyNoEdit,
  },
  {
    id: "insert.race",
    label: "Insert a race group",
    keywords: ["add", "group", "first to finish"],
    does: "Drive and run a command at the same time; the group ends when the first one finishes.",
    group: "insert",
    icon: Layers,
    run: () => {
      addParallelStep("race");
    },
    enabled: canEdit,
    whyDisabled: whyNoEdit,
  },
  {
    id: "insert.deadline",
    label: "Insert a deadline group",
    keywords: ["add", "group", "timeout", "limit"],
    does: "Drive and run a command at the same time; the group ends when the drive does.",
    group: "insert",
    icon: Layers,
    run: () => {
      openInsertMenu("parallel");
    },
    enabled: canEdit,
    whyDisabled: whyNoEdit,
  },
  {
    id: "insert.branch",
    label: "Insert a branch",
    keywords: ["add", "if", "condition", "choose"],
    does: "Do one thing if a condition is true and another if it is not.",
    group: "insert",
    icon: GitBranch,
    run: () => {
      openInsertMenu("branch");
    },
    enabled: (state) => canEdit(state) && conditionsOf(state).length > 0,
    whyDisabled: (state) =>
      canEdit(state) ? "robot.json declares no conditions to branch on." : whyNoEdit(state),
  },

  /* ---- The project ------------------------------------------------------ */
  {
    id: "project.open",
    label: "Open project",
    keywords: ["folder", "file", "load", "github", "switch auto"],
    does: "Open a robot repository, a GitHub repository, or the bundled example.",
    shortcut: "openProject",
    group: "project",
    icon: FolderOpen,
    run: () => {
      setDialog("open");
    },
  },
  {
    id: "project.openFolder",
    label: "Open a robot repository folder",
    keywords: ["folder", "directory", "repo", "load"],
    does: "Pick the folder on this computer that holds zenith.json.",
    group: "project",
    icon: FolderOpen,
    run: openFolder,
  },
  {
    id: "project.example",
    label: "Load the bundled example",
    keywords: ["demo", "sample", "biobuzz", "try"],
    does: "Open the BIOBUZZ example project, which is read only.",
    group: "project",
    icon: Binoculars,
    run: loadExample,
  },
  {
    id: "project.saveCopy",
    label: "Save a copy to downloads",
    keywords: ["download", "export", "backup"],
    does: "Download the auto file without touching the project.",
    group: "project",
    icon: Upload,
    run: saveCopy,
    enabled: hasDocument,
    whyDisabled: NO_DOCUMENT,
  },
  {
    id: "project.signIn",
    label: "Sign in to GitHub",
    keywords: ["login", "log in", "token", "account"],
    does: "Connect a GitHub account so autos can be opened from and proposed to a repository.",
    group: "project",
    icon: KeyRound,
    hint: (state) => (state.auth === null ? undefined : `Signed in as ${state.auth.login}.`),
    run: () => {
      setDialog("signIn");
    },
  },
  {
    id: "project.signOut",
    label: "Sign out of GitHub",
    keywords: ["logout", "log out", "forget", "account"],
    does: "Forget the GitHub account on this computer.",
    group: "project",
    icon: LogOut,
    run: signOutOfGitHub,
    enabled: (state) => state.auth !== null,
    whyDisabled: () => "You are not signed in.",
  },
  {
    id: "project.robot",
    label: "Robot settings",
    keywords: ["drivetrain", "footprint", "constants", "measurements", "config"],
    does: "See the robot's size, speed limits and command list from robot.json.",
    group: "project",
    icon: Settings2,
    run: () => {
      setDialog("robot");
    },
    enabled: (state) => state.project !== null,
    whyDisabled: () => "Open a project first.",
  },
  {
    id: "project.meta",
    label: "Auto details",
    keywords: ["name", "title", "description", "metadata", "info"],
    does: "Edit the auto's title, description and authors.",
    group: "project",
    icon: ScrollText,
    run: () => {
      setDialog("meta");
    },
    enabled: hasDocument,
    whyDisabled: NO_DOCUMENT,
  },

  /* ---- Help ------------------------------------------------------------- */
  {
    id: "help.tour",
    label: "Take the tour",
    keywords: ["tour", "help", "tutorial", "guide", "walkthrough", "intro"],
    does: "A short walk through the field, the steps, the inspector and the problems panel. With nothing open, it opens the example first.",
    group: "help",
    icon: MapIcon,
    run: async () => {
      await withSomethingOpen();
      startCoreTour();
    },
  },
  {
    id: "help.fullTour",
    label: "Show me everything",
    keywords: ["tour", "help", "tutorial", "guide", "walkthrough", "everything"],
    does: "The full tour: every tool, panel and feature, one at a time. With nothing open, it opens the example first.",
    group: "help",
    icon: MapIcon,
    run: async () => {
      await withSomethingOpen();
      startFullTour();
    },
  },
  {
    id: "help.shortcuts",
    label: "Keyboard shortcuts",
    keywords: ["keys", "keyboard", "hotkeys", "help", "cheat sheet", "gestures"],
    does: "List every shortcut and canvas gesture.",
    shortcut: "help",
    group: "help",
    icon: Keyboard,
    run: () => {
      setDialog("shortcuts");
    },
  },
];

/**
 * The desktop app's three actions, from the desktop app's own list so the labels and
 * flows stay theirs. They exist only inside the desktop app: in a browser
 * there is no bridge to run them through.
 */
const DESKTOP_HELP: Record<(typeof DESKTOP_ACTIONS)[number]["id"], { does: string; icon: LucideIcon }> = {
  "desktop.sim": {
    does: "Run the robot repository's headless sim on this auto and lay the recorded drive over the plan.",
    icon: FlaskConical,
  },
  "desktop.deploy": {
    does: "Copy the project's autos into the robot repository, after showing which files change.",
    icon: Rocket,
  },
  "desktop.git": {
    does: "Commit the auto, push the branch and open a pull request, from inside the app.",
    icon: GitCommitHorizontal,
  },
};

if (isDesktop()) {
  for (const entry of DESKTOP_ACTIONS) {
    ACTIONS.push({
      id: entry.id,
      label: entry.label,
      does: DESKTOP_HELP[entry.id].does,
      group: "run",
      icon: DESKTOP_HELP[entry.id].icon,
      run: () => entry.run(),
      enabled: entry.id === "desktop.git" ? () => true : hasDocument,
      whyDisabled: NO_DOCUMENT,
    });
  }
}

/** The named looks of the open field's picture, in file order. */
function fieldStyles(state: State): string[] {
  const field = state.autoField ?? state.project?.field;
  return field === undefined || field === null
    ? []
    : (readFieldImage(field)?.variants.map((variant) => variant.name) ?? []);
}

/** The tour needs something on the field to point at; with nothing open, that is the example. */
async function withSomethingOpen(): Promise<void> {
  if (getState().auto === null) await loadExample();
}

export const actionById = (id: string): ActionDef | undefined =>
  ACTIONS.find((action) => action.id === id);

export const shortcutOf = (action: ActionDef): string | undefined =>
  action.shortcut === undefined ? undefined : SHORTCUTS[action.shortcut];

export const isEnabled = (action: ActionDef, state: State): boolean =>
  action.enabled === undefined ? true : action.enabled(state);

/**
 * The tooltip's second line for an action: why it is disabled when it is, else what it does,
 * followed by any live detail.
 */
export function tooltipHint(action: ActionDef, state: State): string {
  if (!isEnabled(action, state)) {
    const why = action.whyDisabled?.(state) ?? "";
    return why === "" ? action.does : `Unavailable: ${why}`;
  }
  const extra = action.hint?.(state);
  return extra === undefined ? action.does : `${action.does} ${extra}`;
}

/** The toolbar's groups, left to right. */
export const TOOLBAR_GROUPS: string[][] = [
  ["tool.select", "tool.addPath", "tool.marker", "tool.heading", "tool.measure", "view.snap"],
  ["run.validate", "view.play", "run.simulate", "run.save", "run.propose"],
  ...(isDesktop() ? [DESKTOP_ACTIONS.map((entry) => entry.id as string)] : []),
  ["view.alliance"],
];

/** The help menu, in order. */
export const HELP_MENU: string[] = ["help.tour", "help.fullTour", "help.shortcuts", "view.palette"];
