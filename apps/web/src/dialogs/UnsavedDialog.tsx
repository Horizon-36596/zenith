/**
 * Save, Discard or Cancel, asked before something replaces an auto that has unsaved edits (QA-12).
 * `app/unsaved.ts` decides when to ask and waits for the answer; this only shows the question.
 * Cancel comes first so it has focus when the dialog opens, and Enter keeps the edits.
 *
 * `UnsavedChoices` is the question's three buttons, in one order and one set of words, wherever
 * unsaved work can be lost: this dialog, and the ask when Settings closes with a robot.json draft
 * (UI_GUIDE 9.14, 9.17).
 */
import { Button } from "../components/primitives";
import { answerUnsaved, type UnsavedChoice } from "../app/unsaved";
import { useEditor } from "../state/store";
import { Modal } from "./Modal";
import styles from "./Dialogs.module.css";

export function UnsavedChoices({
  saveLabel = "Save",
  onAnswer,
  saving = null,
  testId,
}: {
  saveLabel?: string;
  onAnswer: (choice: UnsavedChoice) => void;
  /** Why Save cannot be pressed again, while a save is on its way; null otherwise. */
  saving?: string | null;
  /** The buttons' test ids are `<testId>-cancel`, `-discard` and `-save`. */
  testId: string;
}) {
  return (
    <>
      <Button testId={`${testId}-cancel`} onClick={() => onAnswer("cancel")}>
        Cancel
      </Button>
      <Button testId={`${testId}-discard`} onClick={() => onAnswer("discard")}>
        Discard changes
      </Button>
      <Button kind="primary" testId={`${testId}-save`} whyDisabled={saving} onClick={() => onAnswer("save")}>
        {saving === null ? saveLabel : "Saving…"}
      </Button>
    </>
  );
}

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
      footer={<UnsavedChoices testId="unsaved" saveLabel={unsavedPrompt.saveLabel ?? "Save"} onAnswer={answerUnsaved} />}
    >
      <p className={styles.prose}>
        {unsavedPrompt.lead ?? `${unsavedPrompt.fileName} has edits that are not saved.`} {unsavedPrompt.next}
      </p>
    </Modal>
  );
}
