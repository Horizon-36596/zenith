/**
 * The Alliance group of the problems panel (spec 13 section 9): the
 * predicted findings from `checkAlliance`, under their own header that says they are predictions,
 * in the same row language as every other finding (UI_GUIDE section 9.7). They are never counted
 * in the panel's severity counts and never reach anything that saves, deploys or proposes.
 *
 * Clicking a row moves the scrubber to the finding's time on the alliance clock and selects the
 * user's step it names. An ALLIANCE_COLLISION, ALLIANCE_NEAR_MISS or ALLIANCE_ENVELOPE row, once
 * selected, shows the two one-click fixes of spec 13 section 9, each sized to clear every finding of
 * its own code without leaving a collision.
 *
 * ALLIANCE_START_OVERLAP and ALLIANCE_ELEMENT_CONFLICT rows have no one-click fix, only their help
 * in the code chip's tooltip. A robot waiting out an offset or a wait holds its start pose, so no delay separates two
 * starts on one tile; one start pose has to move, and which is for the two teams to agree. And both
 * ledgers claim an element whenever each robot gets there, so no delay removes an element
 * conflict; who takes it is a strategy decision.
 */
import { useMemo, useState } from "react";
import { Info, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import { isClearableAllianceCode, type Finding, type Plan, type Severity } from "@horizon36596/zenith-core";
import { Tooltip } from "../components/Tooltip";
import { HelpTip } from "../help/HelpTip";
import { findingHelp } from "../help/content";
import { isReadOnly, useEditor } from "../state/store";
import findingStyles from "../panels/FindingsPanel.module.css";
import { FindingCodeChip, FindingMessage } from "../panels/findingParts";
import { addClearingWait, clearsWhat, delayMyStart, goToAllianceFinding } from "./actions";
import { findingTimeLabel, type AlignedPartner, type AllianceFinding, type AllianceResult } from "./model";
import type { AllianceView } from "./useAlliance";
import styles from "./alliance.module.css";

const SEVERITY_ICON: Record<Severity, LucideIcon> = {
  error: OctagonAlert,
  warning: TriangleAlert,
  info: Info,
};

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Worst first, then by time, so the first row is the first thing to fix. */
export function sortAllianceFindings(findings: readonly AllianceFinding[]): AllianceFinding[] {
  return [...findings].sort(
    (a, b) =>
      RANK[a.finding.severity] - RANK[b.finding.severity] || (a.finding.timeS ?? 0) - (b.finding.timeS ?? 0),
  );
}

export function AllianceFindings({ plan, view }: { plan: Plan; view: AllianceView }) {
  const editor = useEditor();
  const result = view.result;
  const rows = useMemo(() => sortAllianceFindings(result?.findings ?? []), [result]);
  // The row last opened, and the step selected when it was. A row whose finding names no step of
  // the user's (its id starts with "(") has no step to select, so it counts as selected while it is
  // the row last opened and the selection has not moved since.
  const [opened, setOpened] = useState<{ key: string; stepId: string | undefined } | null>(null);
  if (!view.active) return null;

  const partners = result?.partners ?? [];
  return (
    <section className={styles.group} aria-label="Alliance findings, predicted" data-testid="alliance-findings">
      <div className={styles.groupHead}>
        <h3 className={styles.groupTitle}>Alliance</h3>
        <HelpTip id="alliance" />
        <span className={styles.groupNote}>
          predicted from two instant-sim runs · never blocks a save, deploy or propose
        </span>
      </div>
      <div role="list">
        {result === null ? (
          <p className={findingStyles.empty}>Your robot could not be predicted, so it cannot be compared.</p>
        ) : rows.length === 0 ? (
          <p className={findingStyles.empty} data-testid="alliance-findings-empty">
            {partners.length === 0 ? "Every partner is hidden." : "No predicted conflicts with your partners."}
          </p>
        ) : (
          rows.map((row, index) => {
            const key = `${row.partnerId}-${row.finding.code}-${String(index)}`;
            const stepId = editor.selection.stepId;
            const noStep = row.finding.stepId.startsWith("(");
            const selected = noStep
              ? opened !== null && opened.key === key && opened.stepId === stepId
              : stepId !== undefined && stepId === row.finding.stepId;
            return (
              <AllianceFindingRow
                key={key}
                row={row}
                plan={plan}
                partners={partners}
                clearingOffsetS={clearingOffsetFor(result, row.finding)}
                readOnly={isReadOnly(editor)}
                selected={selected}
                onOpen={() => {
                  goToAllianceFinding(row.finding);
                  setOpened({ key, stepId: noStep ? stepId : row.finding.stepId });
                }}
              />
            );
          })
        )}
      </div>
    </section>
  );
}

/**
 * The "delay my start" offset for a finding's code: the smallest that clears every finding of that
 * code, or null when none up to 10 s does or the code has no such fix.
 */
function clearingOffsetFor(result: AllianceResult, finding: Finding): number | null {
  const code = finding.code;
  if (!isClearableAllianceCode(code)) return null;
  return result.clearingOffsets[code]?.offsetS ?? null;
}

/** How a fix's tooltip names what the finding is, for the no-step sentence. */
const WHAT_BEGINS: Record<string, string> = {
  ALLIANCE_COLLISION: "this collision begins",
  ALLIANCE_NEAR_MISS: "this close pass is closest",
  ALLIANCE_ENVELOPE: "it enters the envelope",
};

function AllianceFindingRow({
  row,
  plan,
  partners,
  clearingOffsetS,
  readOnly,
  selected,
  onOpen,
}: {
  row: AllianceFinding;
  plan: Plan;
  partners: readonly AlignedPartner[];
  clearingOffsetS: number | null;
  readOnly: boolean;
  selected: boolean;
  /** Moves playback to the finding and selects its step (`goToAllianceFinding`). */
  onOpen: () => void;
}) {
  const finding: Finding = row.finding;
  const Icon = SEVERITY_ICON[finding.severity];
  const help = findingHelp(finding.code);
  const fixable = isClearableAllianceCode(finding.code);
  const clears = clearsWhat(finding);
  const noStep = finding.stepId.startsWith("(");
  const waitWhy = readOnly
    ? "Review mode is read only."
    : noStep
      ? `Your robot is not running a step when ${WHAT_BEGINS[finding.code] ?? "this happens"}, so there is no step to wait before. Delay your start instead.`
      : null;
  return (
    <div
      role="listitem"
      className={`${findingStyles.row} ${findingStyles.problem}`}
      data-severity={finding.severity}
      data-selected={selected ? "true" : undefined}
      data-testid="alliance-finding-row"
      data-code={finding.code}
      onClick={onOpen}
    >
      <Icon className={findingStyles.icon} size={16} strokeWidth={1.75} aria-label={finding.severity} />
      {/* The same message and code chip as a Problems row (UI_GUIDE section 9.7): one line until
          selected, and the how-to in the chip's tooltip. */}
      <FindingMessage
        message={finding.message}
        title={help?.title ?? finding.code}
        ariaLabel={`${finding.message} Move playback to ${findingTimeLabel(finding)}.`}
        testId="alliance-finding-select"
        onOpen={onOpen}
      />
      <FindingCodeChip code={finding.code} help={help} testId="alliance-finding-code" onOpen={onOpen} />
      <Tooltip label="When, on the alliance clock" hint="Seconds from the start of the period, with every start offset counted. Click the row to move playback there.">
        <span className={`${styles.time} ${styles.rowTime}`} tabIndex={0}>
          {findingTimeLabel(finding)}
        </span>
      </Tooltip>
      {/* Only the selected row has its fixes, on a line of their own, so no row grows under the pointer. */}
      {selected && fixable ? (
        <span className={findingStyles.fixes} data-testid="alliance-finding-fixes">
          <Tooltip
            label="Delay my start"
            hint={
              clearingOffsetS === null
                ? `No start offset up to 10 s clears ${clears} without a collision. Add a wait step or route around your partner.`
                : `Sets your start offset to ${clearingOffsetS.toFixed(1)} s, the smallest in 0.1 s steps that clears ${clears} without a collision. It changes nothing in the auto.`
            }
          >
            <button
              type="button"
              className={`${findingStyles.fix} ${styles.fixAction}`}
              aria-disabled={clearingOffsetS === null ? true : undefined}
              data-testid="alliance-fix-delay"
              onClick={(event) => {
                event.stopPropagation();
                if (clearingOffsetS !== null) delayMyStart(plan, clearingOffsetS);
              }}
            >
              {clearingOffsetS === null ? "Delay my start" : `Delay my start ${clearingOffsetS.toFixed(1)} s`}
            </button>
          </Tooltip>
          <Tooltip
            label="Add a wait step"
            hint={
              waitWhy ??
              `Inserts the smallest wait before ${finding.stepId}, in 0.1 s steps up to 10 s, that clears ${clears}. Undo removes it.`
            }
          >
            <button
              type="button"
              className={`${findingStyles.fix} ${styles.fixAction}`}
              aria-disabled={waitWhy === null ? undefined : true}
              data-testid="alliance-fix-wait"
              onClick={(event) => {
                event.stopPropagation();
                if (waitWhy === null) addClearingWait(plan, partners, finding);
              }}
            >
              Add a wait step
            </button>
          </Tooltip>
        </span>
      ) : null}
    </div>
  );
}
