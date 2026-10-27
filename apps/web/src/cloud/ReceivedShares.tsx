/**
 * The shares other teams have made to this team (spec 13 section 9, "Add to alliance view"), listed
 * in the Partners panel, one line each: who it is from, what it lets the team do and the time left,
 * with a Load button that puts it in the alliance view beside the open auto, or opens it alone with
 * none open. Details shows whether it follows the sharer's latest version and when it last changed,
 * Keep for offline (section 6) and Request more time.
 * The server writes who a share is from, so a share from a team that is not the one this device
 * knows under the number it claims says so, and a first share from a number shows that team's
 * safety code to compare, with a caution when the team replaced its key since this device met it. A
 * team with no number is named as having none, with its name in quotes as its own claim, and its
 * safety code shows every time.
 *
 * Each share made to the team offers Request more time (section 8.4), and the shares it can no
 * longer open are listed under them, where it may still ask for more time on one that ended. A
 * share signed with an older key of its team than this device has seen is listed as waiting for
 * that team to sign it again, by who it is from alone, since nothing else of it is opened.
 *
 * Below them, the link shares opened on this computer, to open again, offline too once kept. That
 * list shows signed out as well, since a link share needs no account; otherwise, signed out, this
 * section shows nothing. With the cloud off it shows nothing at all, kept links included: nothing
 * could open them, and the editor shows nothing of the cloud (`cloudEnabled`).
 */
import { useEffect, useId, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { timeLeftWords } from "@horizon36596/zenith-core";
import { Tooltip } from "../components/Tooltip";
import { cloudEnabled } from "../account/config";
import { timeAgo } from "../account/words";
import { SheetButton } from "./controls";
import { refreshProposals } from "./proposalsStore";
import { openedLinksToList, type KeptShare } from "./keptShares";
import { keepForOffline, refreshKept, reopenKept, useKeptShares, whyCannotKeep, keptShares } from "./keptSharesStore";
import { receivedEndingWords } from "./expiryNoticeModel";
import { loadReceivedShare } from "./received";
import { cloudNow, refreshReceived, useCloud } from "./store";
import { EndedShares, RequestMoreTime } from "./TimeRequests";
import { refreshTimeRequests } from "./timeRequestsStore";
import type { ReceivedShare, WaitingShare } from "./types";
import { WAITING_SHARES, fromTeamCheckWords, fromTeamWords } from "./words";
import styles from "./cloud.module.css";

/** "Follows their latest version, updated 2 hours ago" or "Stays on version 3". */
function versionWords(share: ReceivedShare, nowMs: number): string {
  if (share.mode === "follow") {
    return `Follows their latest version, updated ${timeAgo(new Date(share.updatedAt), nowMs)}`;
  }
  return `Stays on version ${String(share.revision)}`;
}

/**
 * One share made to the team, as one line: who it is from, what it lets the team do, the time left,
 * and Load. A team that is not the one this device knows under its number, a safety code to compare
 * (a first share, a team with no number, or a code that changed), and an ending share always show;
 * the version, Keep for offline and Request more time sit under Details, which starts open for a
 * share that is ending.
 */
export function ReceivedRow({ share, nowMs }: { share: ReceivedShare; nowMs: number }) {
  const ending = receivedEndingWords(share, nowMs);
  const [details, setDetails] = useState(ending !== null);
  const from = fromTeamWords(share);
  const check = fromTeamCheckWords(share);
  const fromCheck = share.fromTeamCheck;
  const mismatch = fromCheck?.kind === "mismatch";
  const keyChanged = fromCheck !== undefined && (fromCheck.kind === "first-use" || fromCheck.kind === "no-number") && fromCheck.keyReplaced === true;
  const firstCheck = check !== null && !mismatch && !keyChanged;
  return (
    <li className={styles.item} data-testid={`received-${share.id}`}>
      <div className={styles.itemMain}>
        <span className={styles.itemLine}>
          <span className={styles.itemWho} data-testid={`received-${share.id}-from`}>
            {from}
          </span>
          <span className={styles.itemMeta}>
            <span aria-hidden>·</span>
            <span>{share.level === "propose" ? "View and propose" : "View only"}</span>
            <span aria-hidden>·</span>
            <span className={styles.mono}>{timeLeftWords(share.expiresAt, nowMs)}</span>
          </span>
        </span>
        {check === null ? null : mismatch ? (
          <span className={styles.error} role="alert" data-testid={`received-${share.id}-claim`}>
            {check}
          </span>
        ) : keyChanged ? (
          <span className={styles.caution} data-testid={`received-${share.id}-changed`}>
            <TriangleAlert className={styles.cautionIcon} size={16} strokeWidth={1.75} aria-hidden />
            {check}
          </span>
        ) : firstCheck ? (
          <span
            className={styles.hint}
            data-testid={fromCheck?.kind === "no-number" ? `received-${share.id}-no-number` : `received-${share.id}-first`}
          >
            {check}
          </span>
        ) : null}
        {ending === null ? null : (
          <span className={styles.soon} data-testid={`received-${share.id}-ending`}>
            {ending}
          </span>
        )}
        <span className={styles.itemToggle}>
          <SheetButton
            kind="text"
            tooltip={details ? "Hide the details" : "Show the details"}
            hint="Which version you see, Keep for offline and Request more time."
            onClick={() => {
              setDetails(!details);
            }}
            testId={`received-${share.id}-details`}
          >
            {details ? "Hide details" : "Details"}
          </SheetButton>
        </span>
      </div>
      <div className={styles.itemActions}>
        <SheetButton
          tooltip={`Load the auto ${from} shared`}
          hint="Puts their robot on your field and your timeline, beside your open auto. With no auto open, it opens alone, read only. It is never saved into your project."
          onClick={() => {
            void loadReceivedShare(share);
          }}
          testId={`received-${share.id}-load`}
        >
          Load
        </SheetButton>
      </div>
      {details ? (
        <div className={styles.itemDetails} data-testid={`received-${share.id}-more`}>
          <span className={styles.hint} data-testid={`received-${share.id}-version`}>
            {versionWords(share, nowMs)}
          </span>
          <KeepToggle
            entry={{ id: share.id, label: from, via: share.audience === "link" ? "link" : "team" }}
            kept={keptShares.isKept(share.id)}
            testId={`received-${share.id}-keep`}
          />
        </div>
      ) : null}
      {details && share.audience === "teams" ? (
        <RequestMoreTime shareId={share.id} fromTeam={from} endsAt={share.expiresAt} nowMs={nowMs} testId={`received-${share.id}-time`} />
      ) : null}
    </li>
  );
}

export function ReceivedShares() {
  const { session, received, waiting } = useCloud();
  const kept = useKeptShares();
  const nowMs = cloudNow();
  const cloudOn = cloudEnabled();

  useEffect(() => {
    if (!cloudOn) return;
    if (session.signedIn) void refreshReceived();
    // Kept shares are read again while online, so the offline copy is the newest.
    void refreshKept();
  }, [cloudOn, session.signedIn, session.teamId]);

  if (!cloudOn) return null;
  const links = openedLinksToList(kept, new Set(received.map((share) => share.id)), cloudOn);
  if (!session.signedIn && links.length === 0) return null;
  const team = session.teamNumber === null ? "your team" : `team ${String(session.teamNumber)}`;

  return (
    <>
      {!session.signedIn ? null : (
        <section className={styles.section} aria-label="Shared with your team" data-testid="received-shares">
          <div className={styles.row}>
            <h3 className={styles.sectionHead}>Shared with your team</h3>
            <SheetButton
              kind="text"
              tooltip="Check for new shares"
              hint="Read the shares other teams have made to your team again, and what became of the proposals and requests for more time your team sent."
              onClick={() => {
                void refreshReceived();
                void refreshProposals();
                void refreshTimeRequests();
              }}
              testId="received-refresh"
            >
              Refresh
            </SheetButton>
          </div>
          {received.length === 0 && waiting.length === 0 ? (
            <p className={styles.hint} data-testid="received-none">
              No other team has shared an auto with {team} yet.
            </p>
          ) : (
            <ul className={styles.list} data-testid="received-list">
              {received.map((share) => (
                <ReceivedRow key={share.id} share={share} nowMs={nowMs} />
              ))}
            </ul>
          )}
          <WaitingShares waiting={waiting} />
        </section>
      )}
      {session.signedIn ? <EndedShares nowMs={nowMs} /> : null}
      {links.length === 0 ? null : <OpenedLinks links={links} />}
    </>
  );
}

/**
 * The shares made to the team that this device cannot open until their team signs them with its
 * newer key: who each is from, and why it waits. Nothing else of them is known.
 */
export function WaitingShares({ waiting }: { waiting: WaitingShare[] }) {
  if (waiting.length === 0) return null;
  return (
    <ul className={styles.list} aria-label="Waiting for the team that shared them" data-testid="waiting-list">
      {waiting.map((share) => {
        const check = fromTeamCheckWords(share);
        return (
          <li key={share.id} className={styles.item} data-testid={`waiting-${share.id}`}>
            <div className={styles.itemMain}>
              <span className={styles.itemWho} data-testid={`waiting-${share.id}-from`}>
                {WAITING_SHARES.from(fromTeamWords(share))}
              </span>
              <span className={styles.hint}>{WAITING_SHARES.why}</span>
              {check === null || share.fromTeamCheck?.kind !== "mismatch" ? null : (
                <span className={styles.error} role="alert" data-testid={`waiting-${share.id}-claim`}>
                  {check}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The link shares opened on this computer, newest first, each to open again or keep offline. */
function OpenedLinks({ links }: { links: KeptShare[] }) {
  return (
    <section className={styles.section} aria-label="Links opened here" data-testid="opened-links">
      <h3 className={styles.sectionHead}>Links opened here</h3>
      <ul className={styles.list} data-testid="opened-links-list">
        {links.map((entry) => (
          <li key={entry.id} className={styles.item} data-testid={`opened-link-${entry.id}`}>
            <div className={styles.itemMain}>
              <span className={styles.itemWho}>{entry.label}</span>
              <span className={styles.itemMeta} data-testid={`opened-link-${entry.id}-state`}>
                {entry.kept ? "Kept for offline on this computer" : "Opened on this computer"}
              </span>
            </div>
            <div className={styles.itemActions}>
              <SheetButton
                tooltip="Open this share again"
                hint="Beside your open auto in the alliance view, or alone and read only with none open. Offline, it opens from this computer's copy."
                onClick={() => {
                  void reopenKept(entry);
                }}
                testId={`opened-link-${entry.id}-open`}
              >
                Open
              </SheetButton>
            </div>
            <div className={styles.itemFollowUp}>
              <KeepToggle entry={entry} kept={entry.kept} testId={`opened-link-${entry.id}-keep`} />
              <SheetButton
                kind="text"
                tooltip="Remove from this list"
                hint="Forgets the link on this computer. The share itself is not changed."
                onClick={() => {
                  keptShares.forget(entry.id);
                }}
                testId={`opened-link-${entry.id}-forget`}
              >
                Remove
              </SheetButton>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The Keep for offline checkbox, with a tooltip that says what it does or why it cannot. */
function KeepToggle({
  entry,
  kept,
  testId,
}: {
  entry: Pick<KeptShare, "id" | "secret" | "label" | "via">;
  kept: boolean;
  testId: string;
}) {
  const id = useId();
  const why = whyCannotKeep();
  return (
    <Tooltip
      label="Keep for offline"
      hint={
        why !== null
          ? `Unavailable: ${why}`
          : kept
            ? "Kept: it opens on this computer with no connection until it ends. Untick to stop keeping it."
            : "Saves it on this computer now, so it opens at an event with no Wi-Fi."
      }
    >
      <label className={styles.check} htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={kept}
          aria-disabled={why !== null}
          disabled={why !== null}
          data-testid={testId}
          onChange={(event) => {
            void keepForOffline(
              { id: entry.id, ...(entry.secret === undefined ? {} : { secret: entry.secret }), label: entry.label, via: entry.via },
              event.target.checked,
            );
          }}
        />
        Keep for offline
      </label>
    </Tooltip>
  );
}
