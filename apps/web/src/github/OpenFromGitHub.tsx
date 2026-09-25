/**
 * The GitHub branch of the open-project dialog (site/docs/github.md
 * and apps/web/UI_GUIDE.md section 8.10): sign in, pick a repository you can push to, pick the
 * base branch, open. Without a token it lists nothing at all and says so — it never makes an
 * unauthenticated request on the chance that a repository is public.
 *
 * The base branch is the one thing the app never writes to; what a Save commits to is the work
 * branch, named here and shown in the toolbar chip.
 */
import { useEffect, useState } from "react";
import type { RepoSummary } from "@horizon36596/zenith-github";
import { Button } from "../components/primitives";
import { setDialog, useEditor } from "../state/store";
import { openFromGitHub, openReviewFromUrl, setWorkBranch } from "./actions";
import { currentClient } from "./session";
import styles from "./github.module.css";

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function GitHubTab() {
  const { auth, project, repo, fileName, busy } = useEditor();
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<RepoSummary | null>(null);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [base, setBase] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  const choose = (summary: RepoSummary): void => {
    const client = currentClient();
    setPicked(summary);
    setBase(summary.defaultBranch);
    setBranches(null);
    setError(null);
    client?.branches.list(summary.owner, summary.repo).then(
      (list) => {
        setBranches(list.map((branch) => branch.name));
      },
      (failure: unknown) => {
        setError(say(failure));
      },
    );
  };

  if (auth === null) {
    return (
      <>
        <p className={styles.prose}>
          Sign in with a fine-grained personal access token and Zenith will list the repositories
          that token can push to. Nothing is fetched until you do: with no token this tab shows no
          repositories, not even public ones.
        </p>
        <div className={styles.row}>
          <Button
            kind="primary"
            testId="github-open-signin"
            onClick={() => {
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
        Signed in as {auth.login}. Pick the robot repository and the branch to read from; Zenith
        reads <code className="mono">zenith.json</code> and the files it names, and commits your
        edits to a work branch beside it.
      </p>

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
            disabled={busy || base === ""}
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
          <input
            id="github-branch"
            className={styles.search}
            data-testid="github-branch"
            defaultValue={repo.branch}
            onBlur={(event) => {
              setWorkBranch(event.target.value, fileName);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <p className={styles.hint}>
            Every Save commits here. It is created from {repo.base} the first time, and {repo.base}{" "}
            itself is never written to. Clearing this field goes back to{" "}
            <code className="mono">auto/&lt;auto&gt;/{auth.login}</code>.
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
            disabled={prUrl.trim() === ""}
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
