/**
 * The Inspector's selection header (issue #431, UI_GUIDE section 9.3): one 40 px row in place of
 * the region title "Inspector", saying what is selected. Left to right: the kind's icon (its word is
 * the icon's accessible name and tooltip), the id in Jost, then at the right the facts that need no
 * row, such as the anchor of a command that stands still, the estimate in quiet mono, at most one
 * header action and the `?`. A marker's header is a breadcrumb, `collectFlower › Marker 1`, whose
 * path name selects the path. The region keeps `aria-label="Inspector"` on its panel.
 *
 * A fact drawn as an icon keeps its words for screen readers and, in With descriptions, shows them
 * beside the icon (`HeaderMark`), so a new student never has to hover to learn what it means.
 */
import { useId, type ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { HintedControls } from "../components/rowHint";
import { Tooltip } from "../components/Tooltip";
import { HelpTip } from "../help/HelpTip";
import type { PanelHelpId } from "../help/content";
import { useDescriptions } from "../help/descriptions/useDescriptions";
import styles from "./Inspector.module.css";

export interface HeaderEstimate {
  /** The estimate as the header shows it, `4.12 s` or `≤ 1.00 s`. */
  text: string;
  /** What it is, and what it leaves out, such as the strafe fraction: its long-hover hint. */
  hint: string;
  testId?: string;
}

export function SelectionHeader({
  icon: Icon,
  iconLabel,
  title,
  crumb,
  estimate,
  marks,
  action,
  help,
  testId = "inspector-head",
}: {
  icon: LucideIcon;
  /** The kind in a word: the icon's accessible name and its tooltip. */
  iconLabel: string;
  title: string;
  /** The parent before the title, as a marker's path: a button that selects it. */
  crumb?: { label: string; hint: string; onClick: () => void; testId?: string };
  estimate?: HeaderEstimate;
  /** Facts shown as quiet icons before the estimate, each a `HeaderMark`. */
  marks?: ReactNode;
  /** The header's one action, such as a marker's bin or a waypoint's ⋯. */
  action?: ReactNode;
  /** What the `?` explains: the selected kind's help, or the Inspector's own in the Routine view. */
  help: PanelHelpId;
  testId?: string;
}) {
  const hintId = useId();
  return (
    <header className={styles.selHead} data-testid={testId}>
      <Tooltip label={iconLabel}>
        <span className={styles.selKind} role="img" aria-label={iconLabel} data-testid="inspector-kind-icon">
          <Icon size={16} strokeWidth={1.75} aria-hidden />
        </span>
      </Tooltip>
      {crumb === undefined ? null : (
        <>
          <Tooltip label={`Select ${crumb.label}`} hint={crumb.hint}>
            <button type="button" className={styles.crumb} data-testid={crumb.testId} onClick={crumb.onClick}>
              {crumb.label}
            </button>
          </Tooltip>
          <ChevronRight size={12} strokeWidth={1.75} aria-hidden className={styles.crumbSep} />
        </>
      )}
      <h2 className={styles.selTitle} title={title} data-testid="inspector-title">
        {title}
      </h2>
      <span className={styles.selGrow} />
      {marks}
      {estimate === undefined ? null : (
        // The estimate's hint is its description too, as a row's is (issue #237), so a screen reader hears it.
        <HintedControls hint={estimate.hint} hintId={hintId}>
          <Tooltip label={estimate.text} hint={estimate.hint} delay="long" side="left">
            <span className={styles.selEstimate} data-testid={estimate.testId} tabIndex={0}>
              {estimate.text}
            </span>
          </Tooltip>
        </HintedControls>
      )}
      {action === undefined ? null : <span className={styles.selAction}>{action}</span>}
      <span className={styles.selHelp}>
        <HelpTip id={help} side="left" />
      </span>
    </header>
  );
}

/**
 * A fact about the selection drawn as a quiet icon in the header, such as Stands still (an anchor)
 * or Planner only: its words are its tooltip and, for a screen reader, its text. In With
 * descriptions they are drawn beside the icon (issue #431). It is state, so it shows in both modes.
 */
export function HeaderMark({
  icon: Icon,
  words,
  hint,
  testId,
}: {
  icon: LucideIcon;
  words: string;
  hint?: string;
  testId?: string;
}) {
  const full = useDescriptions() === "full";
  return (
    <Tooltip label={words} hint={hint}>
      <span className={styles.selMark} tabIndex={0} data-testid={testId}>
        <Icon size={12} strokeWidth={1.75} aria-hidden />
        <span className={full ? styles.selMarkWords : "visually-hidden"}>{words}</span>
      </span>
    </Tooltip>
  );
}
