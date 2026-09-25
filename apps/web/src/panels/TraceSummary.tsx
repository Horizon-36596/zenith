/**
 * What a loaded trace says about the whole run: the report of
 * site/docs/simulation.md, shown in the Simulate dialog beside the command
 * that produced it. Every number comes from the full sim level, and the first row says so.
 *
 * Every number here is the trace's own. Where the sim build does not measure something, the row
 * says so rather than printing a zero that would read as "none happened".
 */
import { traceSummary } from "@horizon36596/zenith-core";
import { seconds as fmtSeconds } from "../lib/format";
import { useDerived, useEditor } from "../state/store";
import styles from "./TraceSummary.module.css";

const INERT_LABEL: Record<string, string> = {
  structureContacts: "structure contacts",
  ledger: "the ledger",
};

export function TraceSummary() {
  const { trace } = useEditor();
  const derived = useDerived();
  if (trace === null) return null;

  const summary = traceSummary(trace);
  const estimatedS = derived.totalS;
  const deltaS = estimatedS === null ? null : summary.totalS - estimatedS;
  const tips = Object.entries(summary.tips);
  const measuresContacts = !summary.inert.includes("structureContacts");

  return (
    <dl className={styles.summary} data-testid="trace-summary" data-level="full">
      <div className={styles.row}>
        <dt>Level</dt>
        <dd>Full sim, the robot repository&apos;s own simulation</dd>
      </div>
      <div className={styles.row}>
        <dt>Total</dt>
        <dd>
          {fmtSeconds(summary.totalS)}
          <span className="unit">s</span>
          {estimatedS === null || deltaS === null ? null : (
            <span className={styles.delta}>
              {deltaS >= 0 ? "+" : ""}
              {fmtSeconds(deltaS)}
              <span className="unit">s vs estimate</span>
            </span>
          )}
        </dd>
      </div>
      <div className={styles.row}>
        <dt>Structure contacts</dt>
        <dd data-warn={measuresContacts && summary.structureContacts > 0 ? "true" : undefined}>
          {measuresContacts ? String(summary.structureContacts) : "not measured in this sim build"}
        </dd>
      </div>
      <div className={styles.row}>
        <dt>Launches</dt>
        <dd>{String(summary.launches)}</dd>
      </div>
      <div className={styles.row}>
        <dt>Tips</dt>
        <dd>
          {tips.length === 0
            ? "—"
            : tips.map(([alliance, count]) => `${alliance} ${String(count)}`).join(", ")}
        </dd>
      </div>
      <div className={styles.row}>
        <dt>Held at the end</dt>
        <dd>{summary.heldAtEnd === null ? "—" : String(summary.heldAtEnd)}</dd>
      </div>
      {summary.inert.length === 0 ? null : (
        <p className={styles.inert}>
          This sim build does not measure{" "}
          {summary.inert.map((name) => INERT_LABEL[name] ?? name).join(" or ")}, so those rows are
          inert rather than zero.
        </p>
      )}
    </dl>
  );
}
