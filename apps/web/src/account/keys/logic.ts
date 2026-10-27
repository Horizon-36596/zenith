/**
 * The small decisions the key screens make, kept apart from the components so they can be tested
 * without a browser: when Continue may act on the recovery code sheet, how much of a typed recovery
 * code there is, whose approval a waiting device needs, and how a device request is titled.
 */
import { DEVICE_REQUESTS, RECOVERY_CODE_CHARACTERS, RECOVERY_SHEET, WAITING } from "./words";

/**
 * Why Continue cannot act yet on the recovery code sheet, or null when it can. The owner must either
 * press Print or tick that the code was saved; either one is enough.
 */
export function whyCannotContinue(printed: boolean, saved: boolean): string | null {
  return printed || saved ? null : RECOVERY_SHEET.whyNotYet;
}

/**
 * How many of a recovery code's 26 characters have been typed. It reads the text the way the parser
 * does (capitals, spaces and dashes do not matter, and the ZNTH prefix may be left off), but only to
 * count: whether the code is right is for the parser to say.
 */
export function recoveryCharactersTyped(text: string): number {
  const chars = text.toUpperCase().replace(/[\s\-‐-―]/g, "");
  const withoutPrefix = chars.startsWith("ZNTH") && chars.length !== RECOVERY_CODE_CHARACTERS ? chars.slice(4) : chars;
  return withoutPrefix.length;
}

/** What a device waits for: a new member's first device, or another device of an existing member. */
export type WaitingKind = "member" | "device";

/**
 * Who can approve a waiting device. A new member is approved by an owner or admin. A member's new
 * device is approved by one of their own devices or by an owner or admin, or by any member when the
 * team's "any active member may approve devices" setting is on.
 */
export function whoCanApprove(kind: WaitingKind, team: string, membersMayApprove: boolean): string {
  if (kind === "member") return WAITING.whoMember(team);
  return membersMayApprove ? WAITING.whoDeviceAnyMember : WAITING.whoDevice;
}

/** One device that asked for the team key. */
export interface DeviceRequest {
  deviceId: string;
  /** The display name of the member the device belongs to. */
  who: string;
  /** The device's own label, such as "Chrome on Windows", when it is known. */
  deviceLabel: string | null;
  /** The device's verification code: five groups of four digits split by spaces. */
  code: string;
  /** When the device asked. */
  requestedAt: Date;
  /** True when the device belongs to the viewer, so the row says "Your new device". */
  isYours: boolean;
}

/** The title a request's row shows: "Your new device" or "Ada's new device". */
export function requestTitle(request: Pick<DeviceRequest, "who" | "isYours">): string {
  return request.isYours ? DEVICE_REQUESTS.yours : DEVICE_REQUESTS.theirs(request.who);
}
