import type { Auto } from "@horizon36596/zenith-schema";
import { parseAuto } from "@horizon36596/zenith-schema";
import type { GitHubClient } from "./client.js";
import type { GitHubProject } from "./project.js";
import type { PullRequest } from "./types.js";

export interface ReviewData {
  /** `null` when the changed auto file was added by this PR and so has no base version. */
  base: Auto | null;
  head: Auto;
  /** Every path this PR changes, not only the auto file, so the app can flag unexpected files. */
  files: string[];
  prMeta: PullRequest;
}

function resolvePrNumber(input: string | number, owner: string, repo: string): number {
  if (typeof input === "number") return input;
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(trimmed);
  if (!match) {
    throw new Error(`"${input}" is not a pull request number or a github.com pull request URL.`);
  }
  const [, urlOwner = "", urlRepo = "", number = ""] = match;
  if (urlOwner.toLowerCase() !== owner.toLowerCase() || urlRepo.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(`"${input}" is a pull request in ${urlOwner}/${urlRepo}, not ${owner}/${repo}.`);
  }
  return Number(number);
}

/**
 * Review mode's data load (06 §4): resolves the PR, finds the changed `*.auto.json` file, and
 * fetches its text from both sides so the app can call `core.diff(base, head)` and draw both
 * routines. `06` describes one author per work branch, so this expects exactly one changed auto
 * file; more or fewer is reported as an error rather than guessed at.
 */
export async function loadReview(
  client: GitHubClient,
  project: GitHubProject,
  prUrlOrNumber: string | number,
): Promise<ReviewData> {
  const number = resolvePrNumber(prUrlOrNumber, project.owner, project.repo);
  const prMeta = await client.pulls.get(project.owner, project.repo, number);
  const changedFiles = await client.pulls.files(project.owner, project.repo, number);
  const autoFiles = changedFiles.filter((file) => file.filename.endsWith(".auto.json"));

  if (autoFiles.length === 0) {
    throw new Error(`Pull request #${number} does not change any *.auto.json file.`);
  }
  if (autoFiles.length > 1) {
    throw new Error(
      `Pull request #${number} changes ${autoFiles.length} *.auto.json files; loadReview expects exactly one ` +
        "(06 §6: one author, one auto, per work branch).",
    );
  }

  const file = autoFiles[0]!;
  const headText = (await client.contents.get(project.owner, project.repo, file.filename, prMeta.head.sha)).text;
  const head = parseAuto(JSON.parse(headText));

  let base: Auto | null = null;
  if (file.status !== "added") {
    const baseText = (await client.contents.get(project.owner, project.repo, file.filename, prMeta.base.sha)).text;
    base = parseAuto(JSON.parse(baseText));
  }

  return { base, head, files: changedFiles.map((changed) => changed.filename), prMeta };
}

/** 1-based line number of the step with `stepId` in canonical `text`, or `null` if it is not there. */
export function lineAnchor(text: string, stepId: string): number | null {
  const needle = `"id": ${JSON.stringify(stepId)}`;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.includes(needle)) return index + 1;
  }
  return null;
}

/**
 * Sha256 hex of the file path, the way GitHub itself computes the `#diff-<hash>` id in a PR's
 * diff view. Uses Web Crypto (`crypto.subtle`), global in Node 18+ and every evergreen browser.
 */
export async function diffFileHash(path: string): Promise<string> {
  const bytes = new TextEncoder().encode(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `#diff-<hash>R<line>` (or `L<line>` for the base side), or `null` when the step has no line. */
export async function diffAnchor(
  path: string,
  text: string,
  stepId: string,
  side: "base" | "head" = "head",
): Promise<string | null> {
  const line = lineAnchor(text, stepId);
  if (line === null) return null;
  const hash = await diffFileHash(path);
  return `#diff-${hash}${side === "head" ? "R" : "L"}${line}`;
}
