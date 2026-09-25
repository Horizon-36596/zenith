/**
 * Sign in to GitHub by pasting a fine-grained personal access token
 * (site/docs/github.md): PAT only for v1, no OAuth App and no device flow yet.
 *
 * The dialog says, inline, exactly which two permissions the token needs, because a token with the
 * wrong ones fails later and further away; `packages/github/README.md` is the long version of the
 * same steps. The field is `type="password"` so a pasted token is not shoulder-read or screenshot,
 * and "remember for this tab" is `sessionStorage` and nothing else.
 */
import { useId, useState } from "react";
import { Button } from "../components/primitives";
import { Modal } from "../dialogs/Modal";
import { setDialog, useEditor } from "../state/store";
import { signInWithToken, signOutOfGitHub } from "./actions";
import { describeScopes } from "./session";
import styles from "./github.module.css";

const TOKEN_SETTINGS_URL = "https://github.com/settings/personal-access-tokens/new";
const README_URL = "https://github.com/Horizon-36596/zenith/blob/main/packages/github/README.md";

export function SignInDialog() {
  const { auth } = useEditor();
  const [token, setToken] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenId = useId();
  const rememberId = useId();

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await signInWithToken(token, remember);
      setToken("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Sign in to GitHub"
      width={560}
      testId="github-signin"
      onClose={() => {
        setDialog(null);
      }}
      footer={
        auth === null ? (
          <>
            <Button
              onClick={() => {
                setDialog(null);
              }}
            >
              Cancel
            </Button>
            <Button
              kind="primary"
              disabled={busy}
              testId="github-signin-submit"
              onClick={() => {
                void submit();
              }}
            >
              Sign in
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
      {auth === null ? (
        <>
          <p className={styles.prose}>
            Zenith signs in with a fine-grained personal access token you paste here. There is no
            OAuth app to authorise and no server of ours in the way: the token is held in this tab
            and sent only to <code className="mono">api.github.com</code>.
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
          <label className={styles.check} htmlFor={rememberId}>
            <input
              id={rememberId}
              type="checkbox"
              data-testid="github-remember"
              checked={remember}
              onChange={(event) => {
                setRemember(event.target.checked);
              }}
            />
            Remember for this tab
          </label>
          <p className={styles.hint}>
            Remembering mirrors the token to <code className="mono">sessionStorage</code>, which the
            browser drops when the tab closes. It is never written to{" "}
            <code className="mono">localStorage</code>, never logged and never sent anywhere but
            GitHub&apos;s API. The full instructions are in{" "}
            <a className={styles.link} href={README_URL} target="_blank" rel="noreferrer">
              packages/github/README.md
            </a>
            .
          </p>
          {error === null ? null : (
            <p className={styles.error} role="alert" data-testid="github-signin-error">
              {error}
            </p>
          )}
        </>
      ) : (
        <>
          <p className={styles.ok} data-testid="github-signed-in">
            Signed in as {auth.login}.
          </p>
          <p className={styles.prose}>
            Permissions: {describeScopes(auth.scopes)}. Signing out drops the token from this tab
            and closes a project opened from GitHub.
          </p>
        </>
      )}
    </Modal>
  );
}
