/**
 * The git commit each saved auto file came from, as far as this page knows it (spec 13 section 5.1:
 * a revision records "the commit it came from" when the project is a git repository). Two places
 * know one:
 *
 * - GitHub mode, whose every save is a commit (`SaveResult.commitSha`);
 * - the desktop app, whose Commit returns the new commit's id (`DesktopCommitResult.sha`).
 *
 * A commit is remembered with the exact canonical text it holds, and Publish passes it only while
 * the file it publishes is still that text, so a revision never names a commit it did not come
 * from. A local folder in the browser, the example and picked files know no commit, and publish
 * without one. Nothing here is saved: it lasts as long as the page.
 */

interface Known {
  canonical: string;
  sha: string;
}

const known = new Map<string, Known>();

/** A git commit id as the cloud stores it: 7 to 40 lowercase hexadecimal characters. */
const SHA = /^[0-9a-f]{7,40}$/;

/** Remembers that `fileName`, with exactly this canonical text, is in commit `sha`. */
export function rememberCommit(fileName: string, canonical: string, sha: string): void {
  const lower = sha.trim().toLowerCase();
  if (!SHA.test(lower)) return;
  known.set(fileName, { canonical, sha: lower });
}

/** The commit `fileName` came from, while its text is still `canonical`; otherwise null. */
export function commitFor(fileName: string, canonical: string): string | null {
  const entry = known.get(fileName);
  return entry !== undefined && entry.canonical === canonical ? entry.sha : null;
}

/** Forgets every commit: for tests, and when another project opens. */
export function forgetCommits(): void {
  known.clear();
}
