/**
 * The panel under the field: Problems, and beside it the Code tab (issue #102). The tabs take the
 * place of the Problems title, so the panel keeps one header row whichever tab is open.
 *
 * `showCode` is the one switch for the Code tab, the person's `features.codeTab`: false gives the
 * Problems panel exactly as it was, with its title and no tabs, whatever tab is stored.
 *
 * `collapsed` keeps the header and drops the body (issue #413): the tabs and the severity counts stay
 * in view, so a collapsed panel still says something is wrong, and a click on a tab or a count opens
 * it again. Choosing a tab sets the panel's height too (`openBottomTab`).
 */
import type { KeyboardEvent } from "react";
import { currentDerived } from "../state/store";
import { CodePanel } from "./CodePanel";
import { FindingsPanel } from "./FindingsPanel";
import { problemsListed } from "./findingRows";
import { openBottomTab, shownBottomTab, useBottomTab, type BottomTab } from "./bottomTab";
import styles from "./BottomPanel.module.css";

const TABS: readonly { id: BottomTab; label: string }[] = [
  { id: "problems", label: "Problems" },
  { id: "code", label: "Code" },
];

/** Whether the list shows an error or a warning now, which makes Problems open four rows tall. */
const hasProblems = (): boolean => problemsListed(currentDerived().findings).some((finding) => finding.severity !== "info");

export function BottomPanel({ showCode, collapsed = false }: { showCode: boolean; collapsed?: boolean }) {
  const tab = shownBottomTab(useBottomTab(), showCode);
  if (!showCode) return <FindingsPanel collapsed={collapsed} />;
  const tabs = <BottomTabs current={tab} />;
  return tab === "code" ? <CodePanel tabs={tabs} collapsed={collapsed} /> : <FindingsPanel tabs={tabs} collapsed={collapsed} />;
}

function BottomTabs({ current }: { current: BottomTab }) {
  // Left and Right move between the tabs, as in any tab list; the selected tab is the one in the
  // tab order.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const at = TABS.findIndex((entry) => entry.id === current);
    const next = TABS[(at + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    if (next === undefined) return;
    // The other tab's panel replaces this one, so focus finds the new tab after it renders.
    const page = event.currentTarget.ownerDocument;
    openBottomTab(next.id, hasProblems());
    requestAnimationFrame(() => {
      page.querySelector<HTMLElement>(`[data-testid="bottom-tab-${next.id}"]`)?.focus();
    });
  };
  return (
    <div className={styles.tabs} role="tablist" aria-label="Problems and code" onKeyDown={onKeyDown}>
      {TABS.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="tab"
          className={styles.tab}
          aria-selected={entry.id === current}
          tabIndex={entry.id === current ? 0 : -1}
          data-testid={`bottom-tab-${entry.id}`}
          onClick={() => {
            openBottomTab(entry.id, hasProblems());
          }}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
