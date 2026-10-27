/**
 * Save, in GitHub mode: a commit needs a message, so the editor asks for the one line that goes
 * after `auto(<name>):` rather than inventing one (site/docs/github.md). Leaving it alone commits
 * `auto(<name>): edit`, which is the rule's own default.
 *
 * The branch is shown, not hidden, because it is the whole safety story: this is the work branch,
 * the base branch is never written to, and Save is disabled outright if the two are the same.
 */
import { useState } from "react";
import { save } from "../app/projectActions";
import { Button } from "../components/primitives";
import { Modal } from "../dialogs/Modal";
import { setDialog, useEditor } from "../state/store";
import { autoNameOf } from "./backend";
import styles from "./github.module.css";

export function CommitDialog() {
  const { repo, fileName, busy } = useEditor();
  const [summary, setSummary] = useState("");

  const autoName = fileName === null ? "auto" : autoNameOf(fileName);
  const onBase = repo !== null && repo.branch === repo.base;
  const message = `auto(${autoName}): ${summary.trim() === "" ? "edit" : summary.trim()}`;

  return (
    <Modal
      title="Commit this auto"
      width={560}
      testId="github-commit"
      onClose={() => {
        setDialog(null);
      }}
      footer={
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
            whyDisabled={busy ? "Saving now." : onBase ? `${repo?.branch ?? "This"} is the base branch, which Zenith never writes to.` : null}
            testId="github-commit-submit"
            onClick={() => {
              setDialog(null);
              void save(summary);
            }}
          >
            Commit
          </Button>
        </>
      }
    >
      <div className={styles.stack}>
        <label className={styles.label} htmlFor="github-summary">
          Summary
        </label>
        <input
          id="github-summary"
          className={styles.search}
          placeholder="edit"
          data-testid="github-summary"
          value={summary}
          onChange={(event) => {
            setSummary(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !onBase) {
              setDialog(null);
              void save(summary);
            }
          }}
        />
      </div>
      <p className={styles.prose}>
        Commits <code className="mono">{message}</code> on{" "}
        <code className="mono">{repo?.branch ?? "—"}</code>.
      </p>
      {onBase ? (
        <p className={styles.warn}>
          {repo?.branch} is the base branch, which Zenith never writes to. Name a work branch in the
          open-project dialog.
        </p>
      ) : null}
    </Modal>
  );
}
