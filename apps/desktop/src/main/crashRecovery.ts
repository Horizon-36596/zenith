/**
 * What happens when the page stops: a renderer crash, or a page that could not load. Without this the
 * window stayed blank, with no word about why and no way back but closing it, and closing it then
 * lost any unsaved edits without asking, because a stopped page cannot answer the close question.
 *
 * Two parts, both kept free of Electron so they can be tested without a window:
 *
 * - `DraftKeeper` holds the page's unsaved edits as the page last sent them (`drafts.hold`): the open
 *   auto's file name and canonical text, in memory only, never on disk. After a crash and Reload the
 *   new page takes them back once (`drafts.take`) and opens them as unsaved edits again.
 * - `stoppedQuestion` words main's own native question, "Zenith stopped.", with Reload, a Save the
 *   edits as… when there are any, and Close Zenith. index.ts shows it and closeGuard.ts routes its
 *   answer.
 */
import type { DesktopDraft } from "../../../web/src/project/desktopBridge.js";
import { BridgeError } from "./confine.js";
import { COPY_LIMIT_BYTES } from "./saveCopy.js";

/** Checks a draft the page sent: a bare auto file name and its text, within the copy limit. */
export function checkDraft(value: unknown): DesktopDraft | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") throw new BridgeError("That is not a draft Zenith can keep.");
  const { root, fileName, text } = value as Record<string, unknown>;
  if (typeof fileName !== "string" || fileName === "" || fileName.length > 255 || /[\\/]/.test(fileName)) {
    throw new BridgeError("That draft has no usable file name, so Zenith did not keep it.");
  }
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > COPY_LIMIT_BYTES) {
    throw new BridgeError("That draft is too large to be an auto, so Zenith did not keep it.");
  }
  if (root !== null && typeof root !== "string") throw new BridgeError("That draft names no project folder.");
  return { root, fileName, text };
}

export class DraftKeeper {
  #draft: DesktopDraft | null = null;
  #recovering = false;

  /** The page's unsaved edits, or null once it has none. */
  hold(value: unknown): void {
    this.#draft = checkDraft(value);
  }

  held(): DesktopDraft | null {
    return this.#draft;
  }

  /** The page is being reloaded after it stopped: the next page may take the edits back. */
  recover(): void {
    this.#recovering = true;
  }

  /**
   * The edits for a page reloaded after a stop, once; null for any other page, which starts clean
   * as always. The edits stay held, so a second crash before they are saved does not lose them.
   */
  take(): DesktopDraft | null {
    if (!this.#recovering) return null;
    this.#recovering = false;
    return this.#draft;
  }
}

export type StoppedChoice = "reload" | "save" | "close";

export interface StoppedQuestion {
  message: string;
  detail: string;
  buttons: string[];
  /** The choice each button makes, in the same order. */
  choices: StoppedChoice[];
}

/**
 * Main's question when the page has stopped (`why` "crashed" or "load") or when the window of a
 * stopped page is being closed (`why` "close"). Reload is first, the default and what Esc does, since
 * it loses nothing. `saved` names the copy just written, after Save edits as….
 */
export function stoppedQuestion(why: "crashed" | "load" | "close", draft: DesktopDraft | null, saved: string | null = null): StoppedQuestion {
  const message = why === "close" ? "Close Zenith?" : why === "load" ? "Zenith could not load its page." : "Zenith stopped.";
  const cause =
    why === "close"
      ? "The page stopped, so Zenith cannot ask it about your edits."
      : why === "load"
        ? "The editor's page did not load. Reload tries again."
        : "The editor's page crashed. Reload starts it again.";
  const closeLabel = why === "close" && draft !== null ? "Close without saving" : "Close Zenith";
  const edits =
    draft === null
      ? "Nothing was left unsaved."
      : saved !== null
        ? `Saved a copy of your edits to ${draft.fileName} as ${saved}. Reload also brings them back.`
        : `Your unsaved edits to ${draft.fileName} are kept: Reload brings them back, and ${closeLabel} loses them.`;
  const choices: StoppedChoice[] = draft === null || saved !== null ? ["reload", "close"] : ["reload", "save", "close"];
  const label: Record<StoppedChoice, string> = { reload: "Reload", save: "Save edits as…", close: closeLabel };
  return {
    message,
    detail: `${cause}\n\n${edits}`,
    buttons: choices.map((choice) => label[choice]),
    choices,
  };
}
