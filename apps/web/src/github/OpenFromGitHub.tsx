/**
 * The GitHub branch of the open-project dialog (site/docs/github.md
 * and apps/web/UI_GUIDE.md section 8.10): sign in, pick a repository you can push to, pick the
 * base branch, open. Without a token it lists nothing at all and says so — it never makes an
 * unauthenticated request on the chance that a repository is public.
 *
 * The base branch is the one thing the app never writes to; what a Save commits to is the work
 * branch, named here and shown in the toolbar chip.
 *
 * When the open folder project is a clone of a GitHub repository (desktop app only), the tab offers
 * that repository first, with its base already chosen, and fills the picker in with it (issue #213).
 */
import { useEffect, useRef, useState } from "react";
import type { GitHubClient, RepoSummary } from "@horizon36596/zenith-github";
import { Button } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { setDialog, useEditor } from "../state/store";
import { openFromGitHub, openReviewFromUrl, setWorkBranch } from "./actions";
import { markReturnToGitHub, originName, useCloneOrigin } from "./cloneOffer";
import { currentClient } from "./session";
import styles from "./github.module.css";

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Lists `summary`'s branches into `show`, or its failure into `fail`, unless another repository has
 * been picked since: clicking A then B with A's list arriving last must not leave A's branches in
 * B's base picker (issue #407).
 */
export async function listBranches(
  client: Pick<GitHubClient, "branches">,
  summary: RepoSummary,
  latest: { current: string | null },
  show: (names: string[]) => void,
  fail: (message: string) => void,
): Promise<void> {
  try {
    const list = await client.branches.list(summary.owner, summary.repo);
    if (latest.current === summary.fullName) show(list.map((branch) => branch.name));
  } catch (failure) {
    if (latest.current === summary.fullName) fail(say(failure));
  }
}

export function GitHubTab() {
  const { auth, project, repo, fileName, busy } = useEditor();
  const origin = useCloneOrigin();
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<RepoSummary | null>(null);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [base, setBase] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** The repository picked last, so a slower branch list for an earlier pick is dropped (issue #407). */
  const latestPick = useRef<string | null>(null);

  // Repositories are only ever listed for a signed-in account; there is no anonymous path.
  useEffect(() => {
    const client = currentClient();
    if (auth === null || client === null) {
      setRepos(null);
      return;
    }
    let live = true;
    setLoading(true);
    client.repos.listWritable().then(
      (list) => {
        if (!live) return;
        setRepos(list);
        setLoading(false);
      },
      (failure: unknown) => {
        if (!live) return;
        setError(say(failure));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [auth]);

  const choose = (summary: RepoSummary, startBase = summary.defaultBranch): void => {
    const client = currentClient();
    latestPick.current = summary.fullName;
    setPicked(summary);
    setBase(startBase);
    setBranches(null);
    setError(null);
    if (client !== null) void listBranches(client, summary, latestPick, setBranches, setError);
  };

  // A clone's repository is filled in for the person, at the clone's base, once the list arrives.
  useEffect(() => {
    if (origin === null || repos === null || picked !== null) return;
    const name = originName(origin).toLowerCase();
    const match = repos.find((summary) => summary.fullName.toLowerCase() === name);
    if (match === undefined) return;
    setQuery(match.fullName);
    choose(match, origin.base);
    // `choose` is a fresh function each render; the list and the origin are what this waits on.
  }, [origin, repos]);

  if (auth === null) {
    return (
      <>
        {origin === null || project === null ? null : (
          <p className={styles.prose} data-testid="github-clone-offer">
            {project.name} is a clone of <code className="mono">{originName(origin)}</code>.
          </p>
        )}
        <p className={styles.prose}>
          Sign in to list the repositories your token can push to.
        </p>
        <div className={styles.row}>
          <Button
            kind="primary"
            testId="github-open-signin"
            onClick={() => {
              markReturnToGitHub();
              setDialog("signIn");
            }}
          >
            Sign in to GitHub
          </Button>
        </div>
      </>
    );
  }

  const matches = (repos ?? []).filter((summary) =>
    summary.fullName.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <>
      <p className={styles.prose}>
        Signed in as {auth.login}.
      </p>

      {origin === null || project === null ? null : (
        <div className={styles.stack} data-testid="github-clone-offer">
          <div className={styles.row}>
            <Button
              tooltip="Open this repository in GitHub mode"
              hint={`Opens it from GitHub at ${origin.base}, the branch the folder's pull requests go into. Your folder stays as it is.`}
              whyDisabled={busy ? "Opening a project now." : null}
              testId="github-open-clone"
              onClick={() => {
                void openFromGitHub(origin.owner, origin.repo, origin.base);
              }}
            >
              Open this repository in GitHub mode
            </Button>
          </div>
          <p className={styles.hint}>
            {project.name} is a clone of <code className="mono">{originName(origin)}</code>.
          </p>
        </div>
      )}

      <div className={styles.stack}>
        <label className={styles.label} htmlFor="github-repo-search">
          Repository
        </label>
        <input
          id="github-repo-search"
          className={styles.search}
          type="search"
          placeholder="owner/repo"
          data-testid="github-repo-search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </div>

      <div className={styles.list} data-testid="github-repo-list">
        {loading ? (
          <p className={styles.empty}>Listing the repositories this token can push to…</p>
        ) : matches.length === 0 ? (
          <p className={styles.empty}>
            {repos === null
              ? "No repositories yet."
              : "No repository this token can push to matches that."}
          </p>
        ) : (
          matches.slice(0, 50).map((summary) => (
            <button
              key={summary.fullName}
              type="button"
              className={styles.listRow}
              aria-selected={picked?.fullName === summary.fullName}
              data-testid={`github-repo-${summary.fullName}`}
              onClick={() => {
                choose(summary);
              }}
            >
              <span>{summary.fullName}</span>
              <span className={styles.listMeta}>
                {summary.private ? "private" : "public"} · {summary.defaultBranch}
              </span>
            </button>
          ))
        )}
      </div>

      {picked === null ? null : (
        <div className={styles.row}>
          <label className={styles.label} htmlFor="github-base">
            Base branch
          </label>
          <select
            id="github-base"
            className={styles.search}
            style={{ width: "auto", minWidth: "200px" }}
            data-testid="github-base"
            value={base}
            onChange={(event) => {
              setBase(event.target.value);
            }}
          >
            {(branches ?? [base]).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <Button
            kind="primary"
            whyDisabled={busy ? "Opening a project now." : base === "" ? "Pick a branch first." : null}
            testId="github-open-repo"
            onClick={() => {
              void openFromGitHub(picked.owner, picked.repo, base);
            }}
          >
            Open project
          </Button>
        </div>
      )}

      {error === null ? null : (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {project === null || project.source.kind !== "github" || repo === null ? null : (
        <div className={styles.stack}>
          <label className={styles.label} htmlFor="github-branch">
            Work branch
          </label>
          <Tooltip
            label="Work branch"
            hint={`Created from ${repo.base} the first time; the base branch is never written to. Empty goes back to auto/<auto>/${auth.login}.`}
          >
            <input
              id="github-branch"
              className={styles.search}
              data-testid="github-branch"
              defaultValue={repo.branch}
              onBlur={(event) => {
                // Only a change names a branch; tabbing through the field leaves it alone (issue #407).
                if (event.target.value !== repo.branch) setWorkBranch(event.target.value, fileName);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </Tooltip>
          <p className={styles.hint} data-testid="github-branch-base">
            Zenith never writes to {repo.base}.
          </p>
        </div>
      )}

      <div className={styles.stack}>
        <label className={styles.label} htmlFor="github-pr">
          Review a pull request
        </label>
        <div className={styles.row}>
          <input
            id="github-pr"
            className={styles.search}
            style={{ flex: "1 1 240px", width: "auto" }}
            placeholder="https://github.com/owner/repo/pull/12"
            data-testid="github-pr-url"
            value={prUrl}
            onChange={(event) => {
              setPrUrl(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void openReviewFromUrl(prUrl);
            }}
          />
          <Button
            whyDisabled={prUrl.trim() === "" ? "Paste the pull request's address first." : null}
            testId="github-review-open"
            onClick={() => {
              void openReviewFromUrl(prUrl);
            }}
          >
            Open review
          </Button>
        </div>
      </div>
    </>
  );
}
