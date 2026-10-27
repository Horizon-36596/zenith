/**
 * The key errors the cloud client throws (spec 14), as plain sentences. The client's own messages
 * are written for the person who reads its code; these are for the person at the screen, and say
 * what happened and what to do, with no key names in them. Anything else is left to the caller.
 *
 * Only the error's name and code are read, so this needs nothing from the cloud package at run time.
 */

export const KEY_ERRORS = {
  noKey:
    "This device does not have the team key yet, so the team library cannot open here. A teammate approves this device, or use the team's recovery code.",
  tampered:
    "What the cloud sent for this team did not pass its check, so Zenith did not open it and nothing was changed. Try again later, and tell a Horizon admin if it keeps happening.",
  keyChanged:
    "A team's key is not the one this device saw before. Compare its safety code with that team before you send them anything.",
  wrongCode: "That code does not match the waiting device. Check it with them and type it again.",
  cannotRotate:
    "This device cannot make the team's new key yet: it needs to be one an owner or admin had when the key last changed, or one approved by such a device. Make the new key from another owner's or admin's device, or use the team's recovery code on this one.",
} as const;

/** The `CloudError` code of `error`, found by shape, or null. */
export function cloudErrorCode(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== "CloudError") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** True when `error` is the cloud's "wrong-code": the typed approval code is not that device's. */
export function isWrongCode(error: unknown): boolean {
  return cloudErrorCode(error) === "wrong-code";
}

/**
 * The sentence for a key error, or null for any other failure. A key-changed error keeps the
 * client's own sentence when it has one, because that names the safety code to compare.
 */
export function keyErrorSentence(error: unknown): string | null {
  // A device the newest key's device list gives no say in the next key: the client's error class.
  if (error instanceof Error && error.name === "CannotRotateError") return KEY_ERRORS.cannotRotate;
  switch (cloudErrorCode(error)) {
    case "no-key":
      return KEY_ERRORS.noKey;
    case "tampered":
      return KEY_ERRORS.tampered;
    case "key-changed": {
      const own = error instanceof Error ? error.message.trim() : "";
      return /[.!?]$/.test(own) && own.includes("safety code") ? own : KEY_ERRORS.keyChanged;
    }
    case "wrong-code":
      return KEY_ERRORS.wrongCode;
    default:
      return null;
  }
}
