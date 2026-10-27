/**
 * Issue #243: a point selected on the field shows in place in the Inspector. The block of the
 * primary point takes the selected-row style, with several points selected only the primary one does,
 * a quiet line counts them, and none of it writes the Inspector's remembered folds.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { selectionOf } from "../canvas/selection";
import type { PointTarget, SelectedPoint, Selection } from "../canvas/types";
import { Section } from "../components/fields";
import { rememberFold } from "../components/foldMemory";
import { getState, setPrefs, setSelection } from "../state/store";
import { isPrimaryPoint, pointHolder, pointsSelectedLine } from "./pointSelection";

const to = (segmentIndex: number): PointTarget => ({ segmentIndex, pointKind: "to" });
const at = (stepId: string, point: PointTarget): SelectedPoint => ({ stepId, point });

describe("which block of the Inspector is the selected point", () => {
  it("is the end that was clicked, and no other end of the step", () => {
    const selection = selectionOf([at("driveOut", to(0))]);
    expect(isPrimaryPoint(selection, "driveOut", to(0))).toBe(true);
    expect(isPrimaryPoint(selection, "driveOut", { segmentIndex: 0, pointKind: "from" })).toBe(false);
    expect(isPrimaryPoint(selection, "driveOut", to(1))).toBe(false);
  });

  it("is not another step's end of the same place", () => {
    expect(isPrimaryPoint(selectionOf([at("driveOut", to(0))]), "other", to(0))).toBe(false);
  });

  it("tells control points apart by their index", () => {
    const control = (controlIndex: number): PointTarget => ({ segmentIndex: 0, pointKind: "control", controlIndex });
    const selection = selectionOf([at("curve", control(1))]);
    expect(isPrimaryPoint(selection, "curve", control(1))).toBe(true);
    expect(isPrimaryPoint(selection, "curve", control(0))).toBe(false);
  });

  it("is only the primary point when three are selected", () => {
    const selection = selectionOf([at("a", to(0)), at("b", to(0)), at("c", to(2))]);
    expect(isPrimaryPoint(selection, "c", to(2))).toBe(true);
    expect(isPrimaryPoint(selection, "a", to(0))).toBe(false);
    expect(isPrimaryPoint(selection, "b", to(0))).toBe(false);
  });

  it("is nothing when no point is selected", () => {
    expect(isPrimaryPoint({ stepId: "driveOut" }, "driveOut", to(0))).toBe(false);
    expect(isPrimaryPoint({}, "driveOut", to(0))).toBe(false);
  });
});

describe("the line that counts the selected points", () => {
  it("says nothing for none or one", () => {
    expect(pointsSelectedLine({})).toBeNull();
    expect(pointsSelectedLine(selectionOf([at("a", to(0))]))).toBeNull();
  });

  it("counts several, and the steps they are in", () => {
    const three = selectionOf([at("a", to(0)), at("a", to(1)), at("c", to(2))]);
    expect(pointsSelectedLine(three)).toBe("3 points in 2 steps");
    expect(pointsSelectedLine(selectionOf([at("a", to(0)), at("b", to(0))]))).toBe("2 points in 2 steps");
    expect(pointsSelectedLine(selectionOf([at("a", to(0)), at("a", to(1))]))).toBe("2 points in 1 step");
  });
});

describe("the name that holds a path open", () => {
  it("tells the ends and each control point apart, and is nothing with no point", () => {
    expect(pointHolder(to(0))).toBe("to");
    expect(pointHolder({ segmentIndex: 0, pointKind: "from" })).toBe("from");
    expect(pointHolder({ segmentIndex: 0, pointKind: "control", controlIndex: 1 })).toBe("control-1");
    expect(pointHolder({ segmentIndex: 0, pointKind: "control", controlIndex: 0 })).not.toBe("control-1");
    expect(pointHolder(undefined)).toBeUndefined();
  });
});

describe("the remembered folds", () => {
  // Renders the lone path's Section with the props PathInspector gives it for each selection, so a
  // Section that wrote the memory while a point holds it open fails here. Effects do not run in a
  // static render; e2e/inspector-point.spec.ts checks the same in the browser.
  const renderPath = (selection: Selection): string => {
    const held = selection.stepId === "driveOut" && selection.point?.segmentIndex === 0;
    return renderToStaticMarkup(
      h(Section, {
        title: "Path 1",
        foldId: "path.segment",
        forceOpen: held,
        holder: held ? pointHolder(selection.point) : undefined,
        children: h("p", { "data-testid": "the-body" }, "body"),
      }),
    );
  };

  it("are the same after a point is selected and deselected, while the path shows over a folded memory", () => {
    setPrefs({ inspectorFolds: {} });
    rememberFold("path.segment", false);
    const before = getState().prefs.inspectorFolds;
    const steps: Selection[] = [
      { stepId: "driveOut", point: to(0) },
      selectionOf([at("driveOut", to(0)), at("driveOut", { segmentIndex: 0, pointKind: "from" })]),
      {},
    ];
    const shown = steps.map((selection) => {
      setSelection(selection);
      return renderPath(selection).includes("the-body");
    });
    expect(shown).toEqual([true, true, false]);
    expect(getState().prefs.inspectorFolds).toBe(before);
    expect(getState().prefs.inspectorFolds).toEqual({ "path.segment": false });
  });
});
