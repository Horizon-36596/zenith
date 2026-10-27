/**
 * The in-app expiry warning (spec 13 section 8.4), over the bottom right of the window like the
 * import notice: the team's live shares and invites that end within two days, each with Extend,
 * which opens the Sharing page, and a × that dismisses that line on this device. It is non-modal
 * and out of the layout (UI_GUIDE layout rule 8), and stays until each line is dismissed or
 * extended. It steps aside while a sharing or account sheet is open, since the Sharing page marks
 * the same items itself, and while the import notice, which holds the same place, is showing.
 *
 * `expiryNoticeModel.ts` decides what is listed.
 */
import { CalendarClock, X } from "lucide-react";
import { useAccount } from "../account/store";
import { isAdminRole } from "../account/permissions";
import { RowButton } from "../components/primitives";
import { useImportNotice } from "../state/importNotice";
import { SheetButton } from "./controls";
import { expiringItems, expiryDismissals, useExpiryDismissals } from "./expiryNoticeModel";
import { shareActorOf, whyCannotChangeShare } from "./shareModel";
import { cloudNow, openSharingSheet, useCloud } from "./store";
import type { Invite } from "./types";
import { autoLabelOf, whoWords } from "./words";
import styles from "./ExpiryNotice.module.css";

/** "A share ends soon", "2 invites end soon", "A share and 2 invites end soon". */
function headingOf(shares: number, invites: number): string {
  const shareWords = shares === 0 ? null : shares === 1 ? "A share" : `${String(shares)} shares`;
  const inviteWords = invites === 0 ? null : invites === 1 ? "an invite" : `${String(invites)} invites`;
  const what = [shareWords, inviteWords].filter((words): words is string => words !== null).join(" and ");
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} ${shares + invites === 1 ? "ends" : "end"} soon`;
}

export function ExpiryNotice() {
  const cloud = useCloud();
  const accountState = useAccount();
  const dismissed = useExpiryDismissals();
  const importNotice = useImportNotice();
  if (!cloud.session.signedIn || cloud.sheet !== null || accountState.panel !== null || importNotice !== null) return null;

  const nowMs = cloudNow();
  const actor = shareActorOf(accountState);
  // The Teams sheet keeps the account's copy of the invites current as they are made and
  // extended; the sharing store's copy is read when the session starts and after its own changes.
  const invites = new Map<string, Invite>(cloud.invites.map((invite) => [invite.code, invite]));
  for (const invite of accountState.team?.teamId === cloud.session.teamId ? (accountState.team?.invites ?? []) : []) {
    invites.set(invite.code, {
      code: invite.code,
      role: invite.role,
      expiresAt: invite.expiresAt.toISOString(),
      maxUses: invite.maxUses,
      uses: invite.uses,
      autoApprove: invite.autoApprove,
      revoked: invite.revoked,
    });
  }
  const items = expiringItems({
    shares: cloud.shares,
    invites: [...invites.values()],
    nowMs,
    mayChange: (share) => whyCannotChangeShare(actor, share) === null,
    mayExtendInvites: isAdminRole(actor.role),
    shareLabel: (share) => `${autoLabelOf(share.autoId, accountState.library.autos)}, shared with ${whoWords(share)}`,
    dismissed,
  });
  if (items.length === 0) return null;
  const heading = headingOf(items.filter((item) => item.kind === "share").length, items.filter((item) => item.kind === "invite").length);

  return (
    <section className={styles.notice} role="status" aria-label={heading} data-testid="expiry-notice">
      <div className={styles.head}>
        <CalendarClock className={styles.icon} size={16} strokeWidth={1.75} aria-hidden />
        <p className={styles.title}>
          {heading}
        </p>
        <RowButton
          icon={X}
          label={items.length === 1 ? "Dismiss" : "Dismiss all"}
          hint="Hide this warning on this computer. A share or invite that is extended and nears its new end is warned about again."
          testId="expiry-notice-dismiss-all"
          onClick={() => {
            expiryDismissals.dismiss(items.map((item) => item.key));
          }}
        />
      </div>
      <ul className={styles.list} data-testid="expiry-notice-list">
        {items.map((item) => (
          <li key={item.key} className={styles.line} data-testid={`expiry-notice-${item.kind}-${item.id}`}>
            <span className={styles.words}>{item.words}</span>
            <SheetButton
              kind="text"
              tooltip="Extend"
              hint={
                item.kind === "share"
                  ? "Open the Sharing page on this auto's shares, where Extend gives it more time."
                  : "Open the Sharing page, where Extend gives the invite more time."
              }
              onClick={() => {
                openSharingSheet("sharing", { autoId: item.autoId });
              }}
              testId={`expiry-notice-${item.kind}-${item.id}-extend`}
            >
              Extend
            </SheetButton>
            {items.length === 1 ? null : (
              <RowButton
                icon={X}
                label="Dismiss"
                hint="Hide this warning on this computer."
                testId={`expiry-notice-${item.kind}-${item.id}-dismiss`}
                onClick={() => {
                  expiryDismissals.dismiss([item.key]);
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
