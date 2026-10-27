/**
 * "Open this repository in GitHub mode" for a folder project that is a clone of a GitHub repository
 * (issue #213). The desktop app reads the folder's `origin` remote and the branch the Commit panel
 * treats as the base, so the open-project dialog can offer the same repository on GitHub with the
 * owner, the name and the base already filled in. In a browser there is no `origin` to read, so
 * there is no offer.
 */
import { useEffect, useState } from "react";
import { desktopBridge } from "../project/desktop";
import type { DesktopGitHubOrigin } from "../project/desktopBridge";
import { useEditor } from "../state/store";

/** The clone's GitHub repository, or null when it is not one or this build cannot tell. Never throws. */
export async function readCloneOrigin(root: string): Promise<DesktopGitHubOrigin | null> {
  const githubOrigin = desktopBridge()?.project.githubOrigin;
  if (githubOrigin === undefined) return null;
  try {
    return await githubOrigin(root);
  } catch {
    return null;
  }
}

/** The open folder project's GitHub repository, read again whenever another folder opens. */
export function useCloneOrigin(): DesktopGitHubOrigin | null {
  const { project } = useEditor();
  const root = project?.source.kind === "desktop" ? project.source.root : null;
  const [origin, setOrigin] = useState<DesktopGitHubOrigin | null>(null);
  useEffect(() => {
    setOrigin(null);
    if (root === null) return;
    let live = true;
    void readCloneOrigin(root).then((found) => {
      if (live) setOrigin(found);
    });
    return () => {
      live = false;
    };
  }, [root]);
  return origin;
}

/** `owner/repo`, the way GitHub and the repository list write it. */
export const originName = (origin: DesktopGitHubOrigin): string => `${origin.owner}/${origin.repo}`;

/**
 * Whether the open-project dialog should come back on its GitHub tab: set when that tab sends the
 * person to sign in, so "Open a repository" after signing in returns them where they were.
 */
let returnToGitHub = false;

export function markReturnToGitHub(): void {
  returnToGitHub = true;
}

/** Read without clearing, so React may call a state initializer twice; `clearReturnToGitHub` after. */
export const returnsToGitHub = (): boolean => returnToGitHub;

export function clearReturnToGitHub(): void {
  returnToGitHub = false;
}
