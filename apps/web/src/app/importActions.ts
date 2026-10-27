/**
 * "Import from another planner": pick a Pedro Visualizer `.pp` project or an interchange `path.json`
 * or `trajectory.json`, import it against the open project's field and open it as a new auto that
 * is not saved yet, with the importer's warnings in a notice beside the field
 * (`dialogs/ImportNotice.tsx`). Save writes it into the project's autos directory like any other
 * auto, or downloads it from a read-only project such as the example, and from there it goes into
 * the team library and is shared like any other.
 *
 * To show a partner's `trajectory.json` beside an auto with its own timing, without making it an
 * auto, the Partners panel loads it instead (`alliance/source.ts`).
 */
import { refreshAutoList } from "./autoList";
import { confirmReplace } from "./unsaved";
import { newAutoSavedLine } from "./newAuto";
import {
  importAutoFile,
  IMPORT_ACCEPT,
  MAX_IMPORT_BYTES,
  otherAlliance,
  tooLargeMessage,
  type ImportChoices,
  type ImportOutcome,
} from "./importFile";
import { say } from "./projectActions";
import { clearStatus, getState, openAuto, setBusy, setStatus } from "../state/store";
import { showImportNotice, type ImportNoticeAction } from "../state/importNotice";

/** Why the import action cannot run, or null when it can. */
export function importBlockedReason(state: ReturnType<typeof getState>): string | null {
  if (state.project === null) return "Open a project first: an imported auto is checked against its robot and field.";
  if (state.review !== null) return "Review mode is read only.";
  return null;
}

/**
 * Opens the file picker. The input is put in the page, hidden, for as long as the picker is open
 * (some browsers only open a picker for an input in the document), and the browser gives the file
 * back through its change event.
 */
export function pickImportFile(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = IMPORT_ACCEPT;
  input.hidden = true;
  input.dataset["testid"] = "import-file-input";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.remove();
    if (file !== undefined) void importFromFile(file);
  });
  input.addEventListener("cancel", () => {
    input.remove();
  });
  document.body.append(input);
  input.click();
}

/** Puts the outcome of an import in the notice, with the one thing that can be done about it, if any. */
function notify(sourceName: string, outcome: ImportOutcome, action?: ImportNoticeAction): void {
  if (!outcome.ok) {
    showImportNotice({
      tone: "error",
      title: outcome.message,
      sourceName,
      lines: outcome.issues.map((issue) => `${issue.path === "" ? "(file)" : issue.path}: ${issue.message}`),
    });
    return;
  }
  const what = outcome.source === "pedro" ? "Pedro Visualizer project" : outcome.source === "trajectory" ? "trajectory.json" : "path.json";
  showImportNotice({
    tone: outcome.warnings.length === 0 ? "ok" : "warning",
    title:
      outcome.warnings.length === 0
        ? `Imported the ${what} as ${outcome.fileName}, with nothing to warn about. It is not saved yet.`
        : `Imported the ${what} as ${outcome.fileName}. It is not saved yet; read these before you save it.`,
    sourceName,
    lines: outcome.warnings,
    ...(action === undefined ? {} : { action }),
  });
}

/** Imports one picked file and opens the result, asking first when the open auto has unsaved edits. */
export async function importFromFile(file: File): Promise<void> {
  const state = getState();
  const blocked = importBlockedReason(state);
  if (blocked !== null || state.project === null) {
    setStatus("error", blocked ?? "Open a project first.");
    return;
  }
  // The size cap comes before the read, so an oversized file is never held in memory.
  if (file.size > MAX_IMPORT_BYTES) {
    // The notice says it, so the status line does not say it a second time.
    notify(file.name, { ok: false, message: tooLargeMessage(file.name, file.size), issues: [] });
    clearStatus();
    return;
  }
  setBusy(true);
  try {
    await importText(file.name, await file.text(), {}, null);
  } catch (error) {
    setStatus("error", say(error));
  } finally {
    setBusy(false);
  }
}

/**
 * Imports a file's text and opens the result. `replacing` is the auto a previous import of the same
 * file opened: while it is still open and unedited, the new import takes its place without asking.
 * The project's autos are listed again first, so the name skips a file written since it opened
 * (issue #157).
 */
async function importText(
  sourceName: string,
  text: string,
  choices: ImportChoices,
  replacing: ImportOutcome | null,
): Promise<void> {
  const project = await refreshAutoList();
  if (project === null) {
    setStatus("error", "Open a project first.");
    return;
  }
  const outcome = importAutoFile(sourceName, text, project.field, project.autoFiles, choices);
  if (!outcome.ok) {
    // The refusal is said once, in the notice; an earlier action's line would be stale beside it.
    notify(sourceName, outcome);
    clearStatus();
    return;
  }
  const untouched = replacing !== null && replacing.ok && getState().auto === replacing.auto;
  if (!untouched && !(await confirmReplace(`Importing ${sourceName} will replace it.`))) {
    setStatus("info", `Kept the unsaved edits in ${getState().fileName ?? "this auto"}.`);
    return;
  }
  // An empty saved text makes the new auto count as unsaved until the person saves it.
  openAuto(outcome.fileName, outcome.auto, "");
  // A .pp project records no alliance, so the notice offers the other one.
  const assumed = outcome.assumedAlliance;
  const action: ImportNoticeAction | undefined =
    assumed === undefined
      ? undefined
      : {
          label: `Import for ${otherAlliance(assumed)}`,
          hint: `Import ${sourceName} again as drawn for the ${otherAlliance(assumed)} alliance, in place of this auto. The poses stay as the file has them; only the alliance the auto is written for changes.`,
          testId: "import-notice-other-alliance",
          run: () => {
            void importText(sourceName, text, { alliance: otherAlliance(assumed) }, outcome);
          },
        };
  notify(sourceName, outcome, action);
  setStatus("info", importedLine(sourceName, outcome.fileName, choices.alliance, newAutoSavedLine(project)));
}

/**
 * The status line after an import. What Save does comes from the project: it writes into a project
 * opened from a folder, and downloads from a read-only one such as the bundled example.
 */
export function importedLine(
  sourceName: string,
  fileName: string,
  alliance: string | undefined,
  savedLine: string,
): string {
  const head =
    alliance === undefined
      ? `Imported ${sourceName} as ${fileName}.`
      : `Imported ${sourceName} as ${fileName}, written for ${alliance}.`;
  return `${head} ${savedLine}`;
}
