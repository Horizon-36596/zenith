/**
 * The field canvas's right-click menu, built from the one action table, so each item reads, runs
 * and is disabled exactly as its toolbar button, palette row and shortcut are
 * (site/docs/editor.md). The canvas selects what was right-clicked before it asks,
 * and appends its own items (smooth or corner point, split here, zoom) after these.
 */
import { removeMarker } from "@horizon36596/zenith-core";
import type { CanvasAction, CanvasActions, CanvasMenuTarget } from "../canvas/types";
import { getState, setTool } from "../state/store";
import { openInsertMenu } from "../state/ui";
import { actionById, isEnabled, shortcutOf } from "./actions";
import { addPathStepTo, tryEdit } from "./edits";

/** The action ids offered for each kind of thing under the pointer, in order; "|" is a separator. */
const MENU: Record<CanvasMenuTarget["kind"], readonly string[]> = {
  point: ["insert.path", "step.insertMenu", "|", "edit.duplicate", "edit.delete", "|", "edit.wrapSequence", "edit.wrapParallel", "edit.unwrap"],
  path: ["insert.path", "step.insertMenu", "tool.marker", "|", "edit.duplicate", "edit.delete", "|", "edit.wrapSequence", "edit.wrapParallel", "edit.unwrap"],
  marker: ["marker.delete"],
  field: ["field.addPathHere", "tool.addPath", "tool.measure", "|", "view.snap", "view.fieldView", "view.fieldStyle"],
};

function fromTable(id: string, separatorBefore: boolean): CanvasAction | null {
  const action = actionById(id);
  if (action === undefined) return null;
  const state = getState();
  const enabled = isEnabled(action, state);
  return {
    id: action.id,
    label: action.label,
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
        label: "Insert another kind after…",
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
        label: "Add a path to here",
        enabled: editable,
        disabledReason: editable ? undefined : "Review mode is read only.",
        separatorBefore,
        run: () => {
          addPathStepTo({ xIn: target.atIn.xIn, yIn: target.atIn.yIn, headingRad: 0 });
          setTool("select");
        },
      };
    case "marker.delete": {
      const { stepId, markerIndex } = target;
      const can = editable && stepId !== undefined && markerIndex !== undefined;
      return {
        id,
        label: "Delete marker",
        shortcut: "Del",
        enabled: can,
        disabledReason: can ? undefined : "There is no marker here to delete.",
        separatorBefore,
        run: () => {
          if (stepId === undefined || markerIndex === undefined) return;
          tryEdit((auto) => removeMarker(auto, stepId, markerIndex));
        },
      };
    }
    default:
      return null;
  }
}

export const canvasActions: CanvasActions = (target) => {
  const items: CanvasAction[] = [];
  let separator = false;
  for (const id of MENU[target.kind]) {
    if (id === "|") {
      separator = items.length > 0;
      continue;
    }
    const item = local(id, target, separator) ?? fromTable(id, separator);
    if (item === null) continue;
    items.push(item);
    separator = false;
  }
  return items;
};
