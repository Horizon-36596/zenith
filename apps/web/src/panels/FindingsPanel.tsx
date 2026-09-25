/**
 * The problems panel of UI_GUIDE section 9.7: a header with the region title, its `?`, and the
 * severity counts as filter toggles, then one row per finding: the severity icon, the message, the
 * code as a muted chip whose tooltip says what it means and how to fix it (core's `FINDING_HELP`),
 * the step, and any fixes as ghost buttons on hover and focus. Rows are not tinted. Clicking a row
 * selects the step the finding points at; the selected step's rows also show the "how to fix" line.
 *
 * `derived.findingsReason` (`check()` threw, so `findings` fell back to the plan's own) and each
 * `derived.seasonWarnings` line (an unknown or missing season plugin, so every season-dependent
 * check is silently absent) render as a banner row above the list, so "No problems found" never
 * reads as a clean bill of health when it is really a gap in what got checked (finding 25).
 */
import { useMemo } from "react";
import { Info, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import { applyFix } from "@horizon36596/zenith-core";
import type { Finding, Severity } from "@horizon36596/zenith-core";
import { Tooltip } from "../components/Tooltip";
import { HelpTip } from "../help/HelpTip";
import { findingHelp } from "../help/content";
import { severityCounts, sortFindings } from "../state/derived";
import { tryEdit } from "../app/edits";
import { selectStep, setSeverityFilter, useDerived, useEditor } from "../state/store";
import styles from "./FindingsPanel.module.css";

const fixesOf = (finding: Finding): NonNullable<Finding["fixes"]> => finding.fixes ?? [];

const SEVERITY_ICON: Record<Severity, LucideIcon> = {
  error: OctagonAlert,
  warning: TriangleAlert,
  info: Info,
};

const SEVERITY_WORD: Record<Severity, [string, string]> = {
  error: ["error", "errors"],
  warning: ["warning", "warnings"],
  info: ["info", "info"],
};

export function FindingsPanel() {
  const { auto, severityFilter, validatedAt, selection } = useEditor();
  const derived = useDerived();

  const counts = useMemo(() => severityCounts(derived.findings), [derived.findings]);
  const shown = useMemo(() => {
    const sorted = sortFindings(derived.findings);
    return severityFilter === null
      ? sorted
      : sorted.filter((finding) => finding.severity === severityFilter);
  }, [derived.findings, severityFilter]);

  if (auto === null) return null;

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <h2 className={styles.title}>Problems</h2>
        <HelpTip id="findings" />
        <div className={styles.counts} role="toolbar" aria-label="Filter the problems by severity">
          {(["error", "warning", "info"] as const).map((severity, index) => (
            <span key={severity} className={styles.countWrap}>
              {index === 0 ? null : <span className={styles.sep} aria-hidden>·</span>}
              <Tooltip
                label={severityFilter === severity ? "Show every problem" : `Show only ${SEVERITY_WORD[severity][1]}`}
              >
                <button
                  type="button"
                  className={styles.count}
                  data-severity={severity}
                  aria-pressed={severityFilter === severity}
                  data-testid={`findings-count-${severity}`}
                  onClick={() => {
                    setSeverityFilter(severityFilter === severity ? null : severity);
                  }}
                >
                  {counts[severity]} {SEVERITY_WORD[severity][counts[severity] === 1 ? 0 : 1]}
                </button>
              </Tooltip>
            </span>
          ))}
        </div>
      </div>

      {derived.findingsReason === null && derived.seasonWarnings.length === 0 ? null : (
        <div className={styles.banners} data-testid="findings-banners">
          {derived.findingsReason === null ? null : (
            <div className={styles.banner} data-kind="error" data-testid="findings-banner-reason">
              <OctagonAlert size={16} strokeWidth={1.75} aria-hidden />
              <span>{derived.findingsReason}</span>
            </div>
          )}
          {derived.seasonWarnings.map((warning) => (
            <div
              key={warning}
              className={styles.banner}
              data-kind="warning"
              data-testid="findings-banner-season"
            >
              <TriangleAlert size={16} strokeWidth={1.75} aria-hidden />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      )}

      <div className={styles.rows} role="list" data-testid="findings-list">
        {shown.length === 0 ? (
          <p className={styles.empty} data-testid="findings-empty">
            {derived.findings.length === 0 ? "No problems found." : "No problems at that severity."}
            {validatedAt === null ? null : (
              <span className={styles.when}> Checked {ago(validatedAt)}.</span>
            )}
          </p>
        ) : (
          shown.map((finding, index) => (
            <FindingRow
              key={`${finding.code}-${finding.stepId}-${String(index)}`}
              finding={finding}
              selected={selection.stepId !== undefined && selection.stepId === finding.stepId}
            />
          ))
        )}
      </div>
    </div>
  );
}

function FindingRow({ finding, selected }: { finding: Finding; selected: boolean }) {
  const Icon = SEVERITY_ICON[finding.severity];
  const help = findingHelp(finding.code);
  return (
    <div
      role="listitem"
      className={styles.row}
      data-severity={finding.severity}
      data-selected={selected ? "true" : undefined}
      data-testid="finding-row"
      onClick={() => {
        selectStep(finding.stepId);
      }}
    >
      <Icon className={styles.icon} size={16} strokeWidth={1.75} aria-label={finding.severity} />
      {/* The message is the row's button, so a keyboard user can jump to the problem's step (QA-11). */}
      <button
        type="button"
        className={styles.message}
        aria-pressed={selected}
        aria-label={finding.stepId === undefined ? finding.message : `${finding.message} Select ${finding.stepId}.`}
        data-testid="finding-select"
        onClick={(event) => {
          event.stopPropagation();
          selectStep(finding.stepId);
        }}
      >
        <span>{finding.message}</span>
        {selected && help !== null ? (
          <span className={styles.howTo} data-testid="finding-how-to">
            How to fix: {help.fix}
          </span>
        ) : null}
      </button>
      <Tooltip
        label={help?.title ?? finding.code}
        hint={help === null ? undefined : `${help.means} How to fix: ${help.fix}`}
      >
        <span
          className={styles.code}
          tabIndex={0}
          data-testid="finding-code"
          onKeyDown={(event) => {
            // The code chip is focusable for its tooltip; Enter or Space on it selects the step too.
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            selectStep(finding.stepId);
          }}
        >
          {finding.code}
        </span>
      </Tooltip>
      <span className={styles.step}>{finding.stepId}</span>
      <span className={styles.fixes}>
        {fixesOf(finding).map((fix, at) => (
          <button
            key={`${fix.kind}-${String(at)}`}
            type="button"
            className={styles.fix}
            data-testid={`fix-${fix.kind}`}
            onClick={(event) => {
              event.stopPropagation();
              tryEdit((current) => applyFix(current, fix));
            }}
          >
            {fix.label}
          </button>
        ))}
      </span>
    </div>
  );
}

function ago(at: number): string {
  const secondsAgo = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secondsAgo < 60) return `${String(secondsAgo)} s ago`;
  return `${String(Math.round(secondsAgo / 60))} min ago`;
}

export const severityOrder: Severity[] = ["error", "warning", "info"];
