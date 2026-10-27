/**
 * What the sign-in dialog says about the GitHub CLI (issue #213). Only the desktop app can run `gh`,
 * so in a browser, or in a desktop build without the calls, the CLI is simply not offered and the
 * dialog is the personal access token one it always was.
 */
import { desktopBridge } from "../project/desktop";
import type { DesktopGhCliStatus } from "../project/desktopBridge";

/** `unavailable` when this build cannot ask (a browser, an older desktop build). */
export type CliState = DesktopGhCliStatus["state"] | "unavailable";

/** Asks the desktop app whether `gh` is installed and signed in. Never throws. */
export async function readCliState(): Promise<CliState> {
  const github = desktopBridge()?.github;
  if (github?.cliStatus === undefined || github.cliToken === undefined) return "unavailable";
  try {
    return (await github.cliStatus()).state;
  } catch {
    return "missing";
  }
}

/** The dialog opens on the CLI when it is ready, and on the token form otherwise. */
export const startsOnCli = (state: CliState): boolean => state === "ready";

/**
 * The one line under the token form about the CLI, or null when there is nothing useful to say:
 * a browser cannot use it, and someone without `gh` does not need to hear about it.
 */
export function cliNote(state: CliState): string | null {
  if (state === "signed-out") {
    return "The GitHub CLI is installed but not signed in. Run gh auth login in a terminal, then open this again to sign in with it instead.";
  }
  return null;
}
