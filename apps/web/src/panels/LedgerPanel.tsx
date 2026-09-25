/**
 * The ledger table of UI_GUIDE section 8.6: sticky 24 px header, 28 px rows, numeric columns in
 * mono and right aligned, no zebra striping and no vertical rules, an over-capacity cell tinted
 * with the error background.
 */
import { useMemo } from "react";
import { TableProperties } from "lucide-react";
import { EmptyState, Unavailable } from "../components/primitives";
import { selectStep, useDerived, useEditor } from "../state/store";
import styles from "./LedgerPanel.module.css";

export function LedgerPanel() {
  const { auto, project, selection } = useEditor();
  const derived = useDerived();

  const kinds = useMemo(() => {
    const names = new Set<string>();
    for (const row of derived.ledger) for (const key of Object.keys(row.holds ?? {})) names.add(key);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [derived.ledger]);

  const capacity = project?.robot.capacity;

  if (auto === null) return null;
  if (derived.ledgerReason !== null) return <Unavailable>{derived.ledgerReason}</Unavailable>;
  if (derived.seasonWarnings.length > 0) {
    return <Unavailable>{derived.seasonWarnings.join(" ")}</Unavailable>;
  }
  if (derived.ledger.length === 0) {
    return (
      <EmptyState
        icon={TableProperties}
        line="The ledger is empty until a step collects or launches."
        testId="ledger-empty"
      />
    );
  }

  return (
    <table className={styles.table} data-testid="ledger">
      <thead>
        <tr>
          <th scope="col" className={styles.textHead}>
            Step
          </th>
          <th scope="col" className={styles.textHead}>
            What happened
          </th>
          {kinds.map((kind) => (
            <th key={kind} scope="col" className={styles.numHead}>
              {kind}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {derived.ledger.map((row, index) => (
          <tr
            key={`${row.stepId}-${String(index)}`}
            className={selection.stepId === row.stepId ? styles.selected : undefined}
            onClick={() => {
              selectStep(row.stepId);
            }}
          >
            <td className={styles.id}>{row.stepId}</td>
            <td className={styles.label} title={row.detail}>
              {row.label}
            </td>
            {kinds.map((kind) => {
              const value = row.holds?.[kind];
              const over =
                capacity !== undefined &&
                capacity.elementKind === kind &&
                value !== undefined &&
                value > capacity.max;
              return (
                <td key={kind} className={styles.num} data-over={over ? "true" : undefined}>
                  {value ?? "—"}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
