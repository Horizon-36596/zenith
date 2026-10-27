/**
 * Sign in to GitHub (site/docs/github.md). Three ways, the first one that works here first:
 * - "Sign in with GitHub" (`oauthSignIn.ts`): GitHub's own sign-in page, no token to make. Its token
 *   has the `repo` scope, which reaches every repository the account can, and the dialog says so.
 * - The GitHub CLI's own sign-in, in the desktop app when the CLI is installed and signed in
 *   (issue #213).
 * - Pasting a fine-grained personal access token, for anyone who wants access to one repository
 *   only. The dialog says, inline, exactly which two permissions it needs, because a token with the
 *   wrong ones fails later and further away; `packages/github/README.md` is the long version. The
 *   field is `type="password"` so a pasted token is not shoulder-read or screenshot.
 *
 * Where the token is remembered is the person's choice (`TokenKeep`): this page only, until the tab
 * closes (the default), or in this browser until they sign out. In the desktop app the token is also
 * handed to the main process for pull requests (`signInWithToken`), which keeps it encrypted across
 * launches when the box is ticked, so there the choice is one box that says "on this computer".
 *
 * The CLI's token is never remembered anywhere: the page holds it in memory until sign-out or until
 * Zenith closes, and the dialog says plainly that GitHub mode then has the CLI's permissions.
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import { Button } from "../components/primitives";
import { Modal } from "../dialogs/Modal";
import { desktopBridge, isDesktop } from "../project/desktop";
import { setDialog, useEditor } from "../state/store";
import { signInWithGitHubCli, signInWithGitHubOAuth, signInWithToken, signOutOfGitHub } from "./actions";
import { cliNote, readCliState, startsOnCli, type CliState } from "./cliSignIn";
import { clearReturnToGitHub } from "./cloneOffer";
import { cancelOAuth, readOAuthRoute, type OAuthRoute } from "./oauthSignIn";
import { describeScopes } from "./session";
import type { TokenKeep } from "./types";
import styles from "./github.module.css";

const TOKEN_SETTINGS_URL = "https://github.com/settings/personal-access-tokens/new";
const README_URL = "https://github.com/Horizon-36596/zenith/blob/main/packages/github/README.md";

type Mode = "oauth" | "cli" | "token";

/** What the signed-in view says about where the token is kept. */
const KEPT_WORDS: Record<TokenKeep, string> = {
  page: "It is forgotten when this page reloads.",
  tab: "It is remembered until this tab closes.",
  browser: "It is remembered in this browser until you sign out.",
};

/** The three ways to keep the token in a browser: value, label, one line about it. */
const KEEP_CHOICES: ReadonlyArray<readonly [TokenKeep, string, string]> = [
  ["page", "Not at all", "Forgotten when the page reloads."],
  ["tab", "Until this tab closes", "Kept in this tab's session storage."],
  [
    "browser",
    "In this browser until I sign out",
    "Kept in this browser's local storage, so reopening Zenith signs you straight back in. Pick this only on a computer that is yours.",
  ],
];

/** The device flow's code, while the desktop app waits on GitHub. */
interface DeviceCode {
  userCode: string;
  verificationUri: string;
}

export function SignInDialog() {
  const { auth } = useEditor();
  const [token, setToken] = useState("");
  const [keep, setKeep] = useState<TokenKeep>("tab");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cli, setCli] = useState<CliState | "checking">(isDesktop() ? "checking" : "unavailable");
  const [route, setRoute] = useState<OAuthRoute | null>(null);
  const [mode, setMode] = useState<Mode>("token");
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const tokenId = useId();
  const rememberId = useId();
  const keepName = useId();
  // The desktop app is one window, not a browser tab, so the wording says so (sweep D10).
  const inApp = isDesktop();

  // Asked once per opening, so a `gh auth login` made meanwhile is seen the next time. The dialog
  // opens on the first way that works here: GitHub's sign-in, then the CLI, then a token.
  useEffect(() => {
    let live = true;
    void (async () => {
      const [oauth, cliState] = await Promise.all([
        readOAuthRoute(),
        inApp ? readCliState() : Promise.resolve<CliState>("unavailable"),
      ]);
      if (!live) return;
      setRoute(oauth);
      setCli(cliState);
      if (oauth.kind !== "unavailable") setMode("oauth");
      else if (startsOnCli(cliState)) setMode("cli");
    })();
    return () => {
      live = false;
    };
  }, [inApp]);

  // The device flow's code arrives as progress from the desktop app; the popup needs none.
  useEffect(() => {
    const onProgress = desktopBridge()?.cloudSignIn.onProgress;
    if (onProgress === undefined) return undefined;
    return onProgress((event) => {
      if (event.provider === "github" && event.kind === "code") {
        setDevice({ userCode: event.userCode, verificationUri: event.verificationUri });
      }
    });
  }, []);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "cli") {
        await signInWithGitHubCli();
      } else if (mode === "oauth" && route !== null) {
        await signInWithGitHubOAuth(route, keep);
      } else {
        await signInWithToken(token, keep);
        setToken("");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
      setDevice(null);
    }
  };

  const switchTo = (next: Mode): void => {
    if (busy && mode === "oauth") void cancelOAuth();
    setMode(next);
    setError(null);
  };

  const close = (): void => {
    if (busy && mode === "oauth") void cancelOAuth();
    clearReturnToGitHub();
    setDialog(null);
  };

  const oauthReady = route !== null && route.kind !== "unavailable";
  const note = cli === "checking" ? null : cliNote(cli);

  const switchButton = (target: Mode, label: string): ReactNode => (
    <button
      type="button"
      className={styles.textButton}
      data-testid={`github-use-${target}`}
      onClick={() => {
        switchTo(target);
      }}
    >
      {label}
    </button>
  );

  // Where the token is kept: three choices in a browser, one box in the desktop app.
  const keepChoice = inApp ? (
    <>
      <label className={styles.check} htmlFor={rememberId}>
        <input
          id={rememberId}
          type="checkbox"
          data-testid="github-remember"
          checked={keep !== "page"}
          onChange={(event) => {
            setKeep(event.target.checked ? "tab" : "page");
          }}
        />
        Remember on this computer
      </label>
      <p className={styles.hint}>
        Ticked, Zenith keeps it encrypted on this computer until you sign out; unticked, until Zenith closes.
      </p>
    </>
  ) : (
    <fieldset className={styles.keep} data-testid="github-keep">
      <legend className={styles.label}>Remember the sign-in</legend>
      {KEEP_CHOICES.map(([value, label, hint]) => (
        <label key={value} className={styles.keepOption}>
          <input
            type="radio"
            name={keepName}
            value={value}
            data-testid={`github-keep-${value}`}
            checked={keep === value}
            onChange={() => {
              setKeep(value);
            }}
          />
          <span>
            {label}
            <span className={styles.keepHint}>{hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );

  const errorLine =
    error === null ? null : (
      <p className={styles.error} role="alert" data-testid="github-signin-error">
        {error}
      </p>
    );

  const submitLabel = mode === "cli" ? "Sign in with the GitHub CLI" : mode === "oauth" ? "Sign in with GitHub" : "Sign in";
  const submitTestId = mode === "cli" ? "github-signin-cli" : mode === "oauth" ? "github-signin-oauth" : "github-signin-submit";

  return (
    <Modal
      title="Sign in to GitHub"
      width={560}
      testId="github-signin"
      onClose={close}
      footer={
        auth === null ? (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              kind="primary"
              whyDisabled={busy ? "Signing in now." : null}
              testId={submitTestId}
              onClick={() => {
                void submit();
              }}
            >
              {submitLabel}
            </Button>
          </>
        ) : (
          <>
            <Button testId="github-signout" onClick={() => void signOutOfGitHub()}>
              Sign out
            </Button>
            <Button
              kind="primary"
              onClick={() => {
                setDialog("open");
              }}
            >
              Open a repository
            </Button>
          </>
        )
      }
    >
      {auth !== null ? (
        <>
          <p className={styles.ok} data-testid="github-signed-in">
            Signed in as {auth.login}
            {auth.via === "cli" ? " with the GitHub CLI" : auth.via === "oauth" ? " with GitHub" : ""}.
          </p>
          <p className={styles.prose}>
            Permissions: {describeScopes(auth.scopes)}.
            {auth.keep === undefined || inApp ? null : <> {KEPT_WORDS[auth.keep]}</>}
          </p>
        </>
      ) : mode === "oauth" ? (
        <>
          <p className={styles.prose} data-testid="github-oauth-offer">
            GitHub then lets Zenith read and write <strong>every repository your account can</strong>, private
            ones included. GitHub cannot limit this kind of sign-in to one repository. Zenith only touches
            the repository you open, and never writes to its base branch. An organisation that restricts
            outside apps has to approve Zenith once before its repositories show up.
          </p>
          {device === null ? null : (
            <p className={styles.prose} data-testid="github-device-code">
              Type <code className="mono">{device.userCode}</code> on{" "}
              <a className={styles.link} href={device.verificationUri} target="_blank" rel="noreferrer">
                {device.verificationUri}
              </a>
              .
            </p>
          )}
          {keepChoice}
          <div className={styles.row}>
            {switchButton("token", "Use a token for one repository only")}
            {cli === "ready" ? switchButton("cli", "Use the GitHub CLI") : null}
          </div>
          {errorLine}
        </>
      ) : mode === "cli" ? (
        <>
          <p className={styles.prose} data-testid="github-cli-offer">
            The GitHub CLI is signed in on this computer.
          </p>
          <p className={styles.prose}>
            GitHub mode then has the GitHub CLI&apos;s permissions, which usually reach every repository
            your account can. The token stays in memory until you sign out or close Zenith.
          </p>
          <div className={styles.row}>
            {oauthReady ? switchButton("oauth", "Sign in with GitHub instead") : null}
            {switchButton("token", "Paste a personal access token instead")}
          </div>
          {errorLine}
        </>
      ) : (
        <>
          <p className={styles.prose}>
            The token you paste is held in {inApp ? "Zenith" : "this browser"} and sent only to{" "}
            <code className="mono">api.github.com</code>.
          </p>
          <ol className={styles.steps}>
            <li>
              On github.com,{" "}
              <a className={styles.link} href={TOKEN_SETTINGS_URL} target="_blank" rel="noreferrer">
                generate a fine-grained token
              </a>{" "}
              whose resource owner is the account or organisation that owns the robot repository.
            </li>
            <li>
              Repository access: <strong>only that one repository</strong>. Zenith never needs
              another.
            </li>
            <li>
              Repository permissions: <strong>Contents: read and write</strong> (it reads{" "}
              <code className="mono">zenith.json</code> and the robot, field and auto files, and
              commits to work branches) and <strong>Pull requests: read and write</strong> (it opens
              the pull request Propose creates and reads one back for review). Everything else stays
              at no access.
            </li>
            <li>Set an expiry, generate, and paste the token below.</li>
          </ol>
          <div className={styles.stack}>
            <label className={styles.label} htmlFor={tokenId}>
              Personal access token
            </label>
            <input
              id={tokenId}
              className={styles.token}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="github_pat_…"
              data-testid="github-token"
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !busy) void submit();
              }}
            />
          </div>
          {keepChoice}
          <p className={styles.hint}>
            Full instructions:{" "}
            <a className={styles.link} href={README_URL} target="_blank" rel="noreferrer">
              packages/github/README.md
            </a>
            .
          </p>
          <div className={styles.row}>
            {oauthReady ? switchButton("oauth", "Sign in with GitHub instead") : null}
            {cli === "ready" ? switchButton("cli", "Sign in with the GitHub CLI instead") : null}
          </div>
          {route?.kind === "unavailable" ? (
            <p className={styles.hint} data-testid="github-oauth-note">
              {route.reason}
            </p>
          ) : null}
          {note === null ? null : (
            <p className={styles.hint} data-testid="github-cli-note">
              {note}
            </p>
          )}
          {errorLine}
        </>
      )}
    </Modal>
  );
}
