/**
 * The pieces the sharing sheets are built from: the non-modal sheet frame and a button that stays
 * focusable while it cannot act so its tooltip can say why. Their segmented switch is the shared
 * one in `components/Segmented.tsx`.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Tooltip, type TooltipProps } from "../components/Tooltip";
import { RowButton } from "../components/primitives";
import { HelpTip } from "../help/HelpTip";
import type { PanelHelpId } from "../help/content";
import { focusForInput } from "../components/inputModality";
import styles from "./cloud.module.css";

/**
 * A sheet docked at the right of the window. It is not modal (spec 11 section 1): no backdrop, no
 * focus trap, and every other control keeps working while it is open. Escape closes it while
 * focus is inside it, and focus goes back to whatever had it when it opened.
 */
export function Sheet({
  title,
  help,
  testId,
  widthPx,
  onClose,
  lead,
  footer,
  children,
}: {
  title: string;
  help: PanelHelpId;
  testId: string;
  widthPx: number;
  onClose: () => void;
  /** What stays in view above the scrolling body, such as the share dialog's sentence. */
  lead?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const ref = useRef<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);
  if (openerRef.current === undefined) {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  useEffect(() => {
    const opener = openerRef.current ?? null;
    focusForInput(ref.current, { preventScroll: true });
    return () => {
      const active = document.activeElement;
      const lostFocus = active === null || active === document.body;
      if (lostFocus && opener !== null && opener.isConnected) focusForInput(opener, { preventScroll: true });
    };
  }, []);

  return (
    <section
      ref={ref}
      className={styles.sheet}
      style={{ width: `${String(widthPx)}px` }}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-testid={testId}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // The editor's own Escape (clear the selection) listens on the window; this one is the sheet's.
        event.stopPropagation();
        onClose();
      }}
    >
      <header className={styles.sheetHead}>
        <h2 id={titleId} className={styles.sheetTitle}>
          {title}
        </h2>
        <HelpTip id={help} />
        <span className={styles.spacer} />
        <RowButton icon={X} label="Close" shortcut="Esc" hint="Close this panel. Nothing is sent." onClick={onClose} testId={`${testId}-close`} />
      </header>
      {lead === undefined ? null : <div className={styles.sheetLead}>{lead}</div>}
      <div className={styles.sheetBody}>{children}</div>
      {footer === undefined ? null : <div className={styles.sheetFoot}>{footer}</div>}
    </section>
  );
}

/**
 * A text button with a tooltip. Disabled is `aria-disabled`, never `disabled`, so the tooltip that
 * says why stays reachable by pointer and keyboard.
 */
export function SheetButton({
  children,
  tooltip,
  hint,
  whyDisabled,
  kind = "secondary",
  side,
  onClick,
  testId,
}: {
  children: ReactNode;
  /** The action, in sentence case, for the tooltip's first line. */
  tooltip: string;
  hint?: string;
  /** Why the button cannot act now; null or absent when it can. */
  whyDisabled?: string | null;
  kind?: "primary" | "secondary" | "text";
  /** Where the tooltip opens; below by default. Above, for a button with a control right under it. */
  side?: TooltipProps["side"];
  onClick: () => void;
  testId?: string;
}) {
  const disabled = whyDisabled !== undefined && whyDisabled !== null;
  const className = kind === "primary" ? styles.primary : kind === "text" ? styles.textButton : styles.button;
  return (
    <Tooltip label={tooltip} hint={disabled ? `Unavailable: ${whyDisabled}` : hint} {...(side === undefined ? {} : { side })}>
      <button
        type="button"
        className={className}
        aria-disabled={disabled}
        data-testid={testId}
        onClick={() => {
          if (!disabled) onClick();
        }}
      >
        {children}
      </button>
    </Tooltip>
  );
}

