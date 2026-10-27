/**
 * What the person answered in the share dialog about the teams of one send: changed keys they
 * trusted, numbers now leading to another team that they chose to share with, and first shares whose
 * safety code they saw. Each answer is about the key whose code the warning showed, and carries it
 * (`shown`), so the dialog asks again when a later check finds another key, and the share is wrapped
 * to that key or not made at all.
 */
import type { CreateShareOptions, PartnerKeyWarning, ShownKey } from "./types";

export interface KeyAnswers {
  keys: number[];
  numbers: number[];
  seen: number[];
  /** For each number answered, the team and key the answer was about. */
  shown: Partial<Record<number, ShownKey>>;
}

export const NO_ANSWERS: KeyAnswers = { keys: [], numbers: [], seen: [], shown: {} };

/** True when the person already answered this warning, about the same team and key. */
export function answered(answers: KeyAnswers, warning: PartnerKeyWarning): boolean {
  const list = warning.kind === "key-changed" ? answers.keys : warning.kind === "number-changed" ? answers.numbers : answers.seen;
  const shown = answers.shown[warning.teamNumber];
  return list.includes(warning.teamNumber) && shown?.teamId === warning.teamId && shown.keyId === warning.keyId;
}

/** The answers with this warning's answer added: the person chose to send after reading it. */
export function withAnswer(answers: KeyAnswers, warning: PartnerKeyWarning): KeyAnswers {
  const number = warning.teamNumber;
  const shown = { ...answers.shown, [number]: { teamId: warning.teamId, keyId: warning.keyId } };
  const add = (list: number[]): number[] => (list.includes(number) ? list : [...list, number]);
  if (warning.kind === "key-changed") return { ...answers, keys: add(answers.keys), shown };
  if (warning.kind === "number-changed") return { ...answers, numbers: add(answers.numbers), shown };
  return { ...answers, seen: add(answers.seen), shown };
}

/** What `createShare` is told about the answers, leaving out the empty lists. */
export function answerOptions(answers: KeyAnswers): CreateShareOptions {
  return {
    ...(answers.keys.length === 0 ? {} : { acceptKeyChanges: [...answers.keys] }),
    ...(answers.numbers.length === 0 ? {} : { acceptNumberChanges: [...answers.numbers] }),
    ...(answers.seen.length === 0 ? {} : { safetyCodesSeen: [...answers.seen] }),
    ...(Object.keys(answers.shown).length === 0 ? {} : { shownKeys: { ...answers.shown } }),
  };
}

/**
 * The cloud adapter's refusal of a share to a number whose safety code this device never showed:
 * neither answered in this send nor recorded as seen for that team before. The share dialog checks
 * the numbers again when it meets it, which shows the code of the team each number leads to now.
 */
export class SafetyCodeNotShownError extends Error {
  /** The numbers whose code was not shown. */
  readonly teamNumbers: readonly number[];

  constructor(message: string, teamNumbers: readonly number[]) {
    super(message);
    this.name = "SafetyCodeNotShownError";
    this.teamNumbers = [...teamNumbers];
  }
}

/** True when `error`, or an error it was caused by, is a `SafetyCodeNotShownError`. */
export function needsSafetyCodeShown(error: unknown): boolean {
  let at: unknown = error;
  for (let depth = 0; depth < 8 && at instanceof Error; depth += 1) {
    if (at instanceof SafetyCodeNotShownError) return true;
    at = at.cause;
  }
  return false;
}
