/**
 * The Settings search box and its results (issue #430). The box sits under the title above the list
 * of sections; while it holds words, the chosen section's pane gives way to the rows every section
 * has that match, each under its section's name with the matching words marked. Choosing a row opens
 * its section at that row with its control focused, the way the palette's "Off in your settings"
 * jump does. The words are matched in `search.ts`.
 */
import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from "react";
import { Search, X } from "lucide-react";
import { RowButton } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { highlightParts, resultCount, type SearchGroup, type SearchRow } from "./search";
import { sectionInfo } from "./sections";
import styles from "./Settings.module.css";

/** The find key's name in tooltips, as the keys elsewhere are written. */
export const FIND_KEY = "Ctrl F";

/** Text with the words of the query marked. */
function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, index) =>
        part.match ? (
          <mark key={index} className={styles.mark}>
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

export function SearchBox({
  query,
  onQuery,
  inputRef,
  onFirst,
  onDown,
}: {
  query: string;
  onQuery: (query: string) => void;
  inputRef: MutableRefObject<HTMLInputElement | null>;
  /** Enter: open the first match. */
  onFirst: () => void;
  /** Down arrow: move to the first match. */
  onDown: () => void;
}) {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape" && query !== "") {
      // The first Esc empties the box; the window closes only on the next one.
      event.preventDefault();
      event.stopPropagation();
      onQuery("");
    } else if (event.key === "Enter") {
      event.preventDefault();
      onFirst();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onDown();
    }
  };
  return (
    <div className={styles.search} role="search">
      <Search size={16} strokeWidth={1.75} aria-hidden className={styles.searchIcon} />
      <Tooltip
        label="Search settings"
        shortcut={FIND_KEY}
        hint="Finds a setting in every section by its name, its description or a choice it offers. Enter opens the first match; Esc clears the box."
      >
        <input
          ref={inputRef}
          type="text"
          role="searchbox"
          className={styles.searchInput}
          value={query}
          placeholder="Search settings"
          aria-label="Search settings"
          autoComplete="off"
          spellCheck={false}
          data-testid="settings-search"
          onChange={(event) => {
            onQuery(event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
      </Tooltip>
      {query === "" ? null : (
        <span className={styles.searchClear}>
          <RowButton
            icon={X}
            label="Clear search"
            shortcut="Esc"
            hint="Empty the search box and show the sections again."
            testId="settings-search-clear"
            onClick={() => {
              onQuery("");
              inputRef.current?.focus({ preventScroll: true });
            }}
          />
        </span>
      )}
    </div>
  );
}

/** The matches, by section; or the one line that says there are none. */
export function SearchResults({
  groups,
  query,
  onChoose,
  onUp,
}: {
  groups: readonly SearchGroup[];
  query: string;
  onChoose: (row: SearchRow) => void;
  /** Up arrow on the first match: back to the box. */
  onUp: () => void;
}) {
  const count = resultCount(groups);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-result]")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    event.preventDefault();
    if (event.key === "ArrowUp" && at === 0) onUp();
    else buttons[Math.min(buttons.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };
  return (
    <div className={styles.results} data-testid="settings-results" onKeyDown={onKeyDown}>
      <p className="visually-hidden" role="status" aria-live="polite" data-testid="settings-results-status">
        {count === 0 ? "No settings match." : `${String(count)} ${count === 1 ? "setting matches" : "settings match"}.`}
      </p>
      {count === 0 ? (
        <div className={styles.noResults} data-testid="settings-no-results">
          <p className={styles.noResultsTitle}>
            No settings match <span className={styles.noResultsQuery}>{query.trim()}</span>
          </p>
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.section} className={styles.resultGroup} data-testid={`settings-results-${group.section}`}>
            <h4 className={styles.resultHead}>
              <span>{sectionInfo(group.section).label}</span>
              <span className={styles.resultCount}>{group.rows.length}</span>
            </h4>
            <ul className={styles.resultList}>
              {group.rows.map((row) => (
                <li key={row.key}>
                  <button
                    type="button"
                    className={styles.result}
                    data-result={row.key}
                    data-testid={`settings-result-${row.key}`}
                    onClick={() => {
                      onChoose(row);
                    }}
                  >
                    <span className={styles.resultText}>
                      <span className={styles.rowLabel}>
                        <Marked text={row.label} query={query} />
                      </span>
                      {row.description === "" ? null : (
                        <span className={styles.rowDescription}>
                          <Marked text={row.description} query={query} />
                        </span>
                      )}
                    </span>
                    <span className={styles.resultGroupName}>{row.group}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
