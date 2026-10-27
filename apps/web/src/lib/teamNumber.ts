/**
 * The one reading of a typed FTC team number (issue #502): the Teams sheet's Create a team, the
 * Share sheet's team field and the admin's number check all use it, so a number is refused the same
 * way, with the same sentence, everywhere. A team number is a whole number from 1 to 999999, with
 * an optional leading `#`.
 */

/** The largest team number Zenith takes. FTC numbers are five digits today; six leaves room. */
export const TEAM_NUMBER_MAX = 999_999;

/** What every refusal of a team number ends with. */
export const TEAM_NUMBER_RANGE = `Use a whole number from 1 to ${String(TEAM_NUMBER_MAX)}.`;

export type TeamNumberReading = { ok: true; teamNumber: number } | { ok: false; why: string };

/** Reads `text` as a team number, or says in one sentence why it is not one. */
export function readTeamNumber(text: string): TeamNumberReading {
  const shown = text.trim();
  const digits = shown.replace(/^#/, "");
  if (digits === "") return { ok: false, why: "Type a team number." };
  const teamNumber = /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
  if (!Number.isSafeInteger(teamNumber) || teamNumber < 1 || teamNumber > TEAM_NUMBER_MAX) {
    return { ok: false, why: `"${shown}" is not a team number. ${TEAM_NUMBER_RANGE}` };
  }
  return { ok: true, teamNumber };
}
