/**
 * The open auto as the team library knows it: which library auto it is, and which revision a share
 * of it is made from (spec 13 section 8.3). A local auto maps to a library
 * auto by its file name, and to a revision by this device's own record of what it last published
 * or opened (`AccountModel.baseOf`, the same base the next publish is built on).
 */
import { account, editorDirty, useAccount } from "../account/store";
import type { AccountState } from "../account/model";
import { libraryStatusOf, type LibraryStatus } from "../library/libraryModel";
import { useEditor, type State } from "../state/store";

export function openAutoStatus(editor: State, state: AccountState): LibraryStatus {
  return libraryStatusOf(
    state.library,
    { fileName: editor.fileName, savedCanonical: editor.savedCanonical, dirty: editorDirty(editor) },
    (autoId) => account.baseOf(autoId),
  );
}

/** The open auto's library auto id, or null when the library has none of it yet. */
export function libraryAutoIdOf(status: LibraryStatus): string | null {
  return status.kind === "published" || status.kind === "changed" ? status.autoId : null;
}

export function useOpenAutoStatus(): LibraryStatus {
  return openAutoStatus(useEditor(), useAccount());
}
