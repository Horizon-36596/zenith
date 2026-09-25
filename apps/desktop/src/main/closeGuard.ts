/**
 * Closing the window with unsaved edits asks first (QA-12). Every way out reaches the window's
 * `close` event: the title bar's X, Alt+F4, the taskbar's Close window, and File > Exit, whose
 * `app.quit()` closes each window in turn. `before-quit` is routed here too, so a quit is held while
 * the question is open.
 *
 * Main cannot see the editor's state, so it asks the page. The page answers through the shared
 * Save / Discard / Cancel dialog (apps/web/src/app/unsaved.ts), or at once when nothing is unsaved,
 * and main then closes for real or keeps the window. A page that never said it listens (still
 * loading, crashed, or a build without the bridge) cannot answer, so its window closes as before
 * rather than refusing to close at all.
 *
 * Kept free of Electron so the decisions can be tested without a window.
 */

export interface GuardedWindow {
  isDestroyed(): boolean;
  close(): void;
  /** Asks the page whether it may close. */
  askPage(): void;
}

export class CloseGuard {
  /** The page has registered for close requests, so it can answer one. */
  private listening = false;
  /** A question is out and not yet answered: further close attempts wait for it. */
  private asking = false;
  /** The page said yes: the next close goes through, once. */
  private approved = false;
  /** The close being answered came from a quit, so a yes quits the app rather than only closing. */
  private quitting = false;

  constructor(
    private readonly window: GuardedWindow,
    private readonly quit: () => void,
  ) {}

  /** The page subscribed to close requests. */
  pageListening(): void {
    this.listening = true;
  }

  /** The page went away (navigation, reload or a crash); until it subscribes again, closing is free. */
  pageGone(): void {
    this.listening = false;
    this.asking = false;
  }

  /** From the window's `close` event: true to let it close, false to prevent it for now. */
  onClose(): boolean {
    if (this.approved || !this.listening) return true;
    if (!this.asking) {
      this.asking = true;
      this.window.askPage();
    }
    return false;
  }

  /** From `before-quit`: true to let the quit go on, false to hold it while the page is asked. */
  onBeforeQuit(): boolean {
    if (this.approved || !this.listening || this.window.isDestroyed()) return true;
    this.quitting = true;
    return this.onClose();
  }

  /** The page's answer: true after Save succeeded or Discard, false on Cancel or a failed save. */
  answer(ok: boolean): void {
    if (!this.asking) return;
    this.asking = false;
    if (!ok) {
      this.quitting = false;
      return;
    }
    this.approved = true;
    if (this.quitting) this.quit();
    else if (!this.window.isDestroyed()) this.window.close();
  }
}
