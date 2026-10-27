/**
 * The notice "Import from another planner" leaves (`app/importActions.ts`): what was imported and
 * every warning the importer gave, or why nothing was, with each wrong field named. It is non-modal:
 * the imported path stays editable behind it, and it stays until dismissed or replaced by the next
 * import. Every control carries a tooltip (UI_GUIDE section 8.2).
 */
import { ClipboardCopy, X } from "lucide-react";
import { Button, RowButton } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { dismissImportNotice, useImportNotice } from "../state/importNotice";
import { copyText } from "../app/copyText";
import styles from "./ImportNotice.module.css";

export function ImportNotice() {
  const notice = useImportNotice();
  if (notice === null) return null;
  const heading = notice.tone === "error" ? "Not imported" : notice.tone === "warning" ? "Imported, with warnings" : "Imported";

  return (
    <section
      className={styles.notice}
      data-tone={notice.tone}
      data-testid="import-notice"
      role={notice.tone === "error" ? "alert" : "status"}
      aria-label={heading}
    >
      <div className={styles.head}>
        <p className={styles.title}>
          {notice.title}
          <span className={styles.source}>From {notice.sourceName}</span>
        </p>
        {notice.lines.length === 0 ? null : (
          <RowButton
            icon={ClipboardCopy}
            label="Copy these lines"
            hint="Copy every line of this notice, to paste into an issue or a message to the file's author."
            testId="import-notice-copy"
            onClick={(event) => {
              const text = [notice.title, ...notice.lines].join("\n");
              void copyText("the import notice", text, { select: event.currentTarget.closest("section")?.querySelector("ul") ?? null });
            }}
          />
        )}
        <RowButton
          icon={X}
          label="Dismiss"
          hint="Close this notice. The imported auto stays open; import the file again to see the notice again."
          testId="import-notice-dismiss"
          onClick={dismissImportNotice}
        />
      </div>
      {notice.lines.length === 0 ? null : (
        <ul className={styles.list} data-testid="import-notice-lines">
          {notice.lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
      {notice.action === undefined ? null : (
        <div className={styles.actions}>
          <Tooltip label={notice.action.label} hint={notice.action.hint}>
            <Button testId={notice.action.testId} onClick={notice.action.run}>
              {notice.action.label}
            </Button>
          </Tooltip>
        </div>
      )}
    </section>
  );
}
