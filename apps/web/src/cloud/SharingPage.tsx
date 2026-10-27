/**
 * The Sharing page (spec 13 section 8.4): every share and invite the team
 * has made, with the time left on each, a warning on anything that ends within two days, and
 * Extend, Change level, Follow latest and Revoke on every row. A non-modal sheet, like the share
 * dialog, so the editor stays usable beside it.
 */
import { useState } from "react";
import {
  CalendarPlus,
  Eye,
  MessageSquarePlus,
  Pin,
  RefreshCw,
  TriangleAlert,
  FileCheck2,
  Tags,
  Type,
  Upload,
} from "lucide-react";
import { expiresSoon, timeLeftWords } from "@horizon36596/zenith-core";
import { Button, RowButton } from "../components/primitives";
import { ConfirmRow } from "../components/ConfirmRow";
import { Tooltip } from "../components/Tooltip";
import { ROLE_WORDS, whyCannotInvite } from "../account/permissions";
import { useAccount } from "../account/store";
import { whenWords } from "../account/words";
import { KeyWaiting } from "../account/TeamKeys";
import { ExpiryPicker } from "../account/ExpiryPicker";
import {
  extendedExpiry,
  newerRevisionFor,
  shareActorOf,
  whyCannotChangeShare,
  whyCannotExtend,
  type ExtendChoice,
} from "./shareModel";
import { includesCommands, projectionTitle } from "./projectionModel";
import { Sheet, SheetButton } from "./controls";
import { STOPPED_SHARES, autoLabelOf, levelWords, modeWords, noInvitesWords, sentenceFor, shareIsOpen, whoWords } from "./words";
import { libraryAutoIdOf, useOpenAutoStatus } from "./openAuto";
import { useEditor } from "../state/store";
import { openProposalBlockedReason, pickProposalFile } from "../proposals/ownerActions";
import { ReceivedProposals, useRefreshProposals } from "./ReceivedProposals";
import { TimeRequests } from "./TimeRequests";
import { StoppedShares, type StoppedShareItem } from "./StoppedShares";
import { stoppedToList } from "./stoppedSharesModel";
import {
  closeSharingSheet,
  cloudNow,
  extendInvite,
  extendShare,
  openShareAgain,
  revokeInvite,
  revokeShare,
  setShareLevel,
  setShareMode,
  sharesOnPage,
  showAllShares,
  updateShareToRevision,
  useCloud,
} from "./store";
import type { Invite, Share, StoppedShare } from "./types";
import styles from "./cloud.module.css";

/** The row's second line: time left, and the expiry warning when it ends within two days. */
function TimeLeft({ expiresAt, nowMs, ended }: { expiresAt: string | null; nowMs: number; ended?: string }) {
  if (ended !== undefined) return <span className={styles.ended}>{ended}</span>;
  const soon = expiresSoon(expiresAt, nowMs);
  return (
    <>
      <span className={styles.mono}>{timeLeftWords(expiresAt, nowMs)}</span>
      {soon ? (
        <span className={styles.soon} data-testid="expiry-warning">
          <TriangleAlert size={12} strokeWidth={1.75} aria-hidden />
          Ends soon
        </span>
      ) : null}
    </>
  );
}

/**
 * The Extend choices, shown under a row when its Extend button is pressed: the same picker the
 * team's invites use, 1, 7 or 30 more days or a date and time, with Apply.
 */
function ExtendChoices({
  what,
  subject,
  current,
  nowMs,
  onPick,
  onCancel,
  testId,
}: {
  what: string;
  subject: "invite" | "share";
  current: string | null;
  nowMs: number;
  onPick: (choice: ExtendChoice) => void;
  onCancel: () => void;
  testId: string;
}) {
  const [choice, setChoice] = useState<ExtendChoice>({ kind: "days", days: 7 });
  const why = whyCannotExtend(current, choice, nowMs);
  const currentMs = current === null ? undefined : Date.parse(current);
  return (
    <div className={styles.itemFollowUp} role="group" aria-label={`Extend ${what}`} data-testid={testId}>
      <ExpiryPicker
        value={choice}
        onChange={setChoice}
        testId={`${testId}-by`}
        verb="extends"
        subject={subject}
        {...(currentMs === undefined ? {} : { startMs: currentMs })}
      />
      {why === null || choice.kind === "days" ? null : (
        <p className={styles.error} data-testid={`${testId}-why`}>
          {why}
        </p>
      )}
      <SheetButton
        tooltip={`Extend ${what}`}
        hint="Give it the new end now. Extending never shortens it."
        whyDisabled={why}
        onClick={() => {
          onPick(choice);
        }}
        testId={`${testId}-apply`}
      >
        Apply
      </SheetButton>
      <SheetButton kind="text" tooltip="Keep the end date as it is" onClick={onCancel} testId={`${testId}-cancel`}>
        Cancel
      </SheetButton>
    </div>
  );
}

/** Revoke's second step, in the row, with what revoking does and does not do. */
function ConfirmRevoke({
  sentence,
  onRevoke,
  onKeep,
  testId,
}: {
  sentence: string;
  onRevoke: () => void;
  onKeep: () => void;
  testId: string;
}) {
  return <ConfirmRow testId={testId} sentence={sentence} verb="Revoke" verbHint="This cannot be undone." onConfirm={onRevoke} onCancel={onKeep} />;
}

type Open = { id: string; what: "extend" | "revoke" } | null;

function ShareRow({ share, nowMs, open, setOpen }: { share: Share; nowMs: number; open: Open; setOpen: (open: Open) => void }) {
  const cloud = useCloud();
  const accountState = useAccount();
  const library = accountState.library;
  const editor = useEditor();
  const openAutoId = libraryAutoIdOf(useOpenAutoStatus());
  const revoked = share.revokedAt !== null;
  const teamDeleted = !revoked && share.everyTeamDeleted === true;
  const active = shareIsOpen(share, nowMs);
  const testId = `share-row-${share.id}`;
  const busy = cloud.busy ? "Another change is being sent." : null;
  const gone = revoked ? "This share was revoked." : teamDeleted ? "The team it was shared with was deleted." : null;
  const isLink = share.audience === "link";
  const who = whoWords(share);
  const ended = revoked ? "Revoked" : teamDeleted ? "Ended: team deleted" : active ? undefined : "Ended";
  const namesCommands = includesCommands(share.projection);
  const keptTitle = projectionTitle(share.projection);
  const newer = newerRevisionFor(share, library.revisions[share.autoId] ?? [], nowMs);
  // What the rules let this member change (spec 13 section 4.3), so a button the rules would
  // refuse is disabled and says why instead.
  const actor = shareActorOf(accountState);
  const mayNot = whyCannotChangeShare(actor, share);
  const toggledLevel = share.level === "propose" ? "view" : "propose";
  const mayNotLevel = whyCannotChangeShare(actor, share, { level: toggledLevel });

  return (
    <li className={styles.item} data-testid={testId} data-state={revoked ? "revoked" : teamDeleted ? "team-deleted" : active ? "active" : "ended"}>
      <div className={styles.itemMain}>
        <Tooltip label={who} hint={sentenceFor(share, nowMs)}>
          <span className={styles.itemWho} tabIndex={0} data-testid={`${testId}-who`}>
            {who}
          </span>
        </Tooltip>
        <span className={styles.itemAuto}>
          {autoLabelOf(share.autoId, library.autos)}
          <span className={styles.mono} data-testid={`${testId}-revision`}>
            {` · revision ${String(share.revision)}`}
          </span>
        </span>
        <span className={styles.itemMeta}>
          <span data-testid={`${testId}-level`}>{levelWords(share)}</span>
          <span aria-hidden>·</span>
          <span data-testid={`${testId}-mode`}>{modeWords(share)}</span>
          <span aria-hidden>·</span>
          <TimeLeft expiresAt={share.expiresAt} nowMs={nowMs} ended={ended} />
          <span aria-hidden>·</span>
          {/* Two links to one auto read the same otherwise, so the time it was made tells them apart. */}
          <span data-testid={`${testId}-made`}>made {whenWords(new Date(share.createdAt))}</span>
          {namesCommands ? (
            <Tooltip label="Commands included" hint={`${who} sees what each command is called and its settings, not your code.`}>
              <span className={styles.flag} tabIndex={0} data-testid={`${testId}-commands`}>
                <Tags size={12} strokeWidth={1.75} aria-hidden />
                Commands included
              </span>
            </Tooltip>
          ) : null}
          {keptTitle === null ? null : (
            <Tooltip label="Name included" hint={`${who} sees this auto named “${keptTitle}”.`}>
              <span className={styles.flag} tabIndex={0} data-testid={`${testId}-title`}>
                <Type size={12} strokeWidth={1.75} aria-hidden />
                Name included
              </span>
            </Tooltip>
          )}
          {newer === null ? null : (
            <span className={styles.flag} data-testid={`${testId}-newer`}>
              A newer version is not shared
            </span>
          )}
        </span>
      </div>
      <div className={styles.itemActions}>
        <RowButton
          icon={CalendarPlus}
          label="Extend"
          hint={`Give ${who} more time.`}
          disabled={gone !== null || busy !== null || share.expiresAt === null || mayNot !== null}
          whyDisabled={gone ?? busy ?? mayNot ?? "This share has no end date."}
          onClick={() => {
            setOpen(open?.id === share.id && open.what === "extend" ? null : { id: share.id, what: "extend" });
          }}
          testId={`${testId}-extend`}
        />
        <RowButton
          icon={share.level === "propose" ? Eye : MessageSquarePlus}
          label={share.level === "propose" ? "Change to view only" : "Allow proposing changes"}
          hint={
            share.level === "propose"
              ? `${who} will only be able to view it.`
              : `${who} will also see the shape of your steps and can send changes for you to review.`
          }
          disabled={gone !== null || busy !== null || isLink || mayNotLevel !== null}
          whyDisabled={gone ?? busy ?? (isLink ? "A link is view only." : (mayNotLevel ?? ""))}
          onClick={() => {
            const level = toggledLevel;
            void setShareLevel(
              share.id,
              level,
              level === "view" ? `${who} can now only view it.` : `${who} can now propose changes.`,
            );
          }}
          testId={`${testId}-level-toggle`}
        />
        {share.level === "propose" ? (
          <RowButton
            icon={FileCheck2}
            label="Open a proposal for this share"
            hint={`Review a proposal file ${who} sent against this share, change by change. A revoked or ended share takes none, and says so.`}
            disabled={openProposalBlockedReason(editor) !== null || openAutoId !== share.autoId}
            whyDisabled={openProposalBlockedReason(editor) ?? `Open ${autoLabelOf(share.autoId, library.autos)} first: the proposal is reviewed against it.`}
            onClick={() => {
              pickProposalFile({
                shareRef: { shareId: share.id, revision: share.revision },
                share: revoked ? "revoked" : active ? "live" : "expired",
              });
            }}
            testId={`${testId}-open-proposal`}
          />
        ) : null}
        <RowButton
          icon={share.mode === "follow" ? Pin : RefreshCw}
          label={share.mode === "follow" ? "Pin to the shared version" : "Follow the latest version"}
          hint={
            share.mode === "follow"
              ? "Stop updating what they see when you publish."
              : "Update what they see each time you publish this auto."
          }
          disabled={gone !== null || busy !== null || mayNot !== null}
          whyDisabled={gone ?? busy ?? mayNot ?? ""}
          onClick={() => {
            const mode = share.mode === "follow" ? "pinned" : "follow";
            void setShareMode(
              share.id,
              mode,
              mode === "follow" ? `${who} now follows the latest version.` : `${who} now sees the shared version only.`,
            );
          }}
          testId={`${testId}-mode-toggle`}
        />
        {newer === null ? null : (
          <RowButton
            icon={Upload}
            label="Update share"
            hint={`Send revision ${String(newer.n)} to ${who}, with the same level${namesCommands ? ", command names" : ""}${keptTitle === null ? "" : ", the auto's name"} and rounding. The share stays pinned to it.`}
            disabled={busy !== null || mayNot !== null}
            whyDisabled={busy ?? mayNot ?? ""}
            onClick={() => {
              const files = {
                content: newer.content,
                ...(newer.robot === undefined ? {} : { robot: newer.robot }),
                ...(newer.field === undefined ? {} : { field: newer.field }),
                ...(newer.waypoints === undefined ? {} : { waypoints: newer.waypoints }),
              };
              void updateShareToRevision(share.id, { id: newer.id, n: newer.n, files }, `${who} now sees revision ${String(newer.n)}.`);
            }}
            testId={`${testId}-update`}
          />
        )}
        {/* Revoke cannot be undone, so it is named in words and set apart from the icons beside it. */}
        <span className={styles.itemEnd}>
          <Button
            kind="ghost"
            tooltip="Revoke"
            hint={`Stop ${who} from opening it. Asks first.`}
            whyDisabled={gone ?? busy ?? mayNot}
            onClick={() => {
              setOpen(open?.id === share.id && open.what === "revoke" ? null : { id: share.id, what: "revoke" });
            }}
            testId={`${testId}-revoke`}
          >
            Revoke
          </Button>
        </span>
      </div>
      <ReceivedProposals share={share} nowMs={nowMs} />
      <TimeRequests share={share} nowMs={nowMs} />
      {open?.id === share.id && open.what === "extend" ? (
        <ExtendChoices
          what="this share"
          subject="share"
          current={share.expiresAt}
          nowMs={nowMs}
          testId={`${testId}-extend-choices`}
          onCancel={() => {
            setOpen(null);
          }}
          onPick={(choice) => {
            setOpen(null);
            const next = extendedExpiry(share.expiresAt, choice, nowMs);
            if (next !== null) void extendShare(share.id, next, `Extended the share with ${who}.`);
          }}
        />
      ) : null}
      {open?.id === share.id && open.what === "revoke" ? (
        <ConfirmRevoke
          testId={`${testId}-confirm`}
          sentence={`Revoke the share with ${who}? It stops working at once for anyone who has not opened it; a copy already opened stays on that device until its next sync.`}
          onKeep={() => {
            setOpen(null);
          }}
          onRevoke={() => {
            setOpen(null);
            void revokeShare(share.id, `Revoked the share with ${who}.`);
          }}
        />
      ) : null}
    </li>
  );
}

function InviteRow({ invite, nowMs, open, setOpen }: { invite: Invite; nowMs: number; open: Open; setOpen: (open: Open) => void }) {
  const cloud = useCloud();
  const testId = `invite-row-${invite.code}`;
  const busy = cloud.busy ? "Another change is being sent." : null;
  // Only owners and admins extend or revoke an invite; the page lists none for anyone else.
  const role = shareActorOf(useAccount()).role;
  const gone = invite.revoked ? "This invite was revoked." : whyCannotInvite(role);
  const used = invite.uses >= invite.maxUses;
  // A used-up invite lets nobody else in, so more time would do nothing; a new invite would.
  const noMoreTime = gone ?? (used ? "Every use of this invite is taken, so more time would not help. Make a new invite instead." : null);
  const ended = invite.revoked ? "Revoked" : Date.parse(invite.expiresAt) <= nowMs ? "Ended" : undefined;
  const what = `the invite ${invite.code}`;

  return (
    <li className={styles.item} data-testid={testId}>
      <div className={styles.itemMain}>
        <span className={styles.itemWho} data-testid={`${testId}-kind`}>
          {ROLE_WORDS[invite.role]} invite
        </span>
        <span className={styles.itemMeta}>
          <span className={styles.mono} data-testid={`${testId}-code`}>
            {invite.code}
          </span>
          <span aria-hidden>·</span>
          <span className={styles.mono}>
            {invite.uses} of {invite.maxUses} used
          </span>
          <span aria-hidden>·</span>
          <span>{invite.autoApprove ? "Joins at once" : "An admin approves each one"}</span>
          <span aria-hidden>·</span>
          <TimeLeft expiresAt={invite.expiresAt} nowMs={nowMs} ended={ended ?? (used ? "All uses taken" : undefined)} />
        </span>
      </div>
      <div className={styles.itemActions}>
        <RowButton
          icon={CalendarPlus}
          label="Extend"
          hint="Give this invite more time."
          disabled={noMoreTime !== null || busy !== null}
          whyDisabled={noMoreTime ?? busy ?? ""}
          onClick={() => {
            setOpen(open?.id === invite.code && open.what === "extend" ? null : { id: invite.code, what: "extend" });
          }}
          testId={`${testId}-extend`}
        />
        <span className={styles.itemEnd}>
          <Button
            kind="ghost"
            tooltip="Revoke"
            hint="Stop anyone else joining with this invite. Nobody who already joined is removed. Asks first."
            whyDisabled={gone ?? busy}
            onClick={() => {
              setOpen(open?.id === invite.code && open.what === "revoke" ? null : { id: invite.code, what: "revoke" });
            }}
            testId={`${testId}-revoke`}
          >
            Revoke
          </Button>
        </span>
      </div>
      {open?.id === invite.code && open.what === "extend" && noMoreTime === null ? (
        <ExtendChoices
          what="this invite"
          subject="invite"
          current={invite.expiresAt}
          nowMs={nowMs}
          testId={`${testId}-extend-choices`}
          onCancel={() => {
            setOpen(null);
          }}
          onPick={(choice) => {
            setOpen(null);
            const next = extendedExpiry(invite.expiresAt, choice, nowMs);
            if (next !== null) void extendInvite(invite.code, next, `Extended ${what}.`);
          }}
        />
      ) : null}
      {open?.id === invite.code && open.what === "revoke" ? (
        <ConfirmRevoke
          testId={`${testId}-confirm`}
          sentence={`Revoke ${what}? Nobody else can join with it. Nobody who already joined is removed.`}
          onKeep={() => {
            setOpen(null);
          }}
          onRevoke={() => {
            setOpen(null);
            void revokeInvite(invite.code, `Revoked ${what}.`);
          }}
        />
      ) : null}
    </li>
  );
}

/**
 * Why "Share again" cannot open the share dialog for `share` now, or null: a share is made from the
 * open auto, as the team library holds it, so that auto must be open and published.
 */
function whyCannotShareAgain(share: StoppedShare, openAuto: ReturnType<typeof useOpenAutoStatus>, autoLabel: string, busy: boolean): string | null {
  if (busy) return "Another change is being sent.";
  if (libraryAutoIdOf(openAuto) !== share.autoId) return STOPPED_SHARES.openFirst(autoLabel);
  return null;
}

export function SharingPage() {
  const cloud = useCloud();
  const [open, setOpen] = useState<Open>(null);
  const nowMs = cloudNow();
  const openAuto = useOpenAutoStatus();
  useRefreshProposals();

  const accountState = useAccount();
  const library = accountState.library;
  const mayManageInvites = whyCannotInvite(shareActorOf(accountState).role) === null;
  const team = cloud.session.teamNumber === null ? "your team" : `team ${String(cloud.session.teamNumber)}`;
  const filter = cloud.sharingAutoId;
  const filterName = filter === null ? null : autoLabelOf(filter, library.autos);
  const byNewest = sharesOnPage(cloud.shares, filter).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const current = byNewest.filter((share) => shareIsOpen(share, nowMs));
  const past = byNewest.filter((share) => !shareIsOpen(share, nowMs));
  const stopped: StoppedShareItem[] = stoppedToList(cloud.stopped, cloud.shares, cloud.sharedAgain, nowMs, filter).map((share) => {
    const autoLabel = autoLabelOf(share.autoId, library.autos);
    return { share, autoLabel, whyNot: whyCannotShareAgain(share, openAuto, autoLabel, cloud.busy) };
  });

  return (
    <Sheet title="Sharing" help="sharing" testId="sharing-page" widthPx={520} onClose={closeSharingSheet}>
      <KeyWaiting />
      {filterName === null ? null : (
        <p className={`${styles.row} ${styles.prose}`} data-testid="sharing-filter">
          <span>
            Showing shares of <span data-testid="sharing-filter-auto">{filterName}</span>
          </span>
          <span aria-hidden>·</span>
          <SheetButton
            kind="text"
            tooltip="Show all"
            hint={`List every share and invite ${team} has made, not only those of ${filterName}.`}
            onClick={showAllShares}
            testId="sharing-filter-show-all"
          >
            Show all
          </SheetButton>
        </p>
      )}
      {cloud.error === null ? null : (
        <p className={styles.error} role="alert">
          {cloud.error}
        </p>
      )}

      <StoppedShares items={stopped} nowMs={nowMs} onShareAgain={openShareAgain} />

      <section className={styles.section} aria-label="Shares">
        <h3 className={styles.sectionHead}>Shares</h3>
        {current.length === 0 ? (
          <p className={styles.hint} data-testid="sharing-no-shares">
            {filterName === null
              ? "Nothing is shared outside the team."
              : `${filterName} is not shared outside the team.`}
          </p>
        ) : (
          <ul className={styles.list} data-testid="sharing-shares">
            {current.map((share) => (
              <ShareRow key={share.id} share={share} nowMs={nowMs} open={open} setOpen={setOpen} />
            ))}
          </ul>
        )}
      </section>

      {past.length === 0 ? null : (
        <section className={styles.section} aria-label="Ended and revoked">
          <h3 className={styles.sectionHead}>Ended and revoked</h3>
          <ul className={styles.list} data-testid="sharing-past">
            {past.map((share) => (
              <ShareRow key={share.id} share={share} nowMs={nowMs} open={open} setOpen={setOpen} />
            ))}
          </ul>
        </section>
      )}

      {filter !== null ? null : (
        <section className={styles.section} aria-label="Invites">
          <h3 className={styles.sectionHead}>Invites</h3>
          {cloud.invites.length === 0 ? (
            <p className={styles.hint} data-testid="sharing-no-invites">
              {noInvitesWords(mayManageInvites)}
            </p>
          ) : (
            <ul className={styles.list} data-testid="sharing-invites">
              {cloud.invites.map((invite) => (
                <InviteRow key={invite.code} invite={invite} nowMs={nowMs} open={open} setOpen={setOpen} />
              ))}
            </ul>
          )}
        </section>
      )}
    </Sheet>
  );
}
