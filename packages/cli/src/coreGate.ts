import { NotImplementedError } from "@horizon36596/zenith-core";

/**
 * `core.estimate`, `core.ledger`, `core.render` and `core.diff` throw `NotImplementedError` until
 * M1 lands. Every verb that calls one of them runs the call through
 * here so the CLI prints a clear message and exits 2 (usage/IO, since the file itself is fine; the
 * tool just cannot finish the job yet) instead of a stack trace.
 */
export const CORE_NOT_LANDED_EXIT_CODE = 2;

export function coreNotLandedMessage(error: NotImplementedError): string {
  return `core M1 not landed yet: ${error.message}`;
}

export type CoreResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** Calls `fn`; catches only `NotImplementedError` and turns it into a `CoreResult`. */
export function tryCore<T>(fn: () => T): CoreResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    if (error instanceof NotImplementedError) return { ok: false, message: coreNotLandedMessage(error) };
    throw error;
  }
}
