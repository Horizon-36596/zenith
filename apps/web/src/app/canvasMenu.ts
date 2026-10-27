/**
 * The field canvas's right-click menu, built from the one action table, so each item reads, runs
 * and is disabled exactly as its toolbar button, palette row and shortcut are
 * (site/docs/editor.md). The canvas selects what was right-clicked before it asks,
 * and appends its own items (smooth or corner point, split here) after these.
 *
 * Issue #412: a menu shows only what applies to what was right-clicked. An item that can never work
 * for this target is left out rather than greyed (the other of Make curve and Make straight line,
 * Unwrap group outside a group, the field picture's items on a field with none), tools and zooms
 * are left to the toolbar, the keys and the field's corner controls, and a pin's own items sit under
 * a group label. A greyed item that stays shows its reason in the row.
 */
import { Copy, Eye, EyeOff, Flag, MousePointer2, Pencil, Plus, Slash, Spline, Trash, Ungroup, WandSparkles, Zap } from "lucide-react";
import { focusForInput } from "../components/inputModality";
import { WAYPOINT_PINS_LABEL, type WaypointPinsMode } from "../state/waypointPins";
import { ADD_POINT_MIN_IN } from "../canvas/pointDrag";
import type { CanvasAction, CanvasActions, CanvasMenuTarget } from "../canvas/types";
import { requestCanvasZoom, zoomItems } from "../canvas/zoomRequest";
import { getState, hiddenWaypoints, selectStep, setSelection, setTool, setWaypointPinShown, setWaypointPins } from "../state/store";
import { openInsertMenu } from "../state/ui";
import { CLEAR_PATH_HINT, CLEAR_PATH_LABEL } from "../optimize/clearPath";
import { openClearPath } from "../optimize/state";
import { actionShown } from "../state/features";
import { findEntry, isPathStep } from "../lib/stepOps";
import { unwrapBlockedReason, unwrapStep } from "../lib/structure";
import { actionById, isEnabled, labelOf, shortcutOf } from "./actions";
import { addPathStepTo, anchorEndPose, deleteMarker, deletePoint, deleteStep, ownerSource, pointDeletePlan, setSegmentKindAt, tryEdit, type PoseOwner } from "./edits";
import { segmentAtT, segmentKindBlocked } from "./segmentKind";
import { askAddWaypoint, askAddWaypointAt, askDeleteWaypoint, askRenameWaypoint } from "./waypointDialog";
import { copyWaypointPosition, selectFollowersOf, waypointEditingOff, whyNoFollowers, whyNoWaypointAt, whyNoWaypointFrom } from "./waypointEdits";

/** The action ids offered for each kind of thing under the pointer, in order; "|" is a separator. */
const FIELD_ITEMS = ["field.addPathHere", "field.addWaypointHere", "field.addClearPathHere", "|", "pins", "|", "view.fieldView", "view.fieldStyle"] as const;

/**
 * What a point or the start can do with a waypoint: the pin it follows, as a group of the pin's own
 * items, the pins it covers, or saving itself as one.
 */
const FOLLOW_ITEMS = ["waypoint.followGroup", "|", "waypoint.nearSelect", "waypoint.saveAs"] as const;

/** The menus, by what was right-clicked. A curve's control point (`control`) has a menu of its own. */
const MENU: Record<CanvasMenuTarget["kind"] | "control", readonly string[]> = {
  point: ["insert.path", "insert.turn", "step.insertMenu", "|", "edit.duplicate", "point.delete", "edit.delete", "|", ...FOLLOW_ITEMS, "|", "edit.wrapSequence", "edit.wrapParallel", "edit.unwrap"],
  control: ["point.delete"],
  waypoint: ["waypoint.rename", "waypoint.delete", "|", "waypoint.hide", "waypoint.copyPosition", "waypoint.selectFollowers"],
  start: [...FOLLOW_ITEMS, "|", ...FIELD_ITEMS],
  path: ["insert.path", "insert.turn", "step.insertMenu", "|", "edit.makeCurve", "edit.makeLine", "|", "edit.duplicate", "edit.delete", "|", "edit.wrapSequence", "edit.wrapParallel", "edit.unwrap"],
  marker: ["marker.changeCommand", "marker.delete"],
  field: FIELD_ITEMS,
};

/** Table items left out of a menu, rather than greyed, while they cannot run (issue #412). */
const HIDDEN_WHILE_OFF: ReadonlySet<string> = new Set(["view.fieldView", "view.fieldStyle"]);

/** The field menu's pin choices, in the words every surface uses (`WAYPOINT_PINS_LABEL`, issue #412). */
const PIN_CHOICES: readonly { mode: WaypointPinsMode; label: string }[] = [
  { mode: "all", label: WAYPOINT_PINS_LABEL.all },
  { mode: "used", label: WAYPOINT_PINS_LABEL.used },
  { mode: "none", label: WAYPOINT_PINS_LABEL.none },
];

/** The pose owner a point or start target stands for, or null for a curve's control point or any other target. */
function ownerOf(target: CanvasMenuTarget): PoseOwner | null {
  if (target.kind === "start") return "start";
  const { stepId, point } = target;
  if (target.kind !== "point" || stepId === undefined || point === undefined || point.pointKind === "control") return null;
  return { stepId, point: { segmentIndex: point.segmentIndex, pointKind: point.pointKind } };
}

/** The waypoint the owner follows in the open auto, or null for a pose of its own. */
function followedBy(owner: PoseOwner): string | null {
  const auto = getState().auto;
  const source = auto === null ? undefined : ownerSource(auto, owner);
  return source === undefined || source === "current" || !("ref" in source) ? null : source.ref;
}

/**
 * The words an item of the table says on a step's or a path's menu, where it acts after that step:
 * the same as the step list's menu says (issue #505).
 */
const AFTER_LABEL: Readonly<Record<string, string>> = {
  "insert.path": "Insert a path after",
};

/** "Insert another step after…", the same on the field's menu and the step list's (issue #505). */
export const INSERT_ANOTHER_LABEL = "Insert another step after…";

function fromTable(id: string, separatorBefore: boolean): CanvasAction | null {
  const action = actionById(id);
  const state = getState();
  if (action === undefined || !actionShown(id, state.prefs.features)) return null;
  const enabled = isEnabled(action, state);
  return {
    id: action.id,
    label: AFTER_LABEL[id] ?? labelOf(action, state),
    icon: action.icon,
    shortcut: shortcutOf(action),
    enabled,
    disabledReason: enabled ? undefined : action.whyDisabled?.(state),
    separatorBefore,
    run: () => {
      void action.run();
    },
  };
}

/** Items that only make sense with the pointer's own target, so they are not in the table. */
function local(id: string, target: CanvasMenuTarget, separatorBefore: boolean): CanvasAction | null {
  const state = getState();
  const editable = state.review === null && state.auto !== null;
  switch (id) {
    case "step.insertMenu":
      return {
        id,
        label: INSERT_ANOTHER_LABEL,
        icon: Plus,
        shortcut: "Enter",
        enabled: editable,
        disabledReason: editable ? undefined : "Review mode is read only.",
        separatorBefore,
        run: () => {
          openInsertMenu();
        },
      };
    case "field.addPathHere":
      return {
        id,
        label: "Add a path here",
        icon: Spline,
        enabled: editable,
        disabledReason: editable ? undefined : "Review mode is read only.",
        separatorBefore,
        run: () => {
          // Where an Add path click there would put the point, snapped the same way, and the
          // waypoint it snapped onto (issue #150). Where a click would add nothing, the spot itself.
          const snapped = target.snappedIn;
          if (snapped === undefined) {
            // Facing the way it drives there, so a Linear new path turns to that heading. A spot
            // closer than an Add path click accepts (`ADD_POINT_MIN_IN`) has no bearing worth
            // turning to, so the path keeps the heading the robot arrives with, as `placeAddPoint` does.
            const from = anchorEndPose();
            const awayIn = Math.hypot(target.atIn.xIn - from.xIn, target.atIn.yIn - from.yIn);
            const headingRad =
              awayIn < ADD_POINT_MIN_IN ? from.headingRad : Math.atan2(target.atIn.yIn - from.yIn, target.atIn.xIn - from.xIn);
            addPathStepTo({ xIn: target.atIn.xIn, yIn: target.atIn.yIn, headingRad });
          } else {
            addPathStepTo({ xIn: snapped.xIn, yIn: snapped.yIn, headingRad: snapped.headingRad }, snapped.waypoint);
          }
          setTool("select");
        },
      };
    case "field.addClearPathHere": {
      // Add a clear path here (issue #310): the same point Add a path to here would take, as a
      // draft the Optimize card routes round the structures before anything is written. The
      // Optimize path switch's gates hide it.
      const snapped = target.snappedIn;
      const why = !editable ? (state.review === null ? "Open an auto first." : "Review mode is read only.") : null;
      return {
        id,
        label: CLEAR_PATH_LABEL,
        hint: CLEAR_PATH_HINT,
        icon: WandSparkles,
        enabled: why === null,
        disabledReason: why ?? undefined,
        separatorBefore,
        run: () => {
          openClearPath(snapped === undefined ? target.atIn : { xIn: snapped.xIn, yIn: snapped.yIn, waypoint: snapped.waypoint });
          setTool("select");
        },
      };
    }
    case "field.addWaypointHere": {
      // A waypoint at the spot an Add path click there would pick, with that click's heading, and
      // no path step: the auto does not change (issue #234).
      const snapped = target.snappedIn;
      const why = !editable ? "Review mode is read only." : whyNoWaypointAt(snapped);
      return {
        id,
        label: "Add a waypoint here",
        icon: Flag,
        enabled: why === null,
        disabledReason: why ?? undefined,
        separatorBefore,
        run: () => {
          if (snapped !== undefined) askAddWaypointAt(snapped);
        },
      };
    }
    case "waypoint.rename":
    case "waypoint.delete": {
      // The pin the right-click selected: its own Rename… and Delete…, with the keys that do the same.
      const name = target.waypoint;
      const rename = id === "waypoint.rename";
      const why = !editable ? "Review mode is read only." : name === undefined ? "There is no waypoint here." : waypointEditingOff(state);
      return {
        id,
        label: rename ? "Rename…" : "Delete…",
        icon: rename ? Pencil : Trash,
        shortcut: rename ? "F2" : "Del",
        enabled: why === null,
        disabledReason: why ?? undefined,
        separatorBefore,
        run: () => {
          if (name === undefined) return;
          if (rename) askRenameWaypoint(name);
          else askDeleteWaypoint(name);
        },
      };
    }
    case "waypoint.hide": {
      // This person's view only (issue #236): hiding never changes waypoints.json, undo or Save.
      const name = target.waypoint;
      const hidden = name !== undefined && hiddenWaypoints(state).has(name);
      return {
        id,
        label: hidden ? "Show" : "Hide",
        icon: hidden ? Eye : EyeOff,
        enabled: name !== undefined,
        disabledReason: name === undefined ? "There is no waypoint here." : undefined,
        separatorBefore,
        run: () => {
          if (name !== undefined) setWaypointPinShown(name, hidden);
        },
      };
    }
    case "waypoint.copyPosition": {
      const name = target.waypoint;
      return {
        id,
        label: "Copy position",
        icon: Copy,
        enabled: name !== undefined,
        disabledReason: name === undefined ? "There is no waypoint here." : undefined,
        separatorBefore,
        run: () => {
          if (name !== undefined) void copyWaypointPosition(name);
        },
      };
    }
    case "waypoint.selectFollowers": {
      const name = target.waypoint;
      const why = name === undefined ? "There is no waypoint here." : whyNoFollowers(name);
      return {
        id,
        label: "Select the points that follow it",
        icon: MousePointer2,
        enabled: why === null,
        disabledReason: why ?? undefined,
        separatorBefore,
        run: () => {
          if (name !== undefined) selectFollowersOf(name);
        },
      };
    }
    case "edit.unwrap": {
      // Issue #412: on a path inside a group, Unwrap group unwraps that group; anywhere else it is
      // left out. A point's menu acts on the step it belongs to, as the path's does.
      const auto = state.auto;
      const parentId = auto === null || target.stepId === undefined ? undefined : findEntry(auto, target.stepId)?.parentId;
      const parent = auto === null || parentId === undefined ? undefined : findEntry(auto, parentId);
      if (parent === undefined || parentId === undefined) return null;
      const why = !editable ? "Review mode is read only." : unwrapBlockedReason(parent.step);
      const stepId = target.stepId;
      return {
        id,
        label: actionById(id)?.label ?? "Unwrap group",
        icon: Ungroup,
        enabled: why === null,
        disabledReason: why ?? undefined,
        separatorBefore,
        run: () => {
          tryEdit((current) => unwrapStep(current, parentId));
          if (stepId !== undefined) selectStep(stepId);
        },
      };
    }
    default:
      return localMore(id, target, separatorBefore);
  }
}

/**
 * The items a menu builds as a group, under a label (issue #412): the pin a point or the start
 * follows, as "Waypoint <name>" with Select and its Rename, Hide and Select the points that follow it, and the field's three
 * pin choices under "Show waypoint pins". Empty where the group does not apply.
 */
function groupItems(id: string, target: CanvasMenuTarget, separatorBefore: boolean): CanvasAction[] {
  const state = getState();
  const editable = state.review === null && state.auto !== null;
  if (id === "pins") {
    const current = state.prefs.waypointPins;
    return PIN_CHOICES.map((choice, index) => ({
      id: `pins.${choice.mode}`,
      label: choice.label,
      enabled: true,
      checked: current === choice.mode,
      // The label says what the three choices decide, as the Settings row does (issue #505).
      ...(index === 0 ? { groupLabel: PINS_GROUP_LABEL, separatorBefore } : {}),
      run: () => {
        setWaypointPins(choice.mode);
      },
    }));
  }
  if (id !== "waypoint.followGroup") return [];
  // On a point or the start that follows a waypoint: the pin its dot or the start mark covers.
  const owner = ownerOf(target);
  const follows = owner === null ? null : followedBy(owner);
  if (follows === null) return [];
  const items = FOLLOW_GROUP.map((itemId) => followItem(itemId, follows, editable));
  return items.map((item, index) => (index === 0 ? { ...item, groupLabel: `Waypoint ${follows}`, separatorBefore } : item));
}

/** The label over the field menu's pin choices: what they decide. */
export const PINS_GROUP_LABEL = "Show waypoint pins";

/** The items under "Waypoint <name>" for the pin a point or the start follows, in order. */
const FOLLOW_GROUP = ["waypoint.followSelect", "waypoint.followRename", "waypoint.followHide", "waypoint.followSelectFollowers"] as const;

/** One item of the followed pin's group (issue #412). */
function followItem(id: (typeof FOLLOW_GROUP)[number], follows: string, editable: boolean): CanvasAction {
  const state = getState();
  switch (id) {
    case "waypoint.followSelect":
      // The way to the pin the dot or the start mark covers (issue #233), and from it to the pin's whole menu.
      return {
        id,
        label: "Select",
        icon: MousePointer2,
        enabled: true,
        run: () => {
          setSelection({ waypoint: follows });
        },
      };
    case "waypoint.followRename": {
      const why = !editable ? "Review mode is read only." : waypointEditingOff(state);
      return {
        id,
        label: "Rename…",
        icon: Pencil,
        enabled: why === null,
        disabledReason: why ?? undefined,
        run: () => {
          askRenameWaypoint(follows);
        },
      };
    }
    case "waypoint.followHide": {
      const hidden = hiddenWaypoints(state).has(follows);
      return {
        id,
        label: hidden ? "Show" : "Hide",
        icon: hidden ? Eye : EyeOff,
        enabled: state.project !== null,
        disabledReason: state.project === null ? "Open a project first." : undefined,
        run: () => {
          setWaypointPinShown(follows, hidden);
        },
      };
    }
    case "waypoint.followSelectFollowers": {
      const why = whyNoFollowers(follows);
      return {
        id,
        label: "Select the points that follow it",
        icon: MousePointer2,
        enabled: why === null,
        disabledReason: why ?? undefined,
        run: () => {
          selectFollowersOf(follows);
        },
      };
    }
  }
}

/** Items that only make sense with the pointer's own target, continued. */
function localMore(id: string, target: CanvasMenuTarget, separatorBefore: boolean): CanvasAction | null {
  const state = getState();
  const editable = state.review === null && state.auto !== null;
  switch (id) {
    case "waypoint.saveAs": {
      // A point with a pose of its own, or the start, can become a waypoint that it then follows.
      const owner = ownerOf(target);
      if (owner === null || followedBy(owner) !== null) return null;
      const why = !editable ? "Review mode is read only." : whyNoWaypointFrom(owner);
      return {
        id,
        label: "Save as waypoint…",
        icon: Flag,
        enabled: why === null,
        disabledReason: why ?? undefined,
        separatorBefore,
        run: () => {
          askAddWaypoint(owner);
        },
      };
    }
    case "marker.changeCommand": {
      // The command a placed marker runs was picked for the person, so its menu leads with changing
      // it: the marker is selected and the Inspector's Command picker takes focus (issue #505).
      const { stepId, markerIndex } = target;
      const can = editable && stepId !== undefined && markerIndex !== undefined;
      return {
        id,
        label: "Change command…",
        icon: Zap,
        enabled: can,
        disabledReason: can ? undefined : editable ? "There is no marker here." : "Review mode is read only.",
        separatorBefore,
        run: () => {
          if (stepId === undefined || markerIndex === undefined) return;
          setSelection({ stepId, markerIndex });
          focusMarkerCommandPicker();
        },
      };
    }
    case "marker.delete": {
      const { stepId, markerIndex } = target;
      const can = editable && stepId !== undefined && markerIndex !== undefined;
      return {
        id,
        label: "Delete marker",
        icon: Trash,
        shortcut: "Del",
        enabled: can,
        disabledReason: can ? undefined : "There is no marker here to delete.",
        separatorBefore,
        run: () => {
          if (stepId === undefined || markerIndex === undefined) return;
          deleteMarker(stepId, markerIndex);
        },
      };
    }
    case "point.delete": {
      // Just this point (issue #185); a point that cannot go alone says why and leaves Delete step.
      const { stepId, point } = target;
      const del = actionById("edit.delete");
      const plan = state.auto === null || stepId === undefined || point === undefined ? null : pointDeletePlan(state.auto, stepId, point);
      const why = !editable
        ? "Review mode is read only."
        : plan === null
          ? "There is no point here."
          : plan.kind === "step"
            ? plan.why
            : undefined;
      return {
        id,
        label: "Delete point",
        icon: Trash,
        shortcut: why === undefined && del !== undefined ? shortcutOf(del) : undefined,
        enabled: why === undefined,
        disabledReason: why,
        separatorBefore,
        run: () => {
          if (stepId !== undefined && point !== undefined) deletePoint(stepId, point);
        },
      };
    }
    case "edit.delete": {
      // On a point, Delete step deletes the step, whatever Del does to the point.
      const action = actionById(id);
      const { stepId, point } = target;
      if (target.kind !== "point" || action === undefined || stepId === undefined) return null;
      const pointGoesAlone = state.auto !== null && point !== undefined && pointDeletePlan(state.auto, stepId, point).kind !== "step";
      return {
        id,
        label: action.label,
        icon: action.icon,
        shortcut: pointGoesAlone ? undefined : shortcutOf(action),
        enabled: editable,
        disabledReason: editable ? undefined : "Review mode is read only.",
        separatorBefore,
        run: () => {
          deleteStep(stepId);
        },
      };
    }
    case "edit.makeCurve":
    case "edit.makeLine": {
      // The segment under the pointer, not the palette's pick (issue #143).
      const kind = id === "edit.makeCurve" ? "bezier" : "line";
      const { stepId, t } = target;
      const segmentIndex = stepId === undefined || t === undefined ? null : segmentAtT(stepId, t);
      // Only the one that changes something shows (issue #412): never Make curve on a curve.
      const step = state.auto === null || stepId === undefined ? undefined : findEntry(state.auto, stepId)?.step;
      const segment = step !== undefined && isPathStep(step) && segmentIndex !== null ? step.segments[segmentIndex] : undefined;
      if (segment?.kind === kind) return null;
      const why =
        stepId === undefined || segmentIndex === null
          ? "There is no path here."
          : segmentKindBlocked(state, { stepId, segmentIndex }, kind);
      return {
        id,
        label: actionById(id)?.label ?? id,
        icon: kind === "bezier" ? Spline : Slash,
        enabled: why === null,
        disabledReason: why ?? undefined,
        separatorBefore,
        run: () => {
          if (stepId !== undefined && segmentIndex !== null) setSegmentKindAt(stepId, segmentIndex, kind);
        },
      };
    }
    default:
      return null;
  }
}

/**
 * One "Select waypoint X" for each pin the dot or the start mark covers that is not the waypoint the
 * point follows (that one has its own item above): the way to a pin no point of this auto follows.
 */
function nearSelects(target: CanvasMenuTarget, separatorBefore: boolean): CanvasAction[] {
  // A curve's control point is not a pose, so it never covers a pin in the sense this menu means.
  if (target.kind === "point" && target.point?.pointKind === "control") return [];
  const owner = ownerOf(target);
  const follows = owner === null ? null : followedBy(owner);
  const names = (target.nearWaypoints ?? []).filter((name) => name !== follows);
  return names.map((name, index) => ({
    id: `waypoint.select:${name}`,
    label: `Select waypoint ${name}`,
    icon: MousePointer2,
    enabled: true,
    separatorBefore: separatorBefore && index === 0,
    run: () => {
      setSelection({ waypoint: name });
    },
  }));
}

export const canvasActions: CanvasActions = (target) => {
  const items: CanvasAction[] = [];
  let separator = false;
  const kind = target.kind === "point" && target.point?.pointKind === "control" ? "control" : target.kind;
  for (const id of MENU[kind]) {
    if (id === "|") {
      separator = items.length > 0;
      continue;
    }
    if (id === "waypoint.nearSelect") {
      const near = nearSelects(target, separator);
      items.push(...near);
      if (near.length > 0) separator = false;
      continue;
    }
    const features = getState().prefs.features;
    if (id === "pins" || id === "waypoint.followGroup") {
      // A group keeps its label on its first item that a switch leaves in.
      if (id === "pins" && !actionShown("view.waypointPins", features)) continue;
      const all = groupItems(id, target, false);
      const groupLabel = all[0]?.groupLabel;
      const shown = all.filter((item) => actionShown(item.id, features));
      shown.forEach((item, index) => {
        items.push(index === 0 ? { ...item, groupLabel, separatorBefore: separator } : { ...item, groupLabel: undefined, separatorBefore: false });
      });
      if (shown.length > 0) separator = false;
      continue;
    }
    // A switch that is off takes its items out of every menu, the local ones as well as the table's.
    if (!actionShown(id, features)) continue;
    const item = LOCAL_ONLY.has(id) ? local(id, target, separator) : (local(id, target, separator) ?? fromTable(id, separator));
    if (item === null) continue;
    // An item of the table that cannot run here and is no use greyed is left out (issue #412).
    if (HIDDEN_WHILE_OFF.has(id) && !item.enabled) continue;
    items.push(item);
    separator = false;
  }
  return items;
};

/** The ids `local` alone answers, so a null from it leaves the item out rather than reaching the table. */
const LOCAL_ONLY: ReadonlySet<string> = new Set([
  "step.insertMenu",
  "field.addPathHere",
  "field.addClearPathHere",
  "field.addWaypointHere",
  "waypoint.rename",
  "waypoint.delete",
  "waypoint.hide",
  "waypoint.copyPosition",
  "waypoint.selectFollowers",
  "waypoint.saveAs",
  "marker.changeCommand",
  "marker.delete",
  "point.delete",
  "edit.makeCurve",
  "edit.makeLine",
  "edit.unwrap",
]);

/** Puts focus on the Inspector's Command picker of the selected marker, once it has rendered. */
function focusMarkerCommandPicker(tries = 6): void {
  window.requestAnimationFrame(() => {
    const picker = document.querySelector<HTMLElement>('[data-testid="inspector-marker-command"]');
    if (picker !== null) focusForInput(picker, { preventScroll: false });
    else if (tries > 0) focusMarkerCommandPicker(tries - 1);
  });
}

/**
 * The menu of the Inspector's ⋯ on a waypoint row (issue #245): the items a right-click on that pin
 * shows, in the same order, then the same two zooms, which ask the canvas to run them. The caller
 * selects the pin first, as the right-click does.
 */
export function pinMenuItems(name: string): CanvasAction[] {
  const pose = getState().project?.waypoints?.waypoints[name];
  const atIn = pose === undefined ? { xIn: 0, yIn: 0 } : { xIn: pose.xIn, yIn: pose.yIn };
  const items = canvasActions({ kind: "waypoint", waypoint: name, atIn });
  const zooms = zoomItems("waypoint", {
    selection: () => {
      requestCanvasZoom("selection");
    },
    fit: () => {
      requestCanvasZoom("fit");
    },
  });
  if (items.length > 0 && zooms[0] !== undefined) zooms[0] = { ...zooms[0], separatorBefore: true };
  return [...items, ...zooms];
}
