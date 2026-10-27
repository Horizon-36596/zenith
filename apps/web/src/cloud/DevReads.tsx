/**
 * The development build's readout of cloud reads by screen (spec 13 section 7.2): a small section in
 * the Account and Sign-in sheets, beside the fake cloud's test users. It is loaded only through
 * `DevReadsSlot`, behind `import.meta.env.DEV`, so a production bundle has none of it.
 */
import { useSyncExternalStore } from "react";
import { SheetButton } from "./controls";
import { pageReads } from "./devReadsBackend";
import styles from "../account/account.module.css";

const subscribe = (listener: () => void) => pageReads.subscribe(listener);
const read = () => pageReads.snapshot();

export default function DevReads() {
  const reads = useSyncExternalStore(subscribe, read, read);
  return (
    <section className={styles.section} data-testid="dev-reads">
      <h3 className={styles.sectionHead}>Cloud reads (development build only)</h3>
      <p className={styles.hint} data-testid="dev-reads-total">
        {`${String(reads.total)} ${reads.total === 1 ? "read" : "reads"} in all`}
      </p>
      {reads.byScreen.length === 0 ? null : (
        <ul className={styles.hint} data-testid="dev-reads-list">
          {reads.byScreen.map((entry) => (
            <li key={entry.screen} data-testid="dev-reads-row" data-screen={entry.screen}>
              {`${entry.screen}: ${String(entry.reads)} (${String(entry.gets)} from gets, ${String(entry.lists)} from lists)`}
            </li>
          ))}
        </ul>
      )}
      <div className={styles.row}>
        <SheetButton
          kind="text"
          tooltip="Start counting again"
          hint="Sets every count back to nothing, to measure one screen on its own."
          whyDisabled={reads.total === 0 ? "Nothing has been read yet." : null}
          onClick={() => {
            pageReads.reset();
          }}
          testId="dev-reads-reset"
        >
          Reset
        </SheetButton>
      </div>
    </section>
  );
}
