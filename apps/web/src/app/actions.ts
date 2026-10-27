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
import { editingNumbers, formatDegrees } from "../settings/editingNumbers";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  Binoculars,
  BookOpen,
  Bug,
  CirclePlay,
  CircleCheck,
  Compass,
  FileCheck2,
  FileDown,
  Copy,
  EyeOff,
  FileCode,
  FileInput,
  FlaskConical,
  Flag,
  FolderOpen,
  FolderPlus,
  Ghost,
  Grid3x3,
  GitBranch,
  Hash,
  GitCommitHorizontal,
  GitPullRequestArrow,
  Cpu,
  Hourglass,
  Image,
  KeyRound,
  Keyboard,
  Layers,
  Link,
  Merge,
  Map as MapIcon,
  MapPlus,
  ListOrdered,
  LogOut,
  Magnet,
  MapPin,
  MessageCircleQuestionMark,
  Moon,
  MousePointer2,
  Palette,
  Pencil,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  FilePlus,
  Rocket,
  Ruler,
  Save,
  ScrollText,
  Search,
  Settings2,
  Share2,
  Slash,
  SlidersHorizontal,
  Spline,
  SquareDashed,
  Timer,
  Trash,
  Undo2,
  WandSparkles,
  Ungroup,
  Upload,
  UsersRound,
  Zap,
  Braces,
  Captions,
  Settings as SettingsIcon,
} from "lucide-react";
import { FIELD_GRID_OPTIONS } from "../settings/registry";
import { RUN_GROUP, RUN_GROUP_NOT_IN_HOST } from "./toolbarRun";
import { openSettings, openSettingsRow } from "../settings/store";
import { openOptimize, openOptimizeAll, optimizeAllBlockedReason, optimizeBlockedReason } from "../optimize/state";
import {
  addParallelStep,
  addPathStep,
  addTurnStep,
  addSequenceStep,
  addWaitStep,
  deleteSelection,
  duplicateSelection,
  chainToExtend,
  joinNextReason,
  joinWithNext,
  unwrapSelection,
  wrapSelection,
  wrapTargets,
} from "./edits";
import { waypointEditingOff } from "./waypointEdits";
import { paletteSegment, switchSelectedSegment } from "./segmentKind";
import { loadExample, openFolder, save, saveCopy, setUpFolder, validate } from "./projectActions";
import { importBlockedReason, pickImportFile } from "./importActions";
import { importCommandsBlockedReason } from "./commandImport";
import { createAuto, newAutoBlockedReason as blankAutoBlockedReason } from "./newAuto";
import { downloadPicture, pictureBlockedReason } from "./downloadPicture";
import { downloadShareFile, shareFileBlockedReason } from "./shareFile";
import { isDesktop } from "../project/desktop";
import { DESKTOP_ACTIONS } from "../project/desktopActions";
import { DESKTOP_KEYS } from "../project/desktopKeys";
import {
  closedLine,
  createHostAuto,
  hostName,
  hostRunBlockedReason,
  isHostMode,
  newAutoBlockedReason,
  runInHost,
} from "../project/hostSession";
import { proposeBlockedReason, signOutOfGitHub } from "../github/actions";
import { actionKeyLabel, keyLabel, menuKeyLabel, turnWords, type ShortcutId } from "./shortcuts";
import { getProposerSession, redoChange, undoChange } from "../proposals/proposerStore";
import { findEntry } from "../lib/stepOps";
import { unwrapBlockedReason } from "../lib/structure";
import {
  getState,
  hiddenWaypoints,
  redo,
  setDialog,
  setPaletteOpen,
  setPlaying,
  setSetting,
  setStatus,
  setTool,
  setWaypointPins,
  setWaypointPinShown,
  toggleAlliance,
  toggleClipGhosts,
  toggleDescriptions,
  toggleLedgerCounts,
  toggleOverheadOutlines,
  toggleAddPathExtends,
  toggleSnap,
  toggleTheme,
  undo,
  type State,
} from "../state/store";
import { openInsertMenu } from "../state/ui";
import { explainFocused } from "../components/tooltipGate";
import { startWhatsThis } from "../components/whatsThisMode";
import { startCoreTour, startFullTour } from "../tour/store";
import type { FieldGrid, FieldView } from "../state/prefs";
import { WAYPOINT_PINS_LABEL, WAYPOINT_PINS_MODES, type WaypointPinsMode } from "../state/waypointPins";
import { isWritable } from "../project/types";
import { readFieldImage } from "../canvas/fieldImage";
import { DRAWING_TOOLS, mirrorBannerLine } from "../canvas/help";
import { getCloud, openSharingSheet, sharingBlockedReason } from "../cloud/store";
import { ACCOUNT_ACTIONS } from "../account/actions";
import { DOCS_URL, cloudEnabled } from "../account/config";
import { openProposalBlockedReason, pickProposalFile } from "../proposals/ownerActions";
import { recordAction } from "./recentActions";
import { playFrom, playFromStep } from "./playFromHere";
import { armWaypointPlacement, askDeleteWaypoint, askRenameWaypoint, getWaypointQuestion } from "./waypointDialog";

export type ActionGroup = "tool" | "run" | "view" | "edit" | "insert" | "project" | "help";

export interface ActionDef {
  id: string;
  label: string;
  /**
   * The label in menus and the palette while the selection changes what the action does: Delete
   * reads "Delete waypoint…" with a pin selected. The shortcut sheet keeps the fixed `label`.
   */
  labelFor?: (state: State) => string | undefined;
  /** What the action does, in one plain sentence: the tooltip's second line. */
  does: string;
  /**
   * The tooltip's second line while it differs from `does`, and instead of it: Save reads "Read-only
   * project: asks where to save." on a project it cannot write. Other actions add to `does` with `hint`.
   */
  doesFor?: (state: State) => string | undefined;
  /** Live detail worth knowing, such as which alliance is showing. */
  hint?: (state: State) => string | undefined;
  /** Why the action cannot run right now. Required whenever `enabled` is. */
  whyDisabled?: (state: State) => string;
  shortcut?: ShortcutId;
  /**
   * False when the shortcut sheet explains this action's key in a row it already has (F2 renames a
   * waypoint, said in the gesture row for a double-click), so the sheet adds none and keeps its fit.
   */
  sheetRow?: false;
  /**
   * A key the desktop app's native menu owns rather than the page (project/desktopKeys.ts).
   * Tooltips and the palette show it; the page's key handler leaves it to the menu.
   */
  menuShortcut?: string;
  /**
   * Other words a person might type in the palette for this action (QA-02): "tour" finds "Show me
   * everything". Every action has some; the palette matches them as well as the label and group.
   */
  keywords?: readonly string[];
  group: ActionGroup;
  icon: LucideIcon;
  /** The action leaves the app (it opens a page in a new tab), so a menu marks its item with an external-link glyph. */
  external?: boolean;
  run: () => void | Promise<void>;
  enabled?: (state: State) => boolean;
  active?: (state: State) => boolean;
}

const hasDocument = (state: State): boolean => state.auto !== null;
const hasSelection = (state: State): boolean => state.selection.stepId !== undefined;
const NO_DOCUMENT = (): string => "Open an auto first.";
const NO_SELECTION = (): string => "Select a step first.";
const READ_ONLY = "Review mode is read only.";

/**
 * Why a tool that draws on the field cannot be chosen now (issue #412): with no auto open there is
 * nothing to draw on, and a mirrored preview would write the other alliance's numbers.
 */
export function drawingToolOff(state: State): string | null {
  if (state.auto === null) return NO_DOCUMENT();
  if (state.alliance !== state.auto.alliance) return mirrorBannerLine(state.auto.alliance);
  return null;
}
const drawingToolOn = (state: State): boolean => drawingToolOff(state) === null;
const whyDrawingToolOff = (state: State): string => drawingToolOff(state) ?? "";

/** Mirror to the other alliance, leaving a drawing tool for Select, since the preview takes no edits. */
function toggleAllianceView(): void {
  toggleAlliance();
  const state = getState();
  if (drawingToolOff(state) !== null && DRAWING_TOOLS.has(state.tool)) setTool("select");
  if (state.auto === null) return;
  // A view change Ctrl Z does not take back, so the line names its own way back (UI_GUIDE 9.15).
  if (state.alliance === state.auto.alliance) setStatus("info", `Showing ${state.alliance}, the side the auto is drawn for.`);
  else setStatus("info", `Showing the auto mirrored for ${state.alliance}.`, `Mirror again to go back to ${state.auto.alliance}.`);
}

/**
 * Why Delete cannot delete the selected waypoint pin, or null when it can: where waypoints cannot be
 * edited, or while the Waypoints switch, which deleting one goes with, is off (spec 15 section 4.1).
 */
const pinDeleteOff = (state: State): string | null =>
  waypointEditingOff(state) ??
  (state.prefs.features.waypoints ? null : "Waypoints are off in your settings. Turn them on in Settings, General to delete one.");

/** True when Save on this project asks where to put the auto: a read-only project that is not GitHub mode. */
function saveAsksWhere(state: State): boolean {
  return (
    state.review === null &&
    state.auto !== null &&
    state.project !== null &&
    state.project !== undefined &&
    !isWritable(state.project.source) &&
    state.backend?.kind !== "github"
  );
}

const canEdit = (state: State): boolean => hasDocument(state) && state.review === null;
const whyNoEdit = (state: State): string => (state.auto === null ? NO_DOCUMENT() : READ_ONLY);

const conditionsOf = (state: State) =>
  state.autoRobot?.conditions ?? state.project?.robot.conditions ?? [];

/** The commands the open auto can run: its own robot override's when it has one (issue #401). */
const commandsOf = (state: State) => (state.autoRobot ?? state.project?.robot)?.commands ?? [];

/** Why the palette's Make curve or Make straight line cannot run, or "" when it can. */
function segmentReason(state: State, kind: "line" | "bezier"): string {
  const target = paletteSegment(state, kind);
  return typeof target === "string" ? target : "";
}

/** Why the selected step cannot be unwrapped, or null when it can. */
function unwrapReason(state: State): string | null {
  if (state.auto === null) return NO_DOCUMENT();
  if (state.selection.stepId === undefined) return NO_SELECTION();
  const entry = findEntry(state.auto, state.selection.stepId);
  if (entry === undefined) return NO_SELECTION();
  return unwrapBlockedReason(entry.step);
}

/** Why Join with next path cannot join the selected step with the one after it, or null when it can. */
function joinReason(state: State): string | null {
  if (state.auto === null) return NO_DOCUMENT();
  if (state.selection.stepId === undefined) return NO_SELECTION();
  return joinNextReason(state.auto, state.selection.stepId, state.project?.waypoints);
}

export const FIELD_VIEWS: FieldView[] = ["image+outlines", "image", "vector"];
export const FIELD_VIEW_LABEL: Record<FieldView, string> = {
  "image+outlines": "picture with outlines",
  image: "picture only",
  vector: "outlines only",
};

/** The Grid choice's label, as the Settings dropdown shows it. */
const gridLabel = (grid: FieldGrid): string => FIELD_GRID_OPTIONS.find((option) => option.value === grid)?.label ?? grid;

/** What the Waypoint pins action's hint says each mode shows (issue #236). */
const WAYPOINT_PINS_HINT: Record<WaypointPinsMode, string> = {
  all: "every pin",
  used: "only the pins this auto uses",
  none: "no pins",
};

/**
 * Sharing outside the team (spec 13 section 8): the Share dialog and the Sharing page. Like the
 * account's actions, they exist only when the cloud is on (`cloudEnabled`, account/config.ts).
 * With the cloud off there is no way to sign in, so a Share button would point at nothing: the
 * toolbar, the palette and the shortcut sheet then have no sharing entry at all.
 */
const SHARE_ACTIONS: ActionDef[] = cloudEnabled()
  ? [
      {
        id: "share.open",
        label: "Share this auto",
        keywords: ["share", "alliance", "partner", "link", "send", "team", "invite"],
        does: "Choose which teams outside yours can see this auto, what they see and for how long.",
        group: "project",
        icon: Share2,
        run: () => {
          openSharingSheet("share");
        },
        enabled: (state) => sharingBlockedReason(state.auto !== null) === null,
        whyDisabled: (state) => sharingBlockedReason(state.auto !== null) ?? "",
        active: () => getCloud().sheet === "share",
      },
      {
        id: "share.page",
        label: "Sharing",
        keywords: ["shares", "invites", "revoke", "extend", "who can see", "link"],
        does: "List every share and invite your team has made, to extend, change or revoke any of them.",
        group: "project",
        icon: UsersRound,
        run: () => {
          openSharingSheet("sharing");
        },
        enabled: () => sharingBlockedReason(true) === null,
        whyDisabled: () => sharingBlockedReason(true) ?? "",
        active: () => getCloud().sheet === "sharing",
      },
    ]
  : [];

/**
 * What Settings holds, for its toolbar button's hint and its palette row alike. With the cloud off
 * there is no account, so it is left out (0.1.2 UX sweep, W1-9; UX review, S12).
 */
export function settingsHint(cloud: boolean = cloudEnabled()): string {
  return cloud
    ? "Your account, the features you use, this project's robot, and how the editor looks."
    : "The features you use, this project's robot, and how the editor looks.";
}

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
    enabled: hasDocument,
    whyDisabled: NO_DOCUMENT,
  },
  {
    id: "tool.addPath",
    label: "Add path",
    keywords: ["draw", "drive", "route", "trajectory", "leg", "segment", "chain", "pathchain"],
    does: "Click the field to drive to that point, continuing from the selected step.",
    shortcut: "addPath",
    group: "tool",
    icon: Spline,
    run: () => {
      setTool("addPath");
    },
    active: (state) => state.tool === "addPath",
    enabled: drawingToolOn,
    whyDisabled: whyDrawingToolOff,
  },
  // Issue #204 (decision D5): the add-path tool's option, shown beside it while it is the tool.
  {
    id: "tool.extendChain",
    label: "Extend this chain",
    keywords: ["append", "chain", "pathchain", "add path", "continue", "same step"],
    does: "Add to this chain instead of a new step.",
    group: "tool",
    icon: Link,
    run: () => {
      toggleAddPathExtends();
      // On with no path step selected, the toggle changes nothing yet, so the status line says why
      // (0.1.2 UX sweep, W1-13).
      if (getState().prefs.addPathExtends && chainToExtend() === null) {
        setStatus("info", "Extend this chain is on, and no path step is selected.", "Select a path step to add to its chain.");
      }
    },
    active: (state) => state.prefs.addPathExtends,
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
    enabled: drawingToolOn,
    whyDisabled: whyDrawingToolOff,
  },
  {
    id: "tool.marker",
    label: "Marker",
    keywords: ["event marker", "trigger", "timing", "flag"],
    does: "Click a path to fire a command there without stopping. The inspector edits what it does.",
    shortcut: "marker",
    group: "tool",
    icon: MapPin,
    run: () => {
      setTool("marker");
    },
    active: (state) => state.tool === "marker",
    enabled: drawingToolOn,
    whyDisabled: whyDrawingToolOff,
  },
  {
    id: "tool.heading",
    label: "Heading",
    keywords: ["rotate", "turn", "angle", "facing", "direction"],
    // Turn's keys as the person has them (issue #290) and the person's own Rotate step
    // (`editing.rotateDeg`), both read each time the tooltip or palette row is drawn.
    get does(): string {
      const turn = turnWords(keyLabel("rotate"));
      const step = formatDegrees(editingNumbers(getState().prefs).rotateDeg);
      return `Drag the heading arrow on the selected path.${turn === undefined ? "" : ` ${turn} turn the selected point ${step}.`}`;
    },
    shortcut: "heading",
    group: "tool",
    icon: Compass,
    run: () => {
      setTool("heading");
    },
    active: (state) => state.tool === "heading",
    enabled: drawingToolOn,
    whyDisabled: whyDrawingToolOff,
  },
  {
    id: "tool.measure",
    label: "Measure",
    keywords: ["ruler", "distance", "tape", "angle"],
    does: "Drag between two points to read the distance and angle. Shift keeps the angle to 45° steps.",
    shortcut: "measure",
    group: "tool",
    icon: Ruler,
    run: () => {
      setTool("measure");
    },
    active: (state) => state.tool === "measure",
    enabled: hasDocument,
    whyDisabled: NO_DOCUMENT,
  },
  {
    id: "view.snap",
    label: "Snap",
    // A toggle names its state in the palette, as Field grid and Waypoint pins do (UX review, S19).
    labelFor: (state) => `Snap: ${state.prefs.snap ? "On" : "Off"}`,
    keywords: ["grid", "align", "magnet", "wall", "waypoint", "15°"],
    does: "Points stop at waypoints, walls and the grid, and headings at 15°. Ctrl flips it for one drag.",
    shortcut: "snap",
    group: "tool",
    icon: Magnet,
    run: () => {
      toggleSnap();
      setStatus("info", getState().prefs.snap ? "Snap on." : "Snap off.", "Ctrl flips it for one drag.");
    },
    active: (state) => state.prefs.snap,
  },

  /* ---- Run -------------------------------------------------------------- */
  {
    id: "run.validate",
    label: "Validate",
    keywords: ["check", "problems", "errors", "lint", "findings"],
    does: "Re-check the auto now. Zenith also checks after every edit.",
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
    does: "Run the high-fidelity sim in the robot repository and lay the recorded drive over the plan.",
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
    does: "Writes the auto to the robot repository.",
    doesFor: (state) => (saveAsksWhere(state) ? "Read-only project: asks where to save." : undefined),
    shortcut: "save",
    group: "run",
    icon: Save,
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
    does: "Show the auto as the other alliance would run it. You still edit one side.",
    shortcut: "alliance",
    group: "view",
    icon: ArrowLeftRight,
    hint: (state) => (state.auto === null ? undefined : `Showing ${state.alliance}.`),
    run: toggleAllianceView,
    active: (state) => state.auto !== null && state.alliance !== state.auto.alliance,
    enabled: hasDocument,
    whyDisabled: NO_DOCUMENT,
  },
  {
    id: "view.play",
    label: "Play",
    keywords: ["pause", "preview", "animate", "playback"],
    does: "Animate the robot along the auto. Space plays and pauses from anywhere.",
    shortcut: "playPause",
    group: "view",
    icon: CirclePlay,
    run: () => {
      const playing = !getState().playing;
      setPlaying(playing);
      setStatus("info", playing ? "Playing." : `Paused at ${(getState().playbackS ?? 0).toFixed(1)} s.`);
    },
    enabled: hasDocument,
    whyDisabled: NO_DOCUMENT,
    active: (state) => state.playing,
  },
  {
    id: "view.playFromSelected",
    label: "Play from the selected step",
    keywords: ["play from here", "start here", "jump", "seek", "playhead", "preview"],
    does: "Move the playhead to where the selected step starts at the playback level, and play from there.",
    group: "view",
    icon: Play,
    run: () => {
      playFromStep(getState().selection.stepId);
    },
    enabled: (state) => playFrom(state.selection.stepId, state).ok,
    whyDisabled: (state) => {
      const from = playFrom(state.selection.stepId, state);
      return from.ok ? "" : from.reason;
    },
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
      setSetting("display.fieldView", FIELD_VIEWS[(at + 1) % FIELD_VIEWS.length] ?? "image+outlines");
    },
    enabled: (state) => fieldHasPicture(state),
    whyDisabled: () => "This field is drawn from its geometry and names no picture, so there is only one view.",
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
      setSetting("display.fieldStyle", styles[(at + 1) % styles.length] ?? null);
    },
    enabled: (state) => fieldStyles(state).length > 1,
    whyDisabled: () => "This field has one picture, or none, so there is no other style to show.",
  },
  {
    // Spec 15 section 10: steps Off, Tiles, 12 in, 6 in through `setSetting`, so the Settings row, the
    // palette and a reload all agree.
    id: "view.fieldGrid",
    label: "Field grid",
    labelFor: (state) => `Field grid: ${gridLabel(state.prefs.fieldGrid)}`,
    keywords: ["grid", "tiles", "seams", "lines", "12 in", "6 in", "24 in", "floor", "declutter"],
    does: "Step the field's grid through Off, Tiles (24 in seams), 12 in lines and 6 in lines.",
    group: "view",
    icon: Grid3x3,
    hint: (state) => `Showing ${gridLabel(state.prefs.fieldGrid).toLowerCase()}.`,
    run: () => {
      const values = FIELD_GRID_OPTIONS.map((option) => option.value);
      const at = values.indexOf(getState().prefs.fieldGrid);
      setSetting("display.fieldGrid", values[(at + 1) % values.length] ?? "tiles");
    },
  },
  {
    id: "view.clipGhosts",
    label: "Clip ghosts",
    // The palette says the state, as Field grid does (0.1.2 UX sweep, W1-13).
    labelFor: (state) => `Clip ghosts: ${state.prefs.clipGhosts ? "Shown" : "Hidden"}`,
    keywords: ["ghost", "collision", "outside the field", "perimeter", "structure", "clips", "problems"],
    does: "Show or hide the robot drawn in red where a path leaves the field or runs into a structure.",
    group: "view",
    icon: Ghost,
    hint: (state) => (state.prefs.clipGhosts ? "Showing them." : "Hidden; hovering a problem still shows its ghost."),
    run: toggleClipGhosts,
    active: (state) => state.prefs.clipGhosts,
  },
  {
    // Planned as issue #200 registry entry `field.overheadOutlines`: Basic off, Essential and Full on.
    id: "view.overheadOutlines",
    label: "Overhead outlines",
    labelFor: (state) => `Overhead outlines: ${state.prefs.overheadOutlines ? "Shown" : "Hidden"}`,
    keywords: ["hive frame", "legs", "crossbar", "overhead", "dashed", "structure", "beam", "strut", "declutter"],
    does: "Show or hide dashed outlines of the hive frame and hive the robot drives under.",
    group: "view",
    icon: SquareDashed,
    hint: (state) =>
      state.prefs.overheadOutlines ? "Showing them." : "Hidden; the legs' bands the robot hits still show.",
    run: toggleOverheadOutlines,
    active: (state) => state.prefs.overheadOutlines,
  },
  {
    id: "view.ledgerCounts",
    label: "Ledger counts on the field",
    keywords: ["ledger", "balls", "pieces", "pollen", "counts", "hive", "flower", "quadrant", "loading zone", "human player"],
    does: "Show or hide the ledger's piece count in each cell, flower, quarter and zone at playback time.",
    group: "view",
    icon: Hash,
    hint: (state) => (state.prefs.ledgerCounts ? "Showing them." : "Hidden; the ledger panel still lists them."),
    run: toggleLedgerCounts,
    active: (state) => state.prefs.ledgerCounts,
  },
  {
    id: "view.waypointPins",
    label: "Waypoint pins",
    labelFor: (state) => `Waypoint pins: ${WAYPOINT_PINS_LABEL[state.prefs.waypointPins]}`,
    keywords: ["waypoint", "pins", "hide", "show", "used", "declutter", "clutter"],
    does: "Show every waypoint pin, only this auto's, or none. Hidden pins do not snap; waypoints.json stays.",
    group: "view",
    icon: Flag,
    hint: (state) => `Showing ${WAYPOINT_PINS_HINT[state.prefs.waypointPins]}.`,
    run: () => {
      const at = WAYPOINT_PINS_MODES.indexOf(getState().prefs.waypointPins);
      setWaypointPins(WAYPOINT_PINS_MODES[(at + 1) % WAYPOINT_PINS_MODES.length] ?? "all");
    },
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
    id: "view.descriptions",
    label: "Descriptions",
    labelFor: (state) => `Descriptions: ${state.prefs.descriptions === "full" ? "With descriptions" : "Labels only"}`,
    keywords: ["descriptions", "labels only", "compact", "explanations", "help text", "clutter", "verbose", "brief"],
    does: "Show or hide the short line under each described row's label. Its full text stays on a long hover.",
    group: "view",
    icon: Captions,
    hint: (state) => (state.prefs.descriptions === "full" ? "With descriptions." : "Labels only."),
    run: toggleDescriptions,
    active: (state) => state.prefs.descriptions === "full",
  },
  {
    id: "view.settings",
    label: "Settings",
    keywords: ["preferences", "options", "account", "profile", "theme", "command library", "pathing", "sign out", "export", "delete"],
    does: settingsHint(),
    shortcut: "settings",
    group: "view",
    icon: SettingsIcon,
    run: () => {
      openSettings();
    },
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
    // While a proposal is open its own history is the one that moves, never the auto underneath.
    run: () => {
      // A proposal's history names no change, so its undo says the general line (UI_GUIDE 9.15).
      if (getProposerSession() === null) undo();
      else {
        undoChange();
        setStatus("ok", "Undid the last change.");
      }
    },
    enabled: (state) => {
      const proposing = getProposerSession();
      return proposing === null ? state.undo.length > 0 : proposing.undo.length > 0;
    },
    whyDisabled: () =>
      getProposerSession() === null ? "There is nothing to undo." : "There is nothing to undo in this proposal.",
  },
  {
    id: "edit.redo",
    label: "Redo",
    keywords: ["again", "forward"],
    does: "Put back the change you just undid.",
    shortcut: "redo",
    group: "edit",
    icon: Redo2,
    run: () => {
      if (getProposerSession() === null) redo();
      else {
        redoChange();
        setStatus("ok", "Redid the last change.");
      }
    },
    enabled: (state) => {
      const proposing = getProposerSession();
      return proposing === null ? state.redo.length > 0 : proposing.redo.length > 0;
    },
    whyDisabled: () =>
      getProposerSession() === null ? "There is nothing to redo." : "There is nothing to redo in this proposal.",
  },
  {
    id: "edit.delete",
    label: "Delete step",
    labelFor: (state) => (state.selection.waypoint === undefined ? undefined : "Delete waypoint…"),
    keywords: ["remove", "erase", "backspace", "waypoint", "pin"],
    does: "Remove the selected steps, or just the selected path point. A waypoint pin asks first.",
    shortcut: "delete",
    group: "edit",
    icon: Trash,
    run: deleteSelection,
    // A selected pin is what Delete asks about, so it is on only where waypoints can be edited, and
    // only with the Waypoints switch on, which deleting one goes with.
    enabled: (state) =>
      state.review === null &&
      (state.selection.waypoint !== undefined ? pinDeleteOff(state) === null : hasSelection(state)),
    whyDisabled: (state) =>
      state.review !== null
        ? READ_ONLY
        : (state.selection.waypoint !== undefined ? pinDeleteOff(state) : null) ??
          "Select a step, a path point or a waypoint first.",
  },
  {
    id: "waypoint.add",
    label: "Add waypoint",
    keywords: ["pin", "new", "create", "place"],
    does: "Click the field to place a pin, then name it. Right-click, Add waypoint here, does both at once.",
    sheetRow: false,
    group: "edit",
    icon: Flag,
    run: armWaypointPlacement,
    enabled: (state) => state.auto !== null && waypointEditingOff(state) === null && getWaypointQuestion() === null,
    whyDisabled: (state) => (state.auto === null ? "Open an auto first." : (waypointEditingOff(state) ?? "Answer the waypoint question first.")),
  },
  {
    id: "waypoint.rename",
    label: "Rename waypoint…",
    keywords: ["pin", "name", "f2"],
    does: "Rename the selected waypoint pin, after saying which autos follow it.",
    shortcut: "renameWaypoint",
    sheetRow: false,
    group: "edit",
    icon: Pencil,
    run: () => {
      const name = getState().selection.waypoint;
      if (name !== undefined) askRenameWaypoint(name);
    },
    enabled: (state) => state.selection.waypoint !== undefined && state.review === null && getWaypointQuestion() === null,
    whyDisabled: (state) =>
      state.review !== null
        ? READ_ONLY
        : state.selection.waypoint === undefined
          ? "Select a waypoint pin first."
          : "Answer or close the open waypoint question first.",
  },
  {
    id: "waypoint.delete",
    label: "Delete waypoint…",
    keywords: ["remove", "erase", "pin"],
    does: "Delete the selected waypoint pin, after saying which autos follow it. Del does the same.",
    group: "edit",
    icon: Trash,
    run: () => {
      const name = getState().selection.waypoint;
      if (name !== undefined) askDeleteWaypoint(name);
    },
    enabled: (state) => state.selection.waypoint !== undefined && state.review === null,
    whyDisabled: (state) => (state.review !== null ? READ_ONLY : "Select a waypoint pin first."),
  },
  {
    id: "waypoint.hide",
    label: "Hide waypoint",
    labelFor: (state) => {
      const name = state.selection.waypoint;
      return name === undefined ? undefined : hiddenWaypoints(state).has(name) ? "Show waypoint" : "Hide waypoint";
    },
    keywords: ["pin", "show", "eye", "declutter"],
    does: "Hide or show the selected waypoint's pin on your field. Only you see it; no file changes.",
    group: "view",
    icon: EyeOff,
    run: () => {
      const state = getState();
      const name = state.selection.waypoint;
      if (name !== undefined) setWaypointPinShown(name, hiddenWaypoints(state).has(name));
    },
    enabled: (state) => state.selection.waypoint !== undefined && state.project !== null,
    whyDisabled: () => "Select a waypoint pin first.",
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
  // Issue #204 (decision D5): two path steps that follow each other become one path chain.
  {
    id: "edit.joinNext",
    label: "Join with next path",
    keywords: ["merge", "combine", "join", "chain", "pathchain", "one step"],
    does: "Make the selected path step and the path step straight after it one path chain.",
    group: "edit",
    icon: Merge,
    run: () => {
      joinWithNext();
    },
    enabled: (state) => canEdit(state) && joinReason(state) === null,
    whyDisabled: (state) => (canEdit(state) ? (joinReason(state) ?? "") : whyNoEdit(state)),
  },
  // Issue #143. A path's right-click menu offers both for the segment under the pointer
  // (`canvasMenu.ts`); here they act on the selected point's segment, or the selected path's first.
  {
    id: "edit.makeCurve",
    label: "Make curve",
    keywords: ["curve", "bezier", "bend", "control point", "arc"],
    does: "Turn the selected path into a curve. Drag the hollow square in its middle to bend it.",
    group: "edit",
    icon: Spline,
    run: () => {
      switchSelectedSegment("bezier");
    },
    enabled: (state) => typeof paletteSegment(state, "bezier") !== "string",
    whyDisabled: (state) => segmentReason(state, "bezier"),
  },
  {
    id: "edit.makeLine",
    label: "Make straight line",
    keywords: ["straight", "straighten", "unbend", "curve", "bezier"],
    does: "Turn the selected curved path back into a straight line between its two ends.",
    group: "edit",
    icon: Slash,
    run: () => {
      switchSelectedSegment("line");
    },
    enabled: (state) => typeof paletteSegment(state, "line") !== "string",
    whyDisabled: (state) => segmentReason(state, "line"),
  },
  // Optimize path (issue #308): bindable, with no default key (spec 15 section 8.2), and gated by
  // `features.optimizer` in the registry. The Inspector's Optimize button runs `path.optimize`.
  {
    id: "path.optimize",
    label: "Optimize path",
    keywords: ["faster", "route", "optimise", "shortest", "speed up", "around"],
    does: "Find a faster route for the selected path step, and show it before anything changes.",
    group: "edit",
    icon: WandSparkles,
    run: () => {
      openOptimize();
    },
    enabled: (state) => optimizeBlockedReason(state) === null,
    whyDisabled: (state) => optimizeBlockedReason(state) ?? "",
  },
  {
    id: "path.optimizeWithOptions",
    label: "Optimize path with options…",
    keywords: ["faster", "route", "optimise", "margin", "settings", "score"],
    does: "Open Optimize path on the selected path step with its options first, before it runs.",
    group: "edit",
    icon: SlidersHorizontal,
    run: () => {
      openOptimize({ withOptions: true });
    },
    enabled: (state) => optimizeBlockedReason(state) === null,
    whyDisabled: (state) => optimizeBlockedReason(state) ?? "",
  },
  // Optimize every path (issue #366): Optimize path on every path step in turn, in one card, with
  // one undo step for the results the person accepts.
  {
    id: "path.optimizeAll",
    label: "Optimize every path",
    keywords: ["faster", "route", "optimise", "all paths", "whole auto", "speed up"],
    does: "Find a faster route for each path step in turn, and show every result before anything changes.",
    group: "edit",
    icon: WandSparkles,
    run: () => {
      openOptimizeAll();
    },
    enabled: (state) => optimizeAllBlockedReason(state) === null,
    whyDisabled: (state) => optimizeAllBlockedReason(state) ?? "",
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
    doesFor: () => {
      const chain = chainToExtend();
      return chain === null ? undefined : `Extend this chain is on: adds a path to ${chain}'s chain.`;
    },
    group: "insert",
    icon: Spline,
    run: () => {
      addPathStep();
    },
    enabled: canEdit,
    whyDisabled: whyNoEdit,
  },
  {
    id: "insert.turn",
    label: "Turn on the spot",
    keywords: ["add", "rotate", "spin", "turn in place", "heading"],
    does: "Turn where the selected step ends, a quarter turn to start with. Drag its arrow to change it.",
    group: "insert",
    icon: RotateCcw,
    run: () => {
      addTurnStep();
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
    enabled: (state) => canEdit(state) && commandsOf(state).length > 0,
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
    // The Insert menu's and the Inspector's words for the mode, so one mode has one name (issue #505).
    label: "Insert a parallel group that stops when any step ends",
    keywords: ["add", "group", "race", "first to finish"],
    does: "Drive and run a command at the same time; the group ends when any one of them finishes.",
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
    label: "Insert a parallel group that stops when a chosen step ends",
    keywords: ["add", "group", "deadline", "timeout", "limit"],
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
    does: "Open a robot repository's folder, a GitHub repository, or the example.",
    shortcut: "openProject",
    group: "project",
    icon: FolderOpen,
    run: () => {
      setDialog("open");
    },
  },
  {
    id: "project.newAuto",
    label: "New auto",
    keywords: ["create", "start", "blank", "add auto", "new file"],
    does: "Start a blank auto in the open project. It is not saved until you save it.",
    group: "project",
    icon: FilePlus,
    run: createAuto,
    enabled: (state) => blankAutoBlockedReason(state) === null,
    whyDisabled: (state) => blankAutoBlockedReason(state) ?? "",
  },
  {
    id: "project.openFolder",
    label: "Open a folder…",
    keywords: ["folder", "directory", "repo", "load"],
    does: "Pick your robot repository's folder on this computer, the one that holds zenith.json.",
    group: "project",
    icon: FolderOpen,
    run: () => openFolder(),
  },
  {
    id: "project.setUp",
    label: "Set up Zenith in a robot repository…",
    keywords: ["setup", "set up", "init", "initialize", "initialise", "new project", "zenith.json", "teamcode", "repo", "folder", "start"],
    does: "Pick your robot folder. One with no zenith.json is set up first; one with it opens as is.",
    group: "project",
    icon: FolderPlus,
    run: setUpFolder,
  },
  {
    id: "project.example",
    label: "Open the example",
    keywords: ["demo", "sample", "biobuzz", "try"],
    does: "Open the BIOBUZZ example project, which is read only.",
    group: "project",
    icon: Binoculars,
    run: loadExample,
  },
  {
    id: "project.import",
    label: "Import from another planner…",
    keywords: ["import", "pedro", "visualizer", ".pp", "path.json", "trajectory.json", "roadrunner", "meepmeep", "planner", "convert", "bring in"],
    does: "Open a Pedro Visualizer .pp, path.json or trajectory.json file as a new, unsaved auto.",
    group: "project",
    icon: FileInput,
    run: pickImportFile,
    enabled: (state) => importBlockedReason(state) === null,
    whyDisabled: (state) => importBlockedReason(state) ?? "",
  },
  {
    id: "project.importCommands",
    label: "Import commands from Java…",
    keywords: ["import", "commands", "conditions", "java", "kotlin", "namedcommands", "register", "registry", "robot.json", "sync", "scan", "pull"],
    does: "Read the NamedCommands in the robot's code and add what robot.json lacks, after a preview.",
    group: "project",
    icon: FileCode,
    run: () => {
      setDialog("importCommands");
    },
    enabled: (state) => importCommandsBlockedReason(state) === null,
    whyDisabled: (state) => importCommandsBlockedReason(state) ?? "",
  },
  {
    id: "project.downloadShareFile",
    label: "Download share file",
    keywords: ["projection", "share", "partner", "alliance", "export", "download", "file", "offline"],
    does: "Download a share file of this auto for a partner's Partners panel or zenith alliance.",
    group: "project",
    icon: FileDown,
    run: () => {
      downloadShareFile("view");
    },
    enabled: (state) => shareFileBlockedReason(state) === null,
    whyDisabled: (state) => shareFileBlockedReason(state) ?? "",
  },
  {
    id: "project.downloadProposeShareFile",
    label: "Download share file for proposals",
    keywords: ["projection", "propose", "proposal", "share", "partner", "export", "download", "file", "offline"],
    does: "Download a share file that also lets a partner suggest changes and send back a proposal.",
    group: "project",
    icon: FileDown,
    run: () => {
      downloadShareFile("propose");
    },
    enabled: (state) => shareFileBlockedReason(state) === null,
    whyDisabled: (state) => shareFileBlockedReason(state) ?? "",
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
    id: "project.downloadPicture",
    label: "Download picture (PNG)",
    keywords: ["png", "svg", "picture", "image", "export", "print", "download", "render"],
    does: "Download a PNG of the auto with its paths, markers, footprints and total time.",
    group: "project",
    icon: Image,
    run: () => {
      void downloadPicture("png");
    },
    enabled: (state) => pictureBlockedReason(state) === null,
    whyDisabled: (state) => pictureBlockedReason(state) ?? "",
  },
  {
    id: "project.downloadPictureSvg",
    label: "Download picture (SVG)",
    keywords: ["png", "svg", "picture", "image", "export", "print", "download", "render"],
    does: "Download an SVG of the auto with its paths, markers, footprints and total time.",
    group: "project",
    icon: Image,
    run: () => {
      void downloadPicture("svg");
    },
    enabled: (state) => pictureBlockedReason(state) === null,
    whyDisabled: (state) => pictureBlockedReason(state) ?? "",
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
    keywords: ["drivetrain", "footprint", "constants", "measurements", "config", "robot.json", "speed", "size"],
    does: "See and change the robot's size, speeds and intakes from robot.json, in Settings.",
    group: "project",
    icon: Settings2,
    run: () => {
      openSettings("robot");
    },
    enabled: (state) => state.project !== null,
    whyDisabled: () => "Open a project first.",
  },
  {
    id: "project.commands",
    label: "Robot commands",
    keywords: ["commands", "registry", "named commands", "robot.json", "arguments", "add command"],
    does: "See, add, change and remove the commands robot.json registers, in Settings.",
    group: "project",
    icon: Zap,
    run: () => {
      openSettings("commands");
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

  /* ---- Sharing outside the team: only with a cloud (SHARE_ACTIONS) ------- */
  ...SHARE_ACTIONS,

  {
    id: "proposal.open",
    label: "Open proposal…",
    keywords: ["proposal", "review", "partner", "suggested changes", "accept", "reject", "propose"],
    does: "Review a partner's proposal file against this auto and apply the changes you accept.",
    group: "project",
    icon: FileCheck2,
    run: () => {
      pickProposalFile();
    },
    enabled: (state) => openProposalBlockedReason(state) === null,
    whyDisabled: (state) => openProposalBlockedReason(state) ?? "",
  },

  {
    id: "project.commandLibrary",
    label: "Choose the command library",
    keywords: ["command library", "command base", "solverslib", "ivy", "ftclib", "pedro", "pathing", "follower", "codegen", "deploy", "zenith.json"],
    does: "Pick SolversLib or Ivy for this project, in Settings. It sets what the generated Java imports.",
    group: "project",
    icon: Braces,
    run: () => {
      // At the Command library row, in view with its control focused, as a Settings search result
      // opens (0.1.2 UX sweep, W1-12); Robot opened at its top, with the row below the fold.
      openSettingsRow("robot", "settings-command-library");
    },
  },

  /* ---- Help ------------------------------------------------------------- */
  {
    id: "help.docs",
    label: "Documentation",
    keywords: ["docs", "documentation", "manual", "guide", "help", "reference", "wiki", "how to"],
    does: "Open the Zenith guide in a new tab.",
    group: "help",
    icon: BookOpen,
    external: true,
    run: () => {
      window.open(DOCS_URL, "_blank", "noopener");
    },
  },
  {
    id: "help.tour",
    label: "Take the tour",
    keywords: ["tour", "help", "tutorial", "guide", "walkthrough", "intro"],
    does: "A short walk through the field, steps, inspector and problems. Opens the example if none is open.",
    group: "help",
    icon: MapIcon,
    run: async () => {
      await withSomethingOpen();
      startCoreTour();
    },
  },
  {
    id: "help.fullTour",
    label: "Take the full tour",
    keywords: ["tour", "help", "tutorial", "guide", "walkthrough", "everything"],
    does: "Every tool, panel and feature, one at a time. Opens the example if nothing is open.",
    group: "help",
    icon: MapPlus,
    run: async () => {
      await withSomethingOpen();
      startFullTour();
    },
  },
  {
    id: "help.presets",
    label: "Choose a preset…",
    keywords: ["preset", "presets", "basic", "essential", "full", "settings", "features", "setup", "customize"],
    does: "Pick Basic, Essential or Full, or one of your own, in Settings. It sets which features you see.",
    group: "help",
    icon: SlidersHorizontal,
    run: () => {
      openSettings("presets");
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
  {
    id: "help.whatsThis",
    label: "What's this",
    keywords: ["what's this", "explain", "describe", "hint", "help", "tooltip", "what does this do"],
    does: "Show what a control or row does: the focused one, or the next one you click. Esc closes it.",
    shortcut: "whatsThis",
    group: "help",
    icon: MessageCircleQuestionMark,
    run: () => {
      if (explainFocused(document.activeElement)) return;
      // From a menu or the palette, focus is on the item, so there is nothing of its own to explain:
      // the next click asks instead (UX review, S14).
      startWhatsThis((message) => {
        setStatus("info", message);
      });
    },
  },
  {
    id: "help.reportBug",
    label: "Report a bug",
    keywords: ["bug", "report", "problem", "broken", "feedback", "crash", "issue", "support"],
    does: "Tell Horizon what went wrong. You see everything the report holds first, and it stays private.",
    group: "help",
    icon: Bug,
    run: () => {
      setDialog("reportBug");
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
      menuShortcut: DESKTOP_KEYS[entry.id],
      enabled: hasDocument,
      whyDisabled: NO_DOCUMENT,
    });
  }
}

/** The account's actions (src/account/actions.ts): an empty list unless the cloud is on. */
ACTIONS.push(...ACCOUNT_ACTIONS);

/**
 * Host mode (site/docs/host-protocol.md): another web app opened Zenith to edit its autos, so
 * the actions that reach for a folder, the example, GitHub or the robot repository go, Save sends
 * the auto to the host, and the host's own "Simulate in" and "New auto" join. Decided once, when
 * the page loads, the same way the desktop actions above are.
 */
const HOST_HIDDEN = new Set([
  "project.openFolder",
  "project.setUp",
  "project.example",
  "project.signIn",
  "project.signOut",
  "run.propose",
  "desktop.deploy",
  "desktop.git",
  "desktop.sim",
]);

/** Why Save to the host cannot run now, or null when it can. */
function hostSaveBlockedReason(state: State): string | null {
  if (state.auto === null) return NO_DOCUMENT();
  const view = state.host;
  if (view !== null && view.phase === "closed") {
    return `${closedLine(view)}, so there is nowhere to save. Save a copy to downloads keeps your edits.`;
  }
  if (view !== null && view.phase !== "open") return `Waiting for ${view.name} to send the project.`;
  // A host too old to read the format Zenith writes would refuse the save (sweep W4-1).
  if (view !== null && view.outdated !== null) return view.outdated;
  // One save at a time: the host's answer, or the wait running out, turns it back on.
  const saving = view?.saving ?? null;
  if (view !== null && saving !== null) return `Saving ${saving} to ${view.name} already.`;
  return null;
}

if (isHostMode()) {
  const name = hostName() ?? "the host";
  for (let index = ACTIONS.length - 1; index >= 0; index -= 1) {
    if (HOST_HIDDEN.has(ACTIONS[index]?.id ?? "")) ACTIONS.splice(index, 1);
  }
  const replace = (id: string, patch: Partial<ActionDef>): void => {
    const at = ACTIONS.findIndex((action) => action.id === id);
    const current = ACTIONS[at];
    if (current !== undefined) ACTIONS[at] = { ...current, ...patch };
  };
  replace("run.save", {
    label: `Save to ${name}`,
    keywords: ["write", "store", "keep", "send", name.toLowerCase()],
    does: `Send the auto to ${name}, which keeps it with your robot.`,
    doesFor: undefined,
    hint: undefined,
    run: () => save(),
    enabled: (state) => hostSaveBlockedReason(state) === null,
    whyDisabled: (state) => hostSaveBlockedReason(state) ?? "",
  });
  replace("run.simulate", {
    does: `Compare the plan with a simulated run: simulate in ${name}, or load a trace file.`,
  });
  replace("project.open", {
    label: "Open an auto",
    keywords: ["switch auto", "autos", "pick", name.toLowerCase()],
    does: `Pick another of the autos ${name} sent, or start a new one.`,
    enabled: (state) => state.project !== null,
    whyDisabled: () => `Waiting for ${name} to send the project.`,
  });
  ACTIONS.push(
    {
      id: "host.simulate",
      label: `Simulate in ${name}`,
      keywords: ["sim", "run", "trace", "full sim", name.toLowerCase()],
      does: `Run the auto in ${name}'s simulator and lay the recorded drive over the plan.`,
      group: "run",
      icon: Cpu,
      run: runInHost,
      enabled: () => hostRunBlockedReason() === null,
      whyDisabled: () => hostRunBlockedReason() ?? "",
    },
  );
  // The standalone New auto becomes the host's, which also puts the auto on the host's list.
  replace("project.newAuto", {
    keywords: ["create", "start", "blank", "add auto"],
    does: `Start a new auto for this robot. It stays in this window until you save it to ${name}.`,
    run: createHostAuto,
    enabled: () => newAutoBlockedReason() === null,
    whyDisabled: () => newAutoBlockedReason() ?? "",
  });
}

/**
 * Every action notes its id when it runs (`recentActions.ts`), for the Report a bug dialog's setup
 * block. Wrapped here, once the list is final, so the toolbar, the menus, the palette and the keyboard,
 * which all call `action.run`, need no change.
 */
for (const action of ACTIONS) {
  const run = action.run;
  action.run = () => {
    recordAction(action.id);
    return run();
  };
}

/** The named looks of the open field's picture, in file order. */
function fieldStyles(state: State): string[] {
  const field = state.autoField ?? state.project?.field;
  return field === undefined || field === null
    ? []
    : (readFieldImage(field)?.variants.map((variant) => variant.name) ?? []);
}

/** True when the open field's file names a picture to draw under the outlines (`field.image`). */
export function fieldHasPicture(state: State): boolean {
  const field = state.autoField ?? state.project?.field;
  return field !== undefined && field !== null && readFieldImage(field) !== null;
}

/** The tour needs something on the field to point at; with nothing open, that is the example. */
async function withSomethingOpen(): Promise<void> {
  // In host mode the project is the host's; the example would replace it.
  if (getState().auto === null && !isHostMode()) await loadExample();
}

export const actionById = (id: string): ActionDef | undefined =>
  ACTIONS.find((action) => action.id === id);

/**
 * The key the page itself handles for an action, as the person has it (`app/keymap.ts`): its default
 * from `shortcut`, a key they set in Settings, Keyboard, or none.
 */
export const pageShortcutOf = (action: ActionDef): string | undefined =>
  action.menuShortcut === undefined ? actionKeyLabel(action.id, action.shortcut) : undefined;

/**
 * The key shown for an action: the page's own, or the desktop menu's (`menuShortcut`) as the person
 * has it, which they may have changed in Settings, Keyboard or taken away.
 */
export const shortcutOf = (action: ActionDef): string | undefined =>
  action.menuShortcut === undefined ? pageShortcutOf(action) : menuKeyLabel(action.id, action.menuShortcut);

export const isEnabled = (action: ActionDef, state: State): boolean =>
  action.enabled === undefined ? true : action.enabled(state);

/** The label to show now: `labelFor`'s when the action has one, else its fixed `label`. */
export const labelOf = (action: ActionDef, state: State): string => action.labelFor?.(state) ?? action.label;

/**
 * The tooltip's second line for an action: why it is disabled when it is, else what it does,
 * followed by any live detail.
 */
export function tooltipHint(action: ActionDef, state: State): string {
  if (!isEnabled(action, state)) {
    const why = action.whyDisabled?.(state) ?? "";
    return why === "" ? action.does : `Unavailable: ${why}`;
  }
  const does = action.doesFor?.(state) ?? action.does;
  const extra = action.hint?.(state);
  return extra === undefined ? does : `${does} ${extra}`;
}

/** The toolbar's groups, left to right. */
export const TOOLBAR_GROUPS: string[][] = [
  ["tool.select", "tool.addPath", "tool.marker", "tool.heading", "tool.measure", "view.snap"],
  // Optimize path is a group of its own after the tools (issue #412), with a chevron for its menu;
  // its switch hides it.
  ["path.optimize"],
  ["edit.undo", "edit.redo"],
  // In host mode Save is the host bar's primary button (`project/hostPanel.tsx`), so it is not here twice.
  isHostMode() ? RUN_GROUP.filter((id) => !RUN_GROUP_NOT_IN_HOST.includes(id)) : [...RUN_GROUP],
  ...(isDesktop() && !isHostMode() ? [DESKTOP_ACTIONS.map((entry) => entry.id as string)] : []),
  ...(cloudEnabled() ? [SHARE_ACTIONS.map((action) => action.id)] : []),
  ["view.alliance"],
];

/**
 * A tool's options: switches the toolbar shows straight after the tool's button while it is the
 * tool. Each is an action of its own, so the palette finds it whichever tool is on (issue #204).
 */
export const TOOL_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  "tool.addPath": ["tool.extendChain"],
};

// Search actions has its own button beside the help button, so the help menu leaves it out (issue #412).
/** The help menu, in order. */
export const HELP_MENU: string[] = ["help.docs", "help.tour", "help.fullTour", "help.presets", "help.shortcuts", "help.whatsThis", "help.reportBug"];

/**
 * The Optimize button's menu on the toolbar (issue #366), opened by its chevron or a right-click on
 * the button (issue #412).
 */
export const OPTIMIZE_MENU: string[] = ["path.optimize", "path.optimizeWithOptions", "path.optimizeAll"];
