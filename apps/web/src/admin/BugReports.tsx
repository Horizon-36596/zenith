/**
 * The admin page's Bug reports view: every report people sent from Report a bug, newest first, with
 * a filter by status. Opening one shows what the reporter wrote, the setup block the app sent with
 * it and, if they chose to include a snapshot of it, their auto file as collapsed text (never
 * drawn), the owner's one exception to "Horizon admins never see a team's paths" (2026-09-30). A
 * Horizon admin marks a report triaged or closed, or opens it again; each change writes an entry
 * to the admin access log in the same write, and listing the reports writes one before the read
 * (spec 13 section 13).
 *
 * Reports are private: only Horizon admins read them, and nothing here links anywhere or replies.
 */
import { useEffect, useRef, useState } from "react";
import { CircleCheck, CircleDashed, Inbox, type LucideIcon } from "lucide-react";
import type { BugReport, BugReportStatus, CloudBackend } from "@horizon36596/zenith-cloud";
import { whenWords } from "../account/words";
import { useCopy } from "../app/copyText";
import { Tooltip } from "../components/Tooltip";
import { setupRows } from "../report/setup";
import { filterReports, REPORT_STATUS_WORDS, reportCountWords, reportTitle, type ReportFilter } from "./bugReportsModel";
import { ActionButton } from "./controls";
import { Segmented } from "../components/Segmented";
import { logAdminAccess } from "./store";
import styles from "./admin.module.css";
import { cloudErrorSentence } from "../cloud/errorSentence";

const STATUS_ICONS: Record<BugReportStatus, LucideIcon> = { new: Inbox, triaged: CircleDashed, closed: CircleCheck };

const FILTER_OPTIONS: ReadonlyArray<{ value: ReportFilter; label: string; does: string }> = [
  { value: "all", label: "All", does: "Shows every report." },
  { value: "new", label: "New", does: "Shows the reports nobody has marked yet." },
  { value: "triaged", label: "Triaged", does: "Shows the reports an admin has read and knows what to do with." },
  { value: "closed", label: "Closed", does: "Shows the reports nothing more will be done about." },
];

function message(error: unknown): string {
  return cloudErrorSentence(error);
}

function ReportStatusBadge({ status, testId }: { status: BugReportStatus; testId?: string }) {
  const Icon = STATUS_ICONS[status];
  const words = REPORT_STATUS_WORDS[status];
  return (
    <Tooltip label={words.label} hint={words.meaning}>
      <span className={styles.badge} data-report-status={status} tabIndex={0} data-testid={testId}>
        <Icon size={12} strokeWidth={1.75} aria-hidden />
        {words.label}
      </span>
    </Tooltip>
  );
}

export function BugReports({ backend, generation }: { backend: CloudBackend; generation: number }) {
  const [reports, setReports] = useState<BugReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReportFilter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      setError(null);
      try {
        await logAdminAccess(backend, "reports.list");
        const next = await backend.listBugReports();
        if (live) setReports(next);
      } catch (err) {
        if (live) setError(message(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [backend, generation, reload]);

  const shown = reports === null ? [] : filterReports(reports, filter);
  const opened = reports?.find((report) => report.id === openId) ?? null;

  const mark = async (report: BugReport, status: BugReportStatus) => {
    setBusy(true);
    setError(null);
    try {
      await (await backend.setBugReportStatus(report.id, status)).sent;
      setReload((n) => n + 1);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className={styles.queue}>
        <div className={styles.section}>
          <h3 className={styles.sectionHead}>Reports people sent</h3>
          <p className={styles.prose}>Nobody can reply through Zenith.</p>
          <div className={styles.filters}>
            <Segmented label="Status" options={FILTER_OPTIONS} value={filter} onChange={setFilter} testId="admin-reports-status" />
          </div>
          {reports === null ? (
            error === null ? <p className={styles.prose}>Loading the reports…</p> : null
          ) : (
            <>
              <p className={styles.hint} data-testid="admin-reports-count">{reportCountWords(shown.length, reports.length)}</p>
              {shown.length === 0 ? (
                <p className={styles.prose} data-testid="admin-reports-empty">
                  {reports.length === 0 ? "Nobody has sent a report yet." : "No report has this status."}
                </p>
              ) : (
                <ul className={styles.list} data-testid="admin-reports">
                  {shown.map((report) => (
                    <li key={report.id}>
                      <Tooltip label="Open this report" hint="Shows what was written, the setup it was sent with, and the status buttons.">
                        <button
                          type="button"
                          className={styles.queueRow}
                          aria-pressed={openId === report.id}
                          data-testid={`admin-report-${report.id}`}
                          onClick={() => {
                            setOpenId(report.id);
                          }}
                        >
                          <span>{reportTitle(report)}</span>
                          <span className={styles.meta}>
                            <ReportStatusBadge status={report.status} />
                            <span className={styles.mono}>{whenWords(report.createdAt)}</span>
                            <span>{`${report.setup.browser}, ${report.setup.os}`}</span>
                          </span>
                        </button>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
      <div className={styles.detail}>
        {error === null ? null : <p className={styles.error} data-testid="admin-error">{error}</p>}
        {opened === null ? (
          <p className={styles.prose}>No report open.</p>
        ) : (
          <ReportDetail key={opened.id} report={opened} busy={busy} onMark={(status) => void mark(opened, status)} />
        )}
      </div>
    </>
  );
}

function ReportDetail({ report, busy, onMark }: { report: BugReport; busy: boolean; onMark: (status: BugReportStatus) => void }) {
  const { copy, label } = useCopy();
  const autoBox = useRef<HTMLPreElement | null>(null);
  const whyBusy = busy ? "A change is on its way." : null;
  const text = (title: string, body: string | undefined, testId: string) =>
    body === undefined || body === "" ? null : (
      <div className={styles.section}>
        <h4 className={styles.sectionHead}>{title}</h4>
        <p className={styles.reportText} data-testid={testId}>
          {body}
        </p>
      </div>
    );
  return (
    <div className={styles.section} data-testid="admin-report">
      <div className={styles.shareHead}>
        <ReportStatusBadge status={report.status} testId="admin-report-status" />
        <span className={styles.hint}>{`Sent ${whenWords(report.createdAt)}`}</span>
        {report.updatedAt === undefined ? null : <span className={styles.hint}>{`Marked ${whenWords(report.updatedAt)}`}</span>}
      </div>
      {text("What happened", report.whatHappened, "admin-report-what")}
      {text("What they expected", report.expected, "admin-report-expected")}
      {text("Steps to make it happen again", report.steps, "admin-report-steps")}
      <div className={styles.section}>
        <h4 className={styles.sectionHead}>Sent with the report</h4>
        <dl className={styles.setupList} data-testid="admin-report-setup">
          {setupRows(report.setup).map((row) => (
            <div key={row.label} className={styles.setupRow}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {report.autoFile === undefined ? (
        <p className={styles.hint}>The reporter did not include their auto file.</p>
      ) : (
        <details className={styles.section} data-testid="admin-report-auto">
          <summary className={styles.prose}>{`The reporter chose to include a snapshot of their auto file (${String(Math.ceil(report.autoFile.length / 1000))} KB), and with it its paths. Open it only to reproduce the bug.`}</summary>
          <pre ref={autoBox} className={styles.autoFile}>
            {report.autoFile}
          </pre>
          <div className={styles.row}>
            <ActionButton
              kind="text"
              tooltip="Copy the auto file"
              hint="Puts the file on the clipboard, to save and open in the editor yourself."
              onClick={() => {
                void copy("the auto file", report.autoFile ?? "", { select: autoBox.current });
              }}
              testId="admin-report-copy-auto"
            >
              {label("Copy")}
            </ActionButton>
          </div>
        </details>
      )}
      <div className={styles.row}>
        <ActionButton
          kind={report.status === "new" ? "primary" : "secondary"}
          tooltip="Mark triaged"
          hint="Says a Horizon admin has read it and knows what to do next."
          whyDisabled={report.status === "triaged" ? "It is already triaged." : whyBusy}
          onClick={() => {
            onMark("triaged");
          }}
          testId="admin-report-triage"
        >
          Mark triaged
        </ActionButton>
        <ActionButton
          kind={report.status === "triaged" ? "primary" : "secondary"}
          tooltip="Close"
          hint="Nothing more will be done. The daily clean-up deletes it 30 days from now."
          whyDisabled={report.status === "closed" ? "It is already closed." : whyBusy}
          onClick={() => {
            onMark("closed");
          }}
          testId="admin-report-close"
        >
          Close
        </ActionButton>
        {report.status === "new" ? null : (
          <ActionButton
            kind="text"
            tooltip="Mark new again"
            hint="Puts it back with the reports nobody has marked."
            whyDisabled={whyBusy}
            onClick={() => {
              onMark("new");
            }}
            testId="admin-report-reopen"
          >
            Mark new
          </ActionButton>
        )}
      </div>
    </div>
  );
}
