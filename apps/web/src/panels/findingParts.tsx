/**
 * The pieces of a finding row (UI_GUIDE section 9.7) that the Problems list and the Alliance group
 * share, so the two lists read the same (0.1.2 UX sweep K3): the message, cut to one line until the
 * row is selected with all of it in a long-hover tooltip, and the code chip, whose tooltip says what
 * the code means and how to fix it (`codeChipTip`). Each row keeps its own icon, fixes and last
 * column, and lays them out with `FindingsPanel.module.css`'s `row` and `problem` classes.
 */
import { Tooltip } from "../components/Tooltip";
import { codeChipTip, type CodeHelp } from "./findingRows";
import styles from "./FindingsPanel.module.css";

/** The row's message, as the button that opens the finding. */
export function FindingMessage({
  message,
  title,
  ariaLabel,
  pressed,
  testId,
  onOpen,
}: {
  message: string;
  /** The tooltip's label: the code's help title, or the severity when the code has none. */
  title: string;
  ariaLabel: string;
  /** Set on a row whose selection is a toggle the panel reports, as the Problems list's is. */
  pressed?: boolean;
  testId: string;
  onOpen: () => void;
}) {
  return (
    <Tooltip label={title} hint={message} delay="long">
      <button
        type="button"
        className={styles.message}
        aria-pressed={pressed}
        aria-label={ariaLabel}
        data-testid={testId}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
      >
        <span className={styles.messageText} data-testid="finding-message">
          {message}
        </span>
      </button>
    </Tooltip>
  );
}

/** The muted code chip. It is focusable for its tooltip, and Enter or Space on it opens the finding too. */
export function FindingCodeChip({
  code,
  help,
  testId,
  onOpen,
}: {
  code: string;
  help: CodeHelp | null;
  testId: string;
  onOpen: () => void;
}) {
  const tip = codeChipTip(code, help);
  return (
    <Tooltip label={tip.label} hint={tip.hint}>
      <span
        className={styles.code}
        tabIndex={0}
        data-testid={testId}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          onOpen();
        }}
      >
        {code}
      </span>
    </Tooltip>
  );
}
