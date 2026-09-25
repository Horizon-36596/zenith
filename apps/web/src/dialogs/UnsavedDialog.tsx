/**
 * Save, Discard or Cancel, asked before something replaces an auto that has unsaved edits (QA-12).
 * `app/unsaved.ts` decides when to ask and waits for the answer; this only shows the question.
 * Cancel comes first so it has focus when the dialog opens, and Enter keeps the edits.
 */
import { Button } from "../components/primitives";
import { answerUnsaved } from "../app/unsaved";
import { useEditor } from "../state/store";
import { Modal } from "./Modal";
import styles from "./Dialogs.module.css";

export function UnsavedDialog() {
  const { unsavedPrompt } = useEditor();
  if (unsavedPrompt === null) return null;
  return (
    <Modal
      title="Unsaved changes"
      testId="unsaved-dialog"
      width={440}
      onClose={() => {
        answerUnsaved("cancel");
      }}
      footer={
        <>
          <Button testId="unsaved-cancel" onClick={() => answerUnsaved("cancel")}>
            Cancel
          </Button>
          <Button testId="unsaved-discard" onClick={() => answerUnsaved("discard")}>
            Discard changes
          </Button>
          <Button kind="primary" testId="unsaved-save" onClick={() => answerUnsaved("save")}>
            Save
          </Button>
        </>
      }
    >
      <p className={styles.prose}>
        {unsavedPrompt.fileName} has edits that are not saved. {unsavedPrompt.next}
      </p>
    </Modal>
  );
}
