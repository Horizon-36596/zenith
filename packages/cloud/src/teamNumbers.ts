/**
 * The FTC team number a team's name reads as, on its own so that the web app can use it without the
 * Firebase SDK the package's main entry brings in.
 */

/** The largest FTC team number a team may hold, as `createTeam` checks it. */
const MAX_TEAM_NUMBER = 999_999;

/**
 * The FTC team number a team's name reads as, or null when it does not read as one. The server
 * writes a team's name, so a team with no number can be named "36596" or "Team 36596" and pass for
 * the team that holds 36596 wherever its name is shown. The name is read as a person would read it:
 * characters drawn like digits count as those digits, spaces and invisible characters are dropped,
 * and one leading "FTC", "Team" or "#" is ignored. Only a whole number from 1 to 999999 counts. The
 * name is taken as the server wrote it, so anything but a string reads as no number.
 */
export function numberInTeamName(name: unknown): number | null {
  if (typeof name !== "string") return null;
  const folded = name
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Z}\s]/gu, "")
    .toLowerCase();
  const match = /^(?:ftc)?(?:team)?#?(\d+)$/u.exec(folded);
  if (match === null) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number >= 1 && number <= MAX_TEAM_NUMBER ? number : null;
}
