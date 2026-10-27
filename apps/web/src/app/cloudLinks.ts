/**
 * The addresses only the cloud answers: a share link (`#/s/<id>`), an invite link (`#/join/<code>`)
 * and the Horizon admins' review page (`#/admin`). With the cloud on, the account session and the
 * admin route follow them. With the cloud off (`cloudEnabled`, account/config.ts), which is a build
 * from source without a cloud config since releases have the cloud on, nothing can, so the editor
 * says so in plain words, for a link someone was sent and for `#/admin` alike.
 *
 * Pure: no DOM and no clock, so every sentence is tested in `cloudLinks.test.ts`.
 */
import { isAdminHash } from "../admin/model";

export type CloudLinkKind = "share" | "join" | "admin";

/**
 * Which cloud address `hash` is, or null for any other. The share and invite prefixes are enough:
 * a link that lost a character on the way still gets the explanation rather than nothing.
 */
export function cloudLinkKind(hash: string): CloudLinkKind | null {
  const trimmed = hash.trim();
  if (trimmed.startsWith("#/s/")) return "share";
  if (trimmed.startsWith("#/join/")) return "join";
  if (isAdminHash(trimmed)) return "admin";
  return null;
}

export interface CloudOffNotice {
  title: string;
  /** The body, one paragraph per entry. */
  paragraphs: readonly string[];
}

/** What the editor says, with the cloud off, about the cloud address it was opened at. */
export function cloudOffNotice(kind: CloudLinkKind): CloudOffNotice {
  if (kind === "share") {
    return {
      title: "Sharing isn't available in this build",
      paragraphs: [
        "This is a link to an auto that another team shared through a Zenith account. This build of Zenith has no accounts, so the link cannot open here. Open it in the published web app or the desktop app.",
        "Ask the team for a share file instead. Load it in the Partners panel to see both robots on one field, with no account.",
      ],
    };
  }
  if (kind === "admin") {
    return {
      title: "The admin page isn't available in this build",
      paragraphs: [
        "This is the review page for Horizon admins. This build of Zenith has no accounts, so the page cannot open here.",
        "Everything else works without an account: plan, check, time and save autos on this computer.",
      ],
    };
  }
  return {
    title: "Teams aren't available in this build",
    paragraphs: [
      "This is an invite to join a team in Zenith. This build of Zenith has no accounts, so the invite cannot open here. Open it in the published web app or the desktop app.",
      "Everything else works without an account: plan, check, time and save autos on this computer.",
    ],
  };
}
