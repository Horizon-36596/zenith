/** The small labels the account sheets share: a team's number status and a member's role. */
import type { Role, TeamStatus } from "@horizon36596/zenith-cloud";
import { Tooltip } from "../components/Tooltip";
import { ROLE_DOES, ROLE_WORDS } from "./permissions";
import { STATUS_DOES, STATUS_WORDS } from "./words";
import styles from "./account.module.css";

/** "Unverified" wherever a team's name appears, until a Horizon admin checks it (section 4.2). */
export function StatusChip({ status, testId }: { status: TeamStatus; testId?: string }) {
  return (
    <Tooltip label={`Team number ${STATUS_WORDS[status].toLowerCase()}`} hint={STATUS_DOES[status]}>
      <span
        className={styles.chip}
        tabIndex={0}
        data-tone={status === "contested" ? "warn" : undefined}
        data-testid={testId}
      >
        {STATUS_WORDS[status]}
      </span>
    </Tooltip>
  );
}

export function RoleChip({ role, testId }: { role: Role; testId?: string }) {
  return (
    <Tooltip
      label={ROLE_WORDS[role]}
      hint={role === "pending" ? "An owner or admin approves this membership." : ROLE_DOES[role]}
    >
      <span
        className={styles.chip}
        tabIndex={0}
        data-tone={role === "pending" ? "accent" : undefined}
        data-testid={testId}
      >
        {ROLE_WORDS[role]}
      </span>
    </Tooltip>
  );
}
