/**
 * The team page's privacy section, for someone who has never heard of end-to-end encryption: what
 * it means for the team in two sentences, then who may do what, as one table by role (spec 13
 * section 4.3) and one by kind of share (spec 13 section 8.1). The editor's row follows the team's
 * two sharing settings, so the table says what this team allows, not only the defaults.
 */
import type { Role } from "@horizon36596/zenith-cloud";
import { ROLE_WORDS } from "../permissions";
import { PRIVACY } from "./words";
import account from "../account.module.css";
import styles from "./keys.module.css";

export interface TeamPrivacyProps {
  /** The team's sharing setting that lets editors share at the propose level. Off by default. */
  editorsMayProposeShare: boolean;
  /** The team's sharing setting that lets editors make anyone-with-the-link shares. Off by default. */
  editorsMayLinkShare: boolean;
}

const ROLES: readonly Role[] = ["owner", "admin", "editor", "viewer", "pending"];

export function TeamPrivacy({ editorsMayProposeShare, editorsMayLinkShare }: TeamPrivacyProps) {
  const can: Record<Role, string> = {
    owner: PRIVACY.owner,
    admin: PRIVACY.admin,
    editor: PRIVACY.editor(editorsMayProposeShare, editorsMayLinkShare),
    viewer: PRIVACY.viewer,
    pending: PRIVACY.pending,
  };
  const shares = [
    { level: PRIVACY.view, gives: PRIVACY.viewGives },
    { level: PRIVACY.propose, gives: PRIVACY.proposeGives },
    { level: PRIVACY.link, gives: PRIVACY.linkGives },
  ];
  return (
    <section className={account.section} data-testid="team-privacy">
      <h3 className={account.sectionHead}>{PRIVACY.heading}</h3>
      <p className={account.prose}>
        {PRIVACY.what} {PRIVACY.who}
      </p>
      <table className={styles.table} data-testid="team-privacy-roles">
        <caption className={styles.tableCaption}>{PRIVACY.rolesCaption}</caption>
        <tbody>
          {ROLES.map((role) => (
            <tr key={role} data-testid={`team-privacy-role-${role}`}>
              <th scope="row">{ROLE_WORDS[role]}</th>
              <td>{can[role]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className={styles.table} data-testid="team-privacy-shares">
        <caption className={styles.tableCaption}>{PRIVACY.sharingCaption}</caption>
        <tbody>
          {shares.map((share) => (
            <tr key={share.level}>
              <th scope="row">{share.level}</th>
              <td>{share.gives}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={account.hint}>{PRIVACY.ends}</p>
    </section>
  );
}
