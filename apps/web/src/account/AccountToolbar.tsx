/**
 * The toolbar's cloud controls (spec 13 sections 4.1 and 6): an Offline
 * badge while there is no connection, the Library and Outbox buttons, and Sign in, which becomes the
 * account button once someone is signed in. With the cloud off, none of it renders and the toolbar
 * is exactly what it is without accounts.
 */
import { Inbox, LibraryBig, UserRound, WifiOff } from "lucide-react";
import { ToolButton } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { cloudEnabled } from "./config";
import { whyCannotOpenLibrary } from "./permissions";
import { openSettings, useSettings } from "../settings/store";
import { account, toggleAccountPanel, useAccount } from "./store";
import styles from "./account.module.css";

export function AccountToolbar() {
  const state = useAccount();
  const settings = useSettings();
  if (!cloudEnabled()) return null;
  const signedIn = state.user !== null && state.profile !== null;
  const queued = state.outbox?.queued ?? 0;
  const libraryWhy = !signedIn ? "Sign in to open your team's library." : whyCannotOpenLibrary(account.role());
  return (
    <div className={styles.toolbarGroup} data-testid="account-toolbar">
      {state.online ? null : (
        <Tooltip
          label="Offline"
          hint="No connection. The team library you saved opens, and changes wait in the outbox until the connection comes back."
        >
          <span className={styles.offline} tabIndex={0} role="status" data-testid="offline-badge">
            <WifiOff size={12} strokeWidth={1.75} aria-hidden />
            Offline
          </span>
        </Tooltip>
      )}
      {signedIn ? (
        <>
          <ToolButton
            icon={LibraryBig}
            label="Team library"
            hint={libraryWhy === null ? "Your team's autos and every revision of them." : `Unavailable: ${libraryWhy}`}
            disabled={libraryWhy !== null}
            active={state.panel === "library"}
            toggle
            testId="toolbar-account.library"
            onClick={() => {
              toggleAccountPanel("library");
            }}
          />
          <ToolButton
            icon={Inbox}
            label={queued === 0 ? "Outbox" : `Outbox, ${String(queued)} waiting`}
            hint="Changes made on this computer, and whether the server has them yet."
            active={state.panel === "outbox"}
            toggle
            testId="toolbar-account.outbox"
            onClick={() => {
              toggleAccountPanel("outbox");
            }}
          />
          {queued === 0 ? null : (
            <span className={styles.count} data-testid="outbox-count" aria-hidden>
              {queued}
            </span>
          )}
        </>
      ) : null}
      <Tooltip
        label={signedIn ? `Signed in as ${state.profile?.displayName ?? ""}` : "Sign in"}
        hint={
          signedIn
            ? "Opens Settings at your account: your display name, your teams, signing out and your data."
            : "Optional. Adds a team library and sharing; everything else works without an account."
        }
      >
        <button
          type="button"
          className={styles.signIn}
          aria-pressed={signedIn ? settings.open : state.panel === "signIn"}
          data-testid={signedIn ? "toolbar-account" : "toolbar-sign-in"}
          onClick={() => {
            if (signedIn) openSettings("account");
            else toggleAccountPanel("signIn");
          }}
        >
          {signedIn ? (
            <>
              <UserRound size={16} strokeWidth={1.75} aria-hidden />
              <span className={styles.who}>{state.profile?.displayName}</span>
            </>
          ) : (
            "Sign in"
          )}
        </button>
      </Tooltip>
    </div>
  );
}
