/**
 * The sharing UI's words for a share, in one place, so the chip, the dialog and the Sharing page
 * describe a share the same way. The sentence itself comes from core (`shareSentence`), from the
 * stored share's own fields.
 */
import { isShareActive, shareSentence } from "@horizon36596/zenith-core";
import type { State } from "../state/store";
import { includesCommands, projectionTitle } from "./projectionModel";
import { utcOffsetAt } from "./shareModel";
import type { TeamStatus } from "@horizon36596/zenith-cloud";
import { numberInTeamName } from "@horizon36596/zenith-cloud/sharing";
import { withTeamStatus } from "../account/words";
import type { FromTeamCheck, Share, StoppedShare } from "./types";

/** The open auto as the sharing UI names it: its title, else its file name. */
export function autoNameOf(state: Pick<State, "fileName" | "auto">): string {
  const title = state.auto?.title?.trim();
  if (title !== undefined && title !== "") return title;
  return state.fileName ?? "this auto";
}

/**
 * How the Sharing page names the auto a share was made from: its title in the team library, which
 * is the file name it was published from.
 */
export function autoLabelOf(autoId: string, libraryAutos: ReadonlyArray<{ id: string; title: string }>): string {
  return libraryAutos.find((auto) => auto.id === autoId)?.title ?? "An auto no longer in the team library";
}

/** The sharing team of a received share, as the words below read it. */
type FromTeam = {
  fromTeamNumber: number | null;
  fromTeamName: string | null;
  fromTeamStatus?: TeamStatus | null;
  fromTeamCheck?: FromTeamCheck;
};

/**
 * Who a received share is from: "Team 12345 (unverified)", "A team with no number that calls
 * itself “Horizon”" for a team with no number, or "Shared link" when the viewer cannot read the
 * team, as for a link opened with nobody signed in. A team named by its number carries the number's
 * status (spec 13 section 4.2), so a number nobody has checked, or one two teams claim, never reads
 * as settled. A team that is not the one this device knows under its number is "A team claiming to
 * be 12345", with no status: the server that wrote the claim wrote the status too.
 */
export function fromTeamWords(share: FromTeam): string {
  if (share.fromTeamNumber !== null && share.fromTeamCheck?.kind === "mismatch") return claimingNumberWords(share.fromTeamNumber);
  if (share.fromTeamNumber !== null) return withTeamStatus(`Team ${String(share.fromTeamNumber)}`, share.fromTeamStatus);
  if (share.fromTeamName !== null) return noNumberTeamWords(share.fromTeamName);
  return "Shared link";
}

/**
 * A team that says it holds `teamNumber` but is not the team this device knows under it: "A team
 * claiming to be 12345", with no status, since the server that wrote the claim wrote the status too.
 */
export function claimingNumberWords(teamNumber: number): string {
  return `A team claiming to be ${String(teamNumber)}`;
}

/**
 * A team with no FTC number, by the name the server gave it, in quotes as the team's own claim: "A
 * team with no number that calls itself “Spare Parts”". It never reads as "Team 36596", and never
 * carries a number status, since there is no number to check. Quote marks in the name become ' and
 * invisible characters are dropped, so the name cannot close the quotes early or reorder the words.
 */
export function noNumberTeamWords(name: string): string {
  const shown = name
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/["\u201c\u201d\u201e\u201f\u00ab\u00bb\u301d\u301e\uff02]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
  return `A team with no number that calls itself “${shown}”`;
}

/**
 * A team's words as they read inside a sentence: "a team with no number that calls itself …" and
 * "a team claiming to be 12345" start lower case there, while "Team 12345" keeps its capital.
 */
export function teamInSentence(words: string): string {
  return words.startsWith("A ") ? `a ${words.slice(2)}` : words;
}

/** "shared by Team 12345 (unverified)", or "shared by its link" when the team is not known here. */
export function sharedByWords(share: FromTeam): string {
  if (share.fromTeamNumber === null && share.fromTeamName === null) return "shared by its link";
  return `shared by ${teamInSentence(fromTeamWords(share))}`;
}

/**
 * The line the Partners panel shows under a received share about who it is from, or null for none:
 * a warning when the sharing team is not the team this device knows under the number it claims, on
 * a first share from a number that team's safety code to compare, and for a team with no number its
 * safety code every time, since nothing else says who it is. When the team replaced its key since this
 * device first met it, the line says the code changed and asks for the new one to be compared.
 */
export function fromTeamCheckWords(share: FromTeam): string | null {
  const check = share.fromTeamCheck;
  if (check === undefined || check.kind === "known") return null;
  if (check.kind === "no-number") {
    if (check.safetyCode === null) return "This team has no number, and its safety code cannot be read now.";
    if (check.keyReplaced === true) return `This team has no number. Its safety code changed, because they replaced their team key. Compare the new code with them before you trust this share: ${check.safetyCode}.`;
    return `This team has no number. Compare its safety code with them: ${check.safetyCode}.`;
  }
  if (check.kind === "mismatch") {
    if (share.fromTeamNumber === null) {
      const claimed = numberInTeamName(share.fromTeamName);
      const number = claimed === null ? "a number" : String(claimed);
      return `It has no number and calls itself ${number}, but it is not the team you know as ${number}. Proposals to it are not sent.`;
    }
    const number = String(share.fromTeamNumber);
    return `Claims to be from team ${number}, but it is not the team you know as ${number}. Proposals to it are not sent.`;
  }
  if (share.fromTeamNumber === null) return null;
  const number = String(share.fromTeamNumber);
  if (check.safetyCode === null) return `First share from team ${number} on this device. Its safety code cannot be read now.`;
  if (check.keyReplaced === true) {
    return `Team ${number}'s safety code changed, because they replaced their team key. Compare the new code with them before you trust this share: ${check.safetyCode}.`;
  }
  return `First share from team ${number} on this device. Compare its safety code with them: ${check.safetyCode}.`;
}

/**
 * The dialog's sentence for a stored share, in the viewer's time zone. Whether it names its
 * commands and whether it keeps the auto's name are read from its projection, so the sentence says
 * what the other team gets now.
 */
export function sentenceFor(share: Share, nowMs: number): string {
  if (share.everyTeamDeleted === true) return EVERY_TEAM_DELETED;
  return shareSentence(
    {
      ...share,
      includeCommands: includesCommands(share.projection),
      includeTitle: projectionTitle(share.projection) !== null,
    },
    nowMs,
    { utcOffsetMinutes: utcOffsetAt(share.expiresAt, nowMs) },
  );
}

/** The share dialog's lead while no team is chosen yet, for an auto that already has a live share. */
export const ADD_ANOTHER_TEAM = "Add a team number to share this auto with another team.";

/**
 * The share dialog's lead sentence for the draft. With no team chosen yet, the sentence says nobody
 * outside the team can see the auto, which is wrong for an auto that already has a live share
 * (`existing`), so that auto gets only the line asking for a team number.
 */
export function draftLeadWords(settings: { audience: string; teamNumbers: readonly unknown[] }, existing: number, sentence: string): string {
  return existing > 0 && settings.audience === "teams" && settings.teamNumbers.length === 0 ? ADD_ANOTHER_TEAM : sentence;
}

/**
 * What the Sharing page says under Invites when it lists none. Only owners and admins can read a
 * team's invites (cloud/README.md, the rules for `invites`), so an editor or a viewer is told that,
 * rather than that there are none.
 */
export function noInvitesWords(mayManageInvites: boolean): string {
  return mayManageInvites
    ? "No invites."
    : "Only owners and admins see the invites.";
}

/** What a share to teams that were all deleted says, in place of its sentence. */
export const EVERY_TEAM_DELETED =
  "The team it was shared with was deleted, so nobody outside your team can open it. It stays listed as ended.";

/**
 * "Team 12345 (unverified)", "Teams 12345 (verified), 23456 (number contested)", "Anyone with the
 * link": each team with its number status when the cloud gave one (spec 13 section 4.2). A team
 * that was deleted since is named as one: "A deleted team", or "Team 12345 and a deleted team".
 */
export function whoWords(share: Pick<Share, "audience" | "teamNumbers" | "teamStatuses" | "deletedTeams">): string {
  if (share.audience === "link") return "Anyone with the link";
  const teams = share.teamNumbers.map((number) => withTeamStatus(String(number), share.teamStatuses?.[number]));
  const deleted = share.deletedTeams ?? 0;
  const gone = deleted === 1 ? "a deleted team" : `${String(deleted)} deleted teams`;
  if (teams.length === 0) return deleted === 0 ? "No team" : gone.charAt(0).toUpperCase() + gone.slice(1);
  const named = `${teams.length === 1 ? "Team" : "Teams"} ${teams.join(", ")}`;
  return deleted === 0 ? named : `${named} and ${gone}`;
}

/** Whether a share can still be opened by someone outside its team: live, and not only to deleted teams. */
export const shareIsOpen = (share: Share, nowMs: number): boolean =>
  isShareActive(share, nowMs) && share.everyTeamDeleted !== true;

export const levelWords = (share: Pick<Share, "audience" | "level">): string =>
  share.audience === "teams" && share.level === "propose" ? "View and propose" : "View only";

export const modeWords = (share: Pick<Share, "mode">): string =>
  share.mode === "follow" ? "Follows the latest version" : "Pinned to the shared version";

/**
 * The words of the stopped-shares notice on the Sharing page and of "Share again" in the share
 * dialog. A stopped share is one the team made that stopped when its key changed (`StoppedShare`).
 */
/**
 * The words for a share made to the team that waits for its team to sign it again with its newer
 * key (`WaitingShare`). Nothing of the share is opened, so they say only who it is from and why.
 */
export const WAITING_SHARES = {
  from: (from: string) => `Waiting for ${from.charAt(0).toLowerCase()}${from.slice(1)} to update a share`,
  why: "Their team key changed, so this share stays closed until their app signs it again. If it stays here, ask them to update it.",
};

export const STOPPED_SHARES = {
  heading: "Stopped shares",
  lead: "These shares stopped when your team key changed. They get nothing new.",
  reason: {
    "device-removed": "Made or last changed on a device that was removed",
    "not-listed": "Not seen by the device that changed the key",
  },
  ends: (date: string) => `would end ${date}`,
  shareAgain: "Share again",
  shareAgainTooltip: "Share it again",
  shareAgainHint: "Opens the share dialog with the same teams, level, version and end. Check them, then share.",
  openFirst: (auto: string) => `Open ${auto} first: a share is made from the open auto.`,
  dialog: "This shares a stopped share again. Check who it goes to before you share.",
} as const;

/** "Team 12345", "Anyone with the link", "Team 12345 and 1 team with no number", for a stopped share. */
export function stoppedWhoWords(share: Pick<StoppedShare, "audience" | "teamNumbers" | "unnamedTeams">): string {
  const unnamed = share.unnamedTeams ?? 0;
  if (share.audience === "link" || unnamed === 0) return whoWords(share);
  const others = `${String(unnamed)} ${unnamed === 1 ? "team" : "teams"} with no number`;
  return share.teamNumbers.length === 0 ? others.charAt(0).toUpperCase() + others.slice(1) : `${whoWords(share)} and ${others}`;
}
