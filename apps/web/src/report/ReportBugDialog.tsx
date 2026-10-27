/**
 * Report a bug (help.reportBug): three questions, the setup block the report carries, shown before it
 * goes, and an unticked "Include a snapshot of my auto file". That box is the one exception, ruled
 * by the owner on 2026-09-30, to the ruling that Horizon admins never see a team's paths: the
 * reporter chooses it, for this report only, and the dialog says plainly that Horizon admins will
 * see the file's paths. Every report is private. With the cloud on and the person signed in (with a
 * profile and beta access), Send report writes it to the cloud's `bugReports`
 * collection, which only Horizon admins read (cloud/README.md). Signed out, the dialog asks them to
 * sign in to send it. With the cloud off, which is a build from source without a cloud config
 * (releases have it on), there is no Send: Copy report puts a plain-text version on the clipboard, and the
 * dialog links the public repository's new-issue page to paste it into (owner ruling 2026-10-23,
 * #495). That is the one public link, so with the cloud off the snapshot box says the paths become
 * public instead of naming Horizon admins. The desktop app opens the link in the system browser.
 *
 * What was typed is kept in memory (never in storage) while the page is open, so closing the dialog
 * to sign in and coming back loses nothing. Sending clears it. The snapshot box is unticked every
 * time the dialog opens, since the open auto may have changed since it was ticked.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { canonicalize } from "@horizon36596/zenith-core";
import type { Auto } from "@horizon36596/zenith-schema";
import { bugReportProblem, MAX_BUG_EXPECTED, MAX_BUG_STEPS, MAX_BUG_WHAT_HAPPENED } from "@horizon36596/zenith-cloud/bugReports";
import { Button } from "../components/primitives";
import { ISSUES_URL } from "../dialogs/BetaNotice";
import { Modal } from "../dialogs/Modal";
import { cloudEnabled, currentCloudConfig, isWebPage } from "../account/config";
import { account, openAccountPanel, useAccount } from "../account/store";
import { recentActions } from "../app/recentActions";
import { copyFailedWords, selectText, useCopy } from "../app/copyText";
import { isDesktop } from "../project/desktop";
import { isHostMode } from "../project/hostSession";
import { setDialog, useDerived, useEditor } from "../state/store";
import { appVersion, autoAttachment, collectSetup, reportInput, reportText, setupRows } from "./setup";
import styles from "./report.module.css";

interface Draft {
  whatHappened: string;
  expected: string;
  steps: string;
  includeAuto: boolean;
}

const EMPTY: Draft = { whatHappened: "", expected: "", steps: "", includeAuto: false };

/** What was typed, for as long as the page is open. Never written to storage. */
let kept: Draft = EMPTY;

type Outcome = { kind: "sent"; queued: boolean } | { kind: "copied" } | { kind: "copy-failed"; text: string } | null;

/** The open auto as canonical text, without its authors (setup.ts takes them out of the text too). */
function autoText(auto: Auto | null): string | null {
  if (auto === null) return null;
  const { authors: _authors, ...rest } = auto;
  try {
    return canonicalize("auto", rest);
  } catch {
    return JSON.stringify(rest, null, 2);
  }
}

/** The public repository's new-issue page, where a report is pasted while the cloud is off. */
export const NEW_ISSUE_URL = `${ISSUES_URL}/new`;

/** The link to the public new-issue page, inside a sentence. */
const newIssueLink = (
  <a className={styles.link} href={NEW_ISSUE_URL} target="_blank" rel="noreferrer" data-testid="report-bug-new-issue">
    a new issue on GitHub
  </a>
);

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The report could not be sent.";
}

export function ReportBugDialog() {
  const editor = useEditor();
  const derived = useDerived();
  const accountState = useAccount();
  const [draft, setDraftState] = useState<Draft>(() => ({ ...kept, includeAuto: false }));
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const ids = { what: useId(), expected: useId(), steps: useId(), setup: useId(), include: useId() };

  const setDraft = (patch: Partial<Draft>) => {
    setDraftState((current) => {
      const next = { ...current, ...patch };
      kept = next;
      return next;
    });
    setError(null);
    // A copy made before this edit no longer matches what the dialog shows.
    setOutcome((current) => (current?.kind === "sent" ? current : null));
  };

  // The setup is read when the dialog opens, so it describes the moment the person chose to report.
  const [setup] = useState(() =>
    collectSetup({
      appVersion: appVersion(),
      surface: isDesktop() || !isWebPage(window.location.href) ? "desktop" : "web",
      hostMode: isHostMode(),
      userAgent: navigator.userAgent,
      windowWidthPx: window.innerWidth,
      windowHeightPx: window.innerHeight,
      theme: editor.prefs.theme,
      cloudMode: currentCloudConfig().mode,
      findings: derived.findings,
      recentActions: recentActions(),
    }),
  );
  const attachment = useMemo(() => autoAttachment(autoText(editor.auto)), [editor.auto]);
  const input = reportInput(draft, setup, draft.includeAuto && attachment.ok ? attachment.text : null);
  const problem = draft.includeAuto && !attachment.ok ? attachment.reason : bugReportProblem(input);

  const cloud = cloudEnabled();
  const signedIn = accountState.user !== null && accountState.profile !== null;
  const canSend = cloud && signedIn;

  const close = () => {
    setDialog(null);
  };

  // Copy answers as every Copy does (app/copyText.ts): "Copied" on the button and the status line.
  // A refused copy shows the report as text and selects it, so Ctrl C copies it from there.
  const { copy: copyReport, label: copyLabel } = useCopy();
  const reportBox = useRef<HTMLTextAreaElement | null>(null);
  const copy = () => {
    const text = reportText(input);
    void copyReport("the report", text).then((ok) => {
      // With the cloud off the report is pasted by hand, so the dialog says where.
      setOutcome(ok ? (cloud ? null : { kind: "copied" }) : { kind: "copy-failed", text });
    });
  };
  useEffect(() => {
    if (outcome?.kind === "copy-failed") selectText(reportBox.current);
  }, [outcome]);

  const send = async () => {
    const backend = account.cloud();
    if (backend === null) {
      setError("The cloud is still starting. Try again in a moment.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const queued = await backend.sendBugReport(input);
      const online = accountState.online && backend.isOnline();
      if (online) await queued.sent;
      else queued.sent.catch(() => undefined);
      kept = EMPTY;
      setOutcome({ kind: "sent", queued: !online });
    } catch (err) {
      setError(message(err));
    } finally {
      setSending(false);
    }
  };

  if (outcome?.kind === "sent") {
    return (
      <Modal
        title="Report a bug"
        testId="report-bug"
        onClose={close}
        footer={
          <Button kind="primary" testId="report-bug-done" onClick={close}>
            Done
          </Button>
        }
      >
        <p className={styles.prose} data-testid="report-bug-sent">
          {outcome.queued
            ? "Thank you. Your report is saved on this device and goes to Horizon, privately, when you are back online."
            : "Thank you. Your report went to Horizon privately."}
        </p>
      </Modal>
    );
  }

  const blocked = problem ?? (sending ? "Sending already." : null);

  return (
    <Modal
      title="Report a bug"
      testId="report-bug"
      width={600}
      tall
      onClose={close}
      footer={
        <>
          <Button onClick={close} testId="report-bug-cancel">
            Cancel
          </Button>
          {canSend ? (
            <>
              <Button whyDisabled={problem} onClick={copy} testId="report-bug-copy">
                {copyLabel("Copy report")}
              </Button>
              <Button kind="primary" whyDisabled={blocked} onClick={() => void send()} testId="report-bug-send">
                {sending ? "Sending…" : "Send report"}
              </Button>
            </>
          ) : cloud ? (
            <>
              <Button whyDisabled={problem} onClick={copy} testId="report-bug-copy">
                {copyLabel("Copy report")}
              </Button>
              <Button
                kind="primary"
                testId="report-bug-sign-in"
                onClick={() => {
                  close();
                  openAccountPanel("signIn");
                }}
              >
                Sign in to send
              </Button>
            </>
          ) : (
            <Button kind="primary" whyDisabled={problem} onClick={copy} testId="report-bug-copy">
              {copyLabel("Copy report")}
            </Button>
          )}
        </>
      }
    >
      <div className={styles.form}>
        <p className={styles.prose} data-testid="report-bug-where">
          {canSend
            ? "Your report goes privately to Horizon (FTC 36596). Only Horizon admins can read it, and nobody can reply through Zenith."
            : cloud
              ? "Sign in to send this report privately to Horizon. You can also copy it and send it yourself."
              : (
                <>
                  This build of Zenith cannot send reports. Copy the report, then paste it into{" "}
                  {newIssueLink}. Anyone can read issues there.
                </>
              )}
        </p>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={ids.what}>
            What happened? <span className={styles.required}>Required</span>
          </label>
          <textarea
            id={ids.what}
            className={styles.textarea}
            rows={4}
            maxLength={MAX_BUG_WHAT_HAPPENED}
            value={draft.whatHappened}
            data-testid="report-bug-what"
            onChange={(event) => {
              setDraft({ whatHappened: event.target.value });
            }}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={ids.expected}>
            What did you expect to happen?
          </label>
          <textarea
            id={ids.expected}
            className={styles.textarea}
            rows={2}
            maxLength={MAX_BUG_EXPECTED}
            value={draft.expected}
            data-testid="report-bug-expected"
            onChange={(event) => {
              setDraft({ expected: event.target.value });
            }}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={ids.steps}>
            Steps to make it happen again
          </label>
          <textarea
            id={ids.steps}
            className={styles.textarea}
            rows={3}
            maxLength={MAX_BUG_STEPS}
            value={draft.steps}
            placeholder={"1. Open the example.\n2. Drag the first path.\n3. …"}
            data-testid="report-bug-steps"
            onChange={(event) => {
              setDraft({ steps: event.target.value });
            }}
          />
        </div>
        <p className={styles.hint}>Please do not include names, email addresses or anything private. Paths on your computer become [path].</p>

        <section className={styles.setup} aria-labelledby={ids.setup} data-testid="report-bug-setup">
          <h3 id={ids.setup} className={styles.setupHead}>
            Sent with your report
          </h3>
          <p className={styles.hint}>Nothing else about you or your team is sent.</p>
          <dl className={styles.rows}>
            {setupRows(setup).map((row) => (
              <div key={row.label} className={styles.setupRow}>
                <dt>{row.label}</dt>
                <dd className={row.value.includes("\n") ? styles.multi : undefined}>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <div className={styles.check}>
          <input
            id={ids.include}
            type="checkbox"
            checked={draft.includeAuto}
            disabled={editor.auto === null}
            data-testid="report-bug-include-auto"
            onChange={(event) => {
              setDraft({ includeAuto: event.target.checked });
            }}
          />
          <label htmlFor={ids.include}>
            Include a snapshot of my auto file
            <span className={styles.hint} data-testid="report-bug-include-auto-note">
              {editor.auto === null
                ? " No auto is open."
                : attachment.ok
                  ? cloud
                    ? ` Horizon admins will see this file's paths: where your robot drives and when. ${String(attachment.sizeKb)} KB, without its authors.`
                    : ` Pasted into an issue, this file's paths are public: where your robot drives and when. ${String(attachment.sizeKb)} KB, without its authors.`
                  : ` Too large to include (${String(attachment.sizeKb ?? 0)} KB).`}
            </span>
          </label>
        </div>

        {draft.includeAuto && !attachment.ok ? (
          <p className={styles.warn} data-testid="report-bug-too-large">
            {attachment.reason}
          </p>
        ) : null}

        {error === null ? null : (
          <p className={styles.warn} role="alert" data-testid="report-bug-error">
            {error}
          </p>
        )}
        {outcome?.kind === "copied" ? (
          <p className={styles.ok} role="status" data-testid="report-bug-copied">
            Now paste it into {newIssueLink}.
          </p>
        ) : null}
        {outcome?.kind === "copy-failed" ? (
          <>
            <p className={styles.warn} role="alert" data-testid="report-bug-copy-failed">
              {copyFailedWords("the report", true)}
            </p>
            <textarea ref={reportBox} className={styles.textarea} readOnly rows={8} value={outcome.text} data-testid="report-bug-text" />
          </>
        ) : null}
      </div>
    </Modal>
  );
}
