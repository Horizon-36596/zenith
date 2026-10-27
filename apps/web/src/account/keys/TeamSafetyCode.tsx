/**
 * The team's safety code, for the team page: a code two teams compare, in person or on a call, to
 * check that each sees the other's real team key. It comes from the team's public key, so it changes
 * when the team makes a new key.
 */
import { Tooltip } from "../../components/Tooltip";
import { VerificationCode } from "./VerificationCode";
import { SAFETY_CODE } from "./words";
import account from "../account.module.css";

export interface TeamSafetyCodeProps {
  /** The team's safety code: five groups of four digits split by spaces. */
  code: string;
}

export function TeamSafetyCode({ code }: TeamSafetyCodeProps) {
  return (
    <section className={account.section} data-testid="team-safety-code">
      <Tooltip label={SAFETY_CODE.heading} hint={`${SAFETY_CODE.when} ${SAFETY_CODE.changes}`} delay="long">
        <h3 className={account.sectionHead}>{SAFETY_CODE.heading}</h3>
      </Tooltip>
      <VerificationCode code={code} caption={SAFETY_CODE.caption} testId="team-safety-code-code" />

    </section>
  );
}
