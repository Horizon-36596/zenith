/**
 * The toolbar's right-hand status in GitHub mode: who is signed in, which repository is open and
 * which branch a Save would commit to. It stands where the project name stands in local mode
 * (apps/web/UI_GUIDE.md section 8.1), because in GitHub mode that is what "which project" means.
 *
 * Initials rather than an avatar: no image is fetched, so nothing about the session leaves the tab.
 */
import { Tooltip } from "../components/Tooltip";
import { setDialog, useEditor } from "../state/store";
import { initialsOf } from "./types";
import styles from "./github.module.css";

export function StatusChip() {
  const { auth, repo } = useEditor();
  if (auth === null && repo === null) return null;

  const onBase = repo !== null && repo.branch === repo.base;
  const hint =
    repo === null
      ? "Signed in, with no repository open yet."
      : onBase
        ? `Editing would commit to ${repo.base}, the base branch, which Zenith never writes to. Open an auto to get a work branch.`
        : `Save commits to ${repo.branch}. The base branch ${repo.base} is never written to.`;

  return (
    <Tooltip label={auth === null ? "GitHub" : `Signed in as ${auth.login}`} hint={hint}>
      <button
        type="button"
        className={styles.chip}
        data-testid="github-chip"
        onClick={() => {
          setDialog("signIn");
        }}
      >
        {auth === null ? null : (
          <span className={styles.initials} aria-hidden>
            {initialsOf(auth.login)}
          </span>
        )}
        {repo === null ? (
          <span className={styles.repoName}>no repository</span>
        ) : (
          <>
            <span className={styles.repoName}>
              {repo.owner}/{repo.repo}
            </span>
            <span className={onBase ? styles.baseWarn : styles.branch}>{repo.branch}</span>
          </>
        )}
      </button>
    </Tooltip>
  );
}
