/**
 * The step a sharer sees the first time this device shares with a team: that team's safety code,
 * one plain sentence asking to compare it with the team, and a link to how. The first key a device sees for a team
 * is trusted as it is, so this is where a person can catch a key the server made up. It asks for one
 * click, not a typed confirmation, and this device remembers that the person saw it.
 *
 * It goes inline in the share flow, where the send would happen.
 */
import { ShieldCheck } from "lucide-react";
import { SheetButton } from "../../cloud/controls";
import { Tooltip } from "../../components/Tooltip";
import { docsLink } from "../config";
import { VerificationCode } from "./VerificationCode";
import { FIRST_SHARE, WORKING, teamWords } from "./words";
import account from "../account.module.css";
import styles from "./keys.module.css";

/** The docs on comparing safety codes. */
const SAFETY_CODE_DOC = docsLink("teams-and-sharing/#keys-and-your-team");

export interface FirstShareSafetyCodeProps {
  /** The team being shared with for the first time. */
  teamName: string;
  teamNumber?: number | null;
  /** That team's safety code: five groups of four digits split by spaces. */
  safetyCode: string;
  /** Share with this team. */
  onShare: () => void;
  /** Send nothing to this team. */
  onDontSend: () => void;
  /** True while the send is under way. */
  busy?: boolean;
  testId?: string;
}

export function FirstShareSafetyCode({
  teamName,
  teamNumber,
  safetyCode,
  onShare,
  onDontSend,
  busy = false,
  testId = "first-share-code",
}: FirstShareSafetyCodeProps) {
  const team = teamWords({ teamName, teamNumber });
  const howLink = (
    <Tooltip label={FIRST_SHARE.howTo} hint={FIRST_SHARE.howToHint}>
      <a className={account.textLink} href={SAFETY_CODE_DOC} target="_blank" rel="noreferrer" data-testid={`${testId}-how`}>
        {FIRST_SHARE.howTo}
      </a>
    </Tooltip>
  );
  return (
    <section className={styles.check} aria-label={FIRST_SHARE.title(team)} data-testid={testId}>
      <h3 className={styles.warningTitle}>
        <ShieldCheck className={styles.checkIcon} size={16} strokeWidth={1.75} aria-hidden />
        {FIRST_SHARE.title(team)}
      </h3>
      <p className={account.prose}>
        {FIRST_SHARE.compare} {howLink}
      </p>
      <VerificationCode code={safetyCode} caption={FIRST_SHARE.caption(team)} testId={`${testId}-code`} />
      <div className={account.row}>
        <SheetButton
          tooltip={FIRST_SHARE.dontSend}
          hint={FIRST_SHARE.dontSendHint}
          testId={`${testId}-dont-send`}
          onClick={onDontSend}
        >
          {FIRST_SHARE.dontSend}
        </SheetButton>
        <SheetButton
          kind="primary"
          tooltip={FIRST_SHARE.shareTooltip}
          hint={FIRST_SHARE.shareHint}
          whyDisabled={busy ? WORKING : null}
          testId={`${testId}-share`}
          onClick={onShare}
        >
          {FIRST_SHARE.share}
        </SheetButton>
      </div>
    </section>
  );
}
