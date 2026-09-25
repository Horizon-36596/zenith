/**
 * Propose: the pull request that reviews itself (site/docs/github.md). The body comes from
 * `core.prBody`, so the editor, the CLI and any bot write the same one: the render, the per-step
 * estimate table with its warnings, the totals against the autonomous period, the ledger at the end
 * and whether the simulator was run.
 *
 * Errors block a proposal and warnings do not; the warnings travel in the body instead, which is
 * what makes them a reviewer's business rather than a silent pass.
 */
import { useState } from "react";
import { MergeConflictError } from "@horizon36596/zenith-github";
import { Button } from "../components/primitives";
import { Modal } from "../dialogs/Modal";
import { currentDerived, setDialog, setStatus, useEditor } from "../state/store";
import { openReview, proposeBlockedReason, proposeCurrent } from "./actions";
import { autoNameOf } from "./backend";
import styles from "./github.module.css";

interface Opened {
  url: string;
  number: number;
  branch: string;
}

export function ProposeDialog() {
  const state = useEditor();
  const [summary, setSummary] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  const blocked = proposeBlockedReason(state);
  const derived = currentDerived();
  const warnings = derived.findings.filter((finding) => finding.severity === "warning").length;
  const autoName = state.fileName === null ? "auto" : autoNameOf(state.fileName);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setConflicts(null);
    try {
      const result = await proposeCurrent(summary, branch);
      setOpened({ url: result.url, number: result.number, branch: result.branch });
      setStatus("ok", `Pull request #${String(result.number)} is open.`);
    } catch (failure) {
      if (failure instanceof MergeConflictError) {
        setConflicts(failure.files);
      } else {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Propose"
      width={600}
      testId="github-propose"
      onClose={() => {
        setDialog(null);
      }}
      footer={
        opened === null ? (
          <>
            <Button
              onClick={() => {
                setDialog(null);
              }}
            >
              Cancel
            </Button>
            <Button
              kind="primary"
              disabled={busy || blocked !== null}
              testId="github-propose-submit"
              onClick={() => {
                void run();
              }}
            >
              {busy ? "Opening…" : "Open pull request"}
            </Button>
          </>
        ) : (
          <>
            <Button
              testId="github-propose-review"
              onClick={() => {
                setDialog(null);
                void openReview(
                  state.repo?.owner ?? "",
                  state.repo?.repo ?? "",
                  opened.number,
                );
              }}
            >
              Open review
            </Button>
            <Button
              kind="primary"
              onClick={() => {
                setDialog(null);
              }}
            >
              Done
            </Button>
          </>
        )
      }
    >
      {blocked === null ? null : (
        <p className={styles.warn} data-testid="github-propose-blocked">
          {blocked}
        </p>
      )}

      {opened === null ? (
        <>
          <p className={styles.prose}>
            Zenith commits <code className="mono">{autoName}</code>, its rendered field SVG and any
            waypoint change to the work branch, brings that branch up to date with{" "}
            <code className="mono">{state.repo?.base ?? "the base branch"}</code>, and opens (or
            updates) the pull request against it.
            {warnings > 0
              ? ` The ${String(warnings)} warning${warnings === 1 ? "" : "s"} on this auto do not block the proposal; they are listed in the body for the reviewer.`
              : ""}
          </p>
          <div className={styles.stack}>
            <label className={styles.label} htmlFor="propose-summary">
              Commit summary
            </label>
            <input
              id="propose-summary"
              className={styles.search}
              placeholder="edit"
              data-testid="propose-summary"
              value={summary}
              onChange={(event) => {
                setSummary(event.target.value);
              }}
            />
          </div>
          <div className={styles.stack}>
            <label className={styles.label} htmlFor="propose-branch">
              Work branch
            </label>
            <input
              id="propose-branch"
              className={styles.search}
              placeholder={state.repo?.branch ?? `auto/${autoName}/<you>`}
              data-testid="propose-branch"
              value={branch}
              onChange={(event) => {
                setBranch(event.target.value);
              }}
            />
            <p className={styles.hint}>
              Leave it empty to use {state.repo?.branch ?? "the branch this auto was opened on"}.
            </p>
          </div>
        </>
      ) : (
        <>
          <p className={styles.ok} data-testid="github-propose-url">
            Pull request #{opened.number} is open from {opened.branch}.
          </p>
          <div className={styles.row}>
            <span className={styles.prUrl}>{opened.url}</span>
            <Button
              testId="github-propose-copy"
              onClick={() => {
                void navigator.clipboard.writeText(opened.url).then(
                  () => {
                    setCopied(true);
                  },
                  () => {
                    setStatus("error", "The browser refused access to the clipboard.");
                  },
                );
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </Button>
            <a className={styles.link} href={opened.url} target="_blank" rel="noreferrer">
              Open on GitHub
            </a>
          </div>
        </>
      )}

      {conflicts === null ? null : (
        <div data-testid="github-propose-conflict">
          <p className={styles.error} role="alert">
            The work branch cannot be brought up to date with {state.repo?.base ?? "the base"}{" "}
            without a conflict. Nothing was written. Resolve these files in a clone, then propose
            again:
          </p>
          <ul className={styles.files}>
            {conflicts.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      )}

      {error === null ? null : (
        <p className={styles.error} role="alert" data-testid="github-propose-error">
          {error}
        </p>
      )}
    </Modal>
  );
}
