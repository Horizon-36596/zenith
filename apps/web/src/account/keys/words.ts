/**
 * Every sentence the key screens show, in one place, so the wording can be read and changed without
 * opening a component. The screens are about end-to-end encryption: a team key that only the team's
 * devices hold, the recovery code on paper, and the codes people compare by eye.
 */
import { dayWords, teamLabel } from "../words";

/** The part of a team the key screens name: "36596 Horizon", or just the name. */
export interface TeamNaming {
  teamName: string;
  teamNumber?: number | null;
}

/** "36596 Horizon", or the name alone for a team without a number. */
export function teamWords({ teamName, teamNumber }: TeamNaming): string {
  return teamLabel({ name: teamName, number: teamNumber ?? null });
}

/** "12345 Partner team", or "Team 12345" when the team's name cannot be read. */
export function numberedTeamWords(teamName: string | null, teamNumber: number): string {
  return teamName === null ? `Team ${String(teamNumber)}` : teamWords({ teamName, teamNumber });
}

/**
 * "Thu 4 Mar 2027": the date a recovery code was made, as the screen and the printed page show it.
 * The app's one date format, always with the year, since the paper is kept.
 */
export function dateWords(at: Date): string {
  return dayWords(at, at.getTime(), { year: "always" });
}

/** What the reason of a rejected promise says, or a plain fallback when it says nothing useful. */
export function messageOf(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.trim() !== "") return reason.message;
  if (typeof reason === "string" && reason.trim() !== "") return reason;
  return fallback;
}

/** Shown while a button's work is under way. */
export const WORKING = "Working…";

export const RECOVERY_SHEET = {
  title: "Your team's recovery code",
  titleReplacing: "Your team's new recovery code",
  lead: (team: string) => `Keep this code safe for ${team}.`,
  what:
    "It is the only way back into the team library if every device that holds the team key is lost. " +
    "Horizon cannot recover it for you, so without it the library is gone.",
  where: "Print it and keep it offline, with your coach or in the team binder.",
  replacing: "The old code no longer works.",
  madeOn: (date: string) => `Made on ${date}`,
  print: "Print",
  printTooltip: "Print the code",
  printHint: "Prints the team, the code and the date, and nothing else.",
  printed: "Check that the page printed before you continue.",
  saved: "I have saved this code somewhere safe",
  savedHint: "Tick this if you wrote the code down instead of printing it.",
  continue: "Continue",
  continueHint: "The code is not shown again.",
  whyNotYet: "Print the code, or tick that you have saved it.",
  cancel: "Cancel",
  cancelHint: "Keep the current code.",
  printInstruction:
    "Keep this Zenith recovery code offline. It is the only way back into the team library if every device with the team key is lost.",
} as const;

/** A recovery code has 26 characters after its ZNTH prefix. */
export const RECOVERY_CODE_CHARACTERS = 26;

export const RECOVERY_ENTRY = {
  title: (team: string) => `Use the recovery code for ${team}`,
  how: "Type the code from the printed sheet.",
  inputLabel: "Recovery code",
  inputHint: "Capitals, spaces, dashes and the ZNTH prefix do not matter.",
  count: (typed: number) => `${String(typed)} of ${String(RECOVERY_CODE_CHARACTERS)} characters`,
  submit: "Use code",
  submitTooltip: "Use the recovery code",
  submitHint: "Unlocks the team library on this device. The activity log records it.",
  checking: "Checking the code…",
  empty: "Type the recovery code.",
  failed: "That code did not work. Check it against the printed sheet.",
  cancel: "Cancel",
  cancelHint: "Go back without using a code.",
} as const;

export const APPROVE = {
  titleMember: (who: string) => `Approve ${who}`,
  titleDevice: (who: string) => `Approve ${who}'s new device`,
  titleOwnDevice: "Approve your new device",
  device: (label: string) => `Device: ${label}`,
  ask: (who: string) => `Ask ${who} to read out the code on their screen, and type it here.`,
  askOwn: "Type the approval code your new device shows.",
  why: "The code proves the team key goes to that device, not to one someone slipped in.",
  inputLabel: "Approval code",
  inputHint: "Capitals, spaces and dashes do not matter.",
  count: (typed: number, of: number) => `${String(typed)} of ${String(of)} characters`,
  tooLong: "That is more characters than the code has.",
  notYet: (of: number) => `Type all ${String(of)} characters of the code first.`,
  wrongCode: "That code does not match the waiting device. Check it with them and type it again.",
  failed: "The approval did not go through. Try again in a moment.",
  approve: "Approve",
  approveMember: (who: string) => `Let ${who} in and give their device the team key.`,
  approveDevice: "Give this device the team key.",
  decline: "Decline",
  declineHint: "This device does not get the team key.",
} as const;

export const WAITING = {
  title: "Waiting for a teammate to unlock the team library on this device",
  readOut: "Read this code to whoever approves you.",
  caption: "This device's approval code",
  whoMember: (team: string) => `An owner or admin of ${team} approves you.`,
  whoDevice: "One of your own devices, or an owner or admin of the team, approves this one.",
  whoDeviceAnyMember: "One of your own devices, or any member of the team, approves this one.",
  meanwhile: "Meanwhile, autos on this computer and links other teams share still work.",
  useRecovery: "Use recovery code",
  useRecoveryHint: "Unlocks this device with the team's printed recovery code.",
  notWaiting:
    "This request is gone: it was declined, or the team key changed first. Ask again and read the code out once more.",
  notSaved: "This browser can't save keys; approval will be needed each time.",
  askAgain: "Ask again",
  askAgainHint: "Asks for the team key again.",
} as const;

export const DEVICE_REQUESTS = {
  heading: "Devices waiting for the key",
  yours: "Your new device",
  theirs: (who: string) => `${who}'s new device`,
  asked: (ago: string) => `asked ${ago}`,
  approve: "Approve",
  approveTooltip: (title: string) => `Approve ${title}`,
  approveHint: "Asks for the code the device shows.",
} as const;

export const SHARED_COMPUTER = {
  legend: "Whose device is this?",
  own: "This is my own device",
  ownDetail: "Keys stay on this device, so it needs approval only once.",
  ownHint: "Choose this on a laptop or computer that only you use.",
  shared: "This is a shared computer",
  sharedDetail: "Keys are kept only until you close the app, and you will need approval each time.",
  sharedHint: "No offline copy of your team's autos is kept here either. Sign out when you are done.",
  desktop: "On the team's own laptops, use the desktop app and choose your own device.",
} as const;

export const KEY_CHANGED = {
  title: (team: string) => `${team}'s key changed`,
  what:
    "This team's key is not the one this device saw before, and they did not make a new one. " +
    "Someone may be trying to read what you send.",
  compare: "Ask them to read out their team safety code. Send only if it matches this one.",
  caption: (team: string) => `${team}'s safety code`,
  dontSend: "Don't send",
  dontSendHint: "Nothing is sent to this team.",
  continue: "Continue",
  continueTooltip: "Trust the new key and send",
  continueHint: "Only if the safety codes match.",
} as const;

export const NUMBER_CHANGED = {
  title: (number: string) => `Team ${number} is now a different team`,
  what: "This number now leads to a different team from the one this device shared with before. That should not happen.",
  risk: "It can mean someone is trying to read what you send.",
  compare: "Before you send, call the team you mean and ask them to read out their team safety code. Send only if it matches the new code.",
  before: (team: string) => `${team}'s safety code before`,
  beforeGone: "The team this device shared with before can no longer be read, so its safety code cannot be shown.",
  now: (team: string) => `${team}'s safety code now`,
  dontSend: "Don't send",
  dontSendHint: "Send nothing to this team now.",
  continue: "Continue",
  continueTooltip: "Share with the team this number leads to now",
  continueHint: "Only if the team you mean read out the new code.",
} as const;

export const FIRST_SHARE = {
  title: (team: string) => `Check ${team}'s safety code`,
  /** One sentence: the first share is when a made-up key would get through, so this is the check. */
  compare: "Compare this code with that team, by phone or in person, before you share.",
  howTo: "How to check",
  howToHint: "The first time this device shares with a team, it shows that team's code once. The docs say how to compare it.",
  caption: (team: string) => `${team}'s safety code`,
  dontSend: "Don't send",
  dontSendHint: "Send nothing to this team now.",
  share: "Share",
  shareTooltip: "Share with this team",
  shareHint: "This device remembers the team, and asks again only if its key or number changes.",
} as const;

export const SAFETY_CODE = {
  heading: "Team safety code",
  when: "Compare it once with each partner team, in person or on a call, to check you are sharing with the real team.",
  changes: "It changes when your key changes.",
  caption: "Your team's safety code",
} as const;

export const ROTATION = {
  anyone: "A member left. Make a new team key so they cannot open new versions.",
  named: (who: string) => `${who} left. Make a new team key so they cannot open new versions.`,
  rotate: "Make a new key",
  rotateTooltip: "Make a new team key",
  rotateHint: "Every device still on the team gets the new key.",
  rotating: "Making the new key…",
} as const;

/**
 * The team page's privacy section (spec 14 section 0, spec 13 sections 4.3 and 8.1): what the
 * encryption means in two sentences, then who may do what, by role and by kind of share.
 */
export const PRIVACY = {
  heading: "Privacy and access",
  what: "Autos are encrypted on your devices before upload, so Horizon and Google cannot read them.",
  who: "Only devices your team approves hold the key.",
  rolesCaption: "Who can do what",
  owner: "All an admin can, plus delete the team, make owners and replace the recovery code.",
  admin: "Invite, approve and remove members, change roles, approve any device, make or revoke any share.",
  /** An editor's row, which follows the team's two sharing settings. */
  editor: (propose: boolean, link: boolean) =>
    `Publish, send proposals, and share with other teams to view${propose ? " or propose" : ""}${link ? ", or by link" : ""}.`,
  viewer: "Open the library and shares sent to the team.",
  pending: "Nothing until an owner or admin approves them.",
  sharingCaption: "What a share gives",
  view: "View",
  viewGives: "The teams you pick see where and when your robot drives.",
  propose: "Propose changes",
  proposeGives: "They also see the shape of your steps, and can send changes for you to accept.",
  link: "Anyone with the link",
  linkGives: "What View shows, to anyone with the link, without signing in.",
  ends: "No share includes your code, notes or robot settings. Each ends on a date you pick.",
} as const;

/** The team page's devices, and the codes kept one click away under them. */
export const DEVICES = {
  heading: "Devices with the team key",
  why:
    "A new device gets the key only when a device that has it approves it, by typing the code the new device shows. " +
    "The code proves it is the same device.",
  /** Who may approve, which follows the team's device setting. */
  approvers: (anyMember: boolean) =>
    anyMember ? "Any member can approve." : "The member's own devices and any owner or admin can approve.",
  codes: "Recovery code and team safety code",
  recoveryHeading: "Recovery code",
  recoveryWhy:
    "The only way back in if every device with the key is lost. Print it and keep it offline; Horizon cannot recover it.",
  recoveryWhen: "Replace it each season, and when someone who saw it leaves.",
} as const;

/**
 * A verification code as a screen reader should say it: each digit on its own, with a pause
 * between the groups, so "0417 2958 3361 7720 5164" is not read as five large numbers.
 */
export function spokenCode(code: string): string {
  return code
    .trim()
    .split(/[\s-]+/)
    .map((group) => group.split("").join(" "))
    .join(", ");
}

