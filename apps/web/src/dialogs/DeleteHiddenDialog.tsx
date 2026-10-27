/**
 * Delete all or Cancel, asked before a delete takes hidden steps with it: a group that holds steps a
 * switch hides, such as command steps while Commands is off. The switch names its steps through its
 * hidden-data hooks (`settings/hiddenData.ts`). `app/edits.ts` decides when to ask and does the
 * delete; this only shows the question. Cancel comes first so it has focus when the dialog opens,
 * and Enter keeps the steps. Delete all is one edit, so Undo brings everything back.
 */
import { Button } from "../components/primitives";
import { answerDeleteHidden } from "../app/edits";
import { hiddenStepNoun } from "../state/features";
import { useEditor } from "../state/store";
import { Modal } from "./Modal";
import styles from "./Dialogs.module.css";

/** The dialog's sentence for `hidden` hidden steps, called `noun`, inside `groups` deleted steps. */
export function deleteHiddenSentence(hidden: number, groups: number, noun: { one: string; many: string }): string {
  const holder = groups === 1 ? "This group also holds" : "The steps you selected also hold";
  const steps = hidden === 1 ? `1 ${noun.one} that is hidden` : `${String(hidden)} ${noun.many} that are hidden`;
  return `${holder} ${steps}. Delete ${hidden === 1 ? "it" : "them"} too?`;
}

export function DeleteHiddenDialog() {
  const { deleteHiddenPrompt, prefs } = useEditor();
  if (deleteHiddenPrompt === null) return null;
  return (
    <Modal
      title="Delete hidden steps too?"
      testId="delete-hidden-dialog"
      width={440}
      onClose={() => {
        answerDeleteHidden("cancel");
      }}
      footer={
        <>
          <Button testId="delete-hidden-cancel" onClick={() => answerDeleteHidden("cancel")}>
            Cancel
          </Button>
          <Button kind="primary" testId="delete-hidden-confirm" onClick={() => answerDeleteHidden("delete")}>
            Delete all
          </Button>
        </>
      }
    >
      <p className={styles.prose}>{deleteHiddenSentence(deleteHiddenPrompt.hidden, deleteHiddenPrompt.ids.length, hiddenStepNoun(prefs.features))}</p>
    </Modal>
  );
}