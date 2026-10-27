/**
 * Row hints (issue #237, UI_GUIDE section 9.4). A row with a `hint` (an Inspector field row, a
 * Settings row) makes its label the trigger of a long-hover tooltip that opens after
 * `--hint-delay`, and the same words are always the `aria-describedby` of the row's controls, so a
 * screen reader hears what the hover shows. Shift F1 on any of those controls opens the hint.
 */
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode, type RefObject } from "react";
import { Tooltip } from "./Tooltip";
import { RowHintContext, joinIds } from "./rowHintContext";

/** Controls that take an `aria-describedby` straight from the row; a `Tooltip` reads the context. */
const NATIVE_CONTROLS = new Set(["input", "select", "textarea", "button"]);

/**
 * Whether a child takes the row's `aria-describedby`: a native control, or any element given a
 * `tabIndex`, such as a read-only value made focusable so that a screen reader and Shift F1 reach it.
 */
function takesDescription(child: ReactElement): boolean {
  if (typeof child.type !== "string") return false;
  return NATIVE_CONTROLS.has(child.type) || (child.props as { tabIndex?: number }).tabIndex !== undefined;
}

function describeControls(children: ReactNode, hintId: string): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement(child) || !takesDescription(child)) return child;
    const own = (child.props as { "aria-describedby"?: string })["aria-describedby"];
    return cloneElement(child as ReactElement<Record<string, unknown>>, { "aria-describedby": joinIds(own, hintId) });
  });
}

/** The row's label, as the hint's long-hover trigger when there is a hint. */
export function HintLabel({
  label,
  hint,
  explains,
  children,
}: {
  label: string;
  hint: string | undefined;
  /** The row's controls: Shift F1 on any of them opens this hint. */
  explains: RefObject<HTMLElement | null>;
  children: ReactElement;
}) {
  if (hint === undefined) return children;
  return (
    <Tooltip label={label} hint={hint} delay="long" explains={explains}>
      {children}
    </Tooltip>
  );
}

/** The row's controls, each described by the hint, and the hint's hidden text. */
export function HintedControls({ hint, hintId, children }: { hint: string | undefined; hintId: string; children: ReactNode }) {
  if (hint === undefined) return <>{children}</>;
  return (
    <RowHintContext.Provider value={hintId}>
      {describeControls(children, hintId)}
      {/* Hidden outright, so it takes no box beside the value: a description may point at hidden text. */}
      <span id={hintId} hidden>
        {hint}
      </span>
    </RowHintContext.Provider>
  );
}
