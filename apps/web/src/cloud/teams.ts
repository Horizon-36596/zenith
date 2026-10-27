/**
 * Reading teams by id for the sharing screens, once each. Team ids are never used twice (deleting a
 * team leaves a tombstone under its id), so a team the cloud says does not exist was deleted, and the
 * screens say so in plain words instead of naming "another team". A read that fails, such as one made
 * offline, is neither: it is not kept, so the next read tries again.
 */
import type { CloudBackend, Team } from "@horizon36596/zenith-cloud";

/** A team, `"deleted"` when the cloud says it no longer exists, or null when it could not be read. */
export type TeamLookup = Team | "deleted" | null;

export interface TeamReader {
  read(teamId: string): Promise<TeamLookup>;
  /** Keeps a team read some other way, such as by its number. */
  remember(team: Team): void;
}

export function teamReader(backend: Pick<CloudBackend, "getTeam">): TeamReader {
  const known = new Map<string, Team | "deleted">();
  return {
    async read(teamId) {
      const kept = known.get(teamId);
      if (kept !== undefined) return kept;
      let team: Team | null;
      try {
        team = await backend.getTeam(teamId);
      } catch {
        return null;
      }
      const found = team ?? "deleted";
      known.set(teamId, found);
      return found;
    },
    remember(team) {
      known.set(team.id, team);
    },
  };
}

/** The team, or null when it was deleted or could not be read. */
export const teamOrNull = (lookup: TeamLookup): Team | null => (lookup === null || lookup === "deleted" ? null : lookup);
