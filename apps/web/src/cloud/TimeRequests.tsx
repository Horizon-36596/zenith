/**
 * "Request more time" (spec 13 section 8.4), on both sides of a share:
 *
 * - `TimeRequests`, under a share's row on the Sharing page: each team's request, with the reason it
 *   picked and the end it would like, and **Grant**, which opens the same choice of end as Extend
 *   (1, 7 or 30 more days, or a date and time) and extends the share, or **Decline**.
 * - `RequestMoreTime`, under a received share in the Partners panel: the button, a short form with
 *   how much more time and an optional reason from a fixed list, and what became of the request.
 * - `EndedShares`, in the Partners panel: the shares made to the team that it can no longer open,
 *   each with Request more time, since a team may ask after a share ended.
 *
 * Nothing here is typed by a person: FIRST's Youth Protection Program rules out private messages
 * between users (spec 13 section 12.2), so a request is a fixed reason and an end, and both teams'
 * members see it. Offline, a request or an answer waits in the Outbox, and the confirmation says
 * that the other team does not see it yet.
 */
import { useEffect, useId, useState } from "react";
import { shareDateWords } from "@horizon36596/zenith-core";
import { Tooltip } from "../components/Tooltip";
import { timeAgo } from "../account/words";
import { account } from "../account/store";
import { Segmented, type SegmentOption } from "../components/Segmented";
import { SheetButton } from "./controls";
import { OutboxNotice } from "./OutboxNotice";
import { utcOffsetAt } from "./shareModel";
import {
  localDateTime,
  pickInstant,
  pickProblem,
  requestFor,
  requestsOfShare,
  TIME_REQUEST_REASON_IDS,
  TIME_REQUEST_REASON_WORDS,
  TIME_REQUEST_STATUS_WORDS,
  type CloudTimeRequest,
  type EndPick,
  type TimeRequestReason,
} from "./timeRequestsApi";
import { askForMoreTime, decideTimeRequest, refreshTimeRequestsIfStale, useTimeRequests } from "./timeRequestsStore";
import type { Share } from "./types";
import { whoWords } from "./words";
import styles from "./cloud.module.css";
import own from "./timeRequests.module.css";

/** "Sat 4 Oct", or "Sat 4 Oct, 18:30" when the time is not the end of the day. */
function endWords(at: string, nowMs: number): string {
  const day = shareDateWords(at, nowMs, { utcOffsetMinutes: utcOffsetAt(at, nowMs) });
  const { time } = localDateTime(at);
  return time === "23:59" ? day : `${day}, ${time}`;
}

type PickKey = "none" | "asked" | "1" | "7" | "30" | "date";

const keyOf = (pick: EndPick): PickKey =>
  pick.kind === "days" ? (String(pick.days) as PickKey) : pick.kind;

/** The choice of end: more days, a date and time, and on a grant what the other team asked for. */
function EndChoice({
  pick,
  onPick,
  purpose,
  askedFor,
  nowMs,
  testId,
}: {
  pick: EndPick;
  onPick: (pick: EndPick) => void;
  purpose: "ask" | "grant";
  askedFor: string | null;
  nowMs: number;
  testId: string;
}) {
  const from = purpose === "grant" ? "counted from when the share ends now, or from now if it has ended" : "counted from when the share ends, or from now if it has ended";
  const options: Array<SegmentOption<PickKey>> = [
    ...(purpose === "ask"
      ? [{ value: "none" as const, label: "Leave it to them", does: "Ask for more time without naming an end; the team that shared it picks one." }]
      : []),
    ...(purpose === "grant" && askedFor !== null
      ? [{ value: "asked" as const, label: `What they asked for`, does: `Until ${endWords(askedFor, nowMs)}, the end they would like.` }]
      : []),
    { value: "1", label: "1 more day", does: `One more day, ${from}.` },
    { value: "7", label: "7 more days", does: `Seven more days, ${from}.` },
    { value: "30", label: "30 more days", does: `Thirty more days, ${from}.` },
    { value: "date", label: "A date", does: "Until a date you pick, and a time on it if you want one." },
  ];
  const pickFor = (key: PickKey): EndPick => {
    if (key === "none" || key === "asked") return { kind: key };
    if (key === "date") {
      const start = askedFor ?? new Date(nowMs + 7 * 86_400_000).toISOString();
      return { kind: "date", ...localDateTime(start) };
    }
    return { kind: "days", days: Number(key) as 1 | 7 | 30 };
  };
  return (
    <>
      <Segmented
        label={purpose === "grant" ? "How much more time to give" : "How much more time to ask for"}
        options={options}
        value={keyOf(pick)}
        onChange={(key) => {
          onPick(pickFor(key));
        }}
        testId={testId}
      />
      {pick.kind === "date" ? (
        <div className={styles.row}>
          <Tooltip label="The last day" hint="Without a time, it runs until the end of this day, on your clock.">
            <input
              type="date"
              className={styles.input}
              aria-label="The last day"
              value={pick.date}
              data-testid={`${testId}-day`}
              onChange={(event) => {
                onPick({ ...pick, date: event.target.value });
              }}
            />
          </Tooltip>
          <Tooltip label="The time it ends, if you want one" hint="Leave it empty for the end of the day. The time is on your clock.">
            <input
              type="time"
              className={styles.input}
              aria-label="The time it ends"
              value={pick.time ?? ""}
              data-testid={`${testId}-time`}
              onChange={(event) => {
                onPick({ ...pick, time: event.target.value });
              }}
            />
          </Tooltip>
        </div>
      ) : null}
    </>
  );
}

/** What was sent, and when it is only on this computer, that the other team does not see it yet. */
interface Outcome {
  text: string;
  queued: boolean;
}

/** The confirmation line; while the write waits in the Outbox, a notice that says so, with a link. */
function OutcomeLine({ outcome, testId }: { outcome: Outcome; testId: string }) {
  if (outcome.queued) return <OutboxNotice text={outcome.text} testId={testId} />;
  return (
    <span className={own.note} role="status" data-testid={testId}>
      {outcome.text}
    </span>
  );
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ------------------------------------------------------------------------ the sharing team's side

/** Why the signed-in member cannot answer, or null when they may try (the rules decide for an editor). */
function whyCannotAnswer(): string | null {
  const role = account.role();
  if (role === "owner" || role === "admin" || role === "editor") return null;
  return "Only the team's owners and admins, or the editor who made the share, can answer a request for more time.";
}

/** The requests for more time on one of the team's shares, under its row on the Sharing page. */
export function TimeRequests({ share, nowMs }: { share: Share; nowMs: number }) {
  const { received } = useTimeRequests();
  useEffect(() => {
    void refreshTimeRequestsIfStale();
  }, []);
  const requests = requestsOfShare(received, share.id);
  if (requests.length === 0) return null;
  const waiting = requests.filter((request) => request.status === "open").length;
  return (
    <div className={own.block} data-testid={`time-requests-${share.id}`}>
      <span className={own.head}>
        {waiting > 0
          ? `${String(waiting)} ${waiting === 1 ? "team asks" : "teams ask"} for more time`
          : "Requests for more time"}
      </span>
      <ul className={own.list}>
        {requests.map((request) => (
          <ReceivedRequest key={request.teamId} share={share} request={request} nowMs={nowMs} />
        ))}
      </ul>
    </div>
  );
}

function ReceivedRequest({ share, request, nowMs }: { share: Share; request: CloudTimeRequest; nowMs: number }) {
  const rowId = `time-request-${share.id}-${request.teamId}`;
  const askedFor = request.wantedUntil !== null && Date.parse(request.wantedUntil) > nowMs ? request.wantedUntil : null;
  const [granting, setGranting] = useState(false);
  const [pick, setPick] = useState<EndPick>(askedFor !== null ? { kind: "asked" } : { kind: "days", days: 7 });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revoked = share.revokedAt !== null ? "This share was revoked, so it cannot be given more time." : null;
  const cannot = whyCannotAnswer();
  const at = pickInstant(pick, share.expiresAt, askedFor, nowMs);
  const problem = pickProblem(pick, at, share.expiresAt, nowMs, "grant");
  const team = request.team;

  const answer = async (status: "granted" | "declined"): Promise<void> => {
    if (status === "granted" && (at === null || problem !== null)) return;
    setBusy(true);
    setError(null);
    try {
      const sent = await decideTimeRequest(
        share.id,
        request.teamId,
        status === "granted" && at !== null ? { status, expiresAt: at } : { status: "declined" },
      );
      const done =
        status === "granted" && at !== null
          ? `Gave ${team} more time, until ${endWords(at, nowMs)}.`
          : `Declined ${team}'s request for more time.`;
      setOutcome({
        text: sent.queued
          ? `${done} It is saved on this computer, and ${team} sees it when this computer is back online.`
          : done,
        queued: sent.queued,
      });
      setGranting(false);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={own.row} data-testid={rowId} data-status={request.status}>
      <Tooltip label={TIME_REQUEST_STATUS_WORDS[request.status]} hint={statusHint(request, nowMs)}>
        <span className={own.chip} data-status={request.status} tabIndex={0} data-testid={`${rowId}-status`}>
          {TIME_REQUEST_STATUS_WORDS[request.status]}
        </span>
      </Tooltip>
      <span className={own.meta}>
        <span data-testid={`${rowId}-team`}>{team}</span>
        <span aria-hidden>·</span>
        <span data-testid={`${rowId}-reason`}>
          {request.reason === null ? "No reason given" : TIME_REQUEST_REASON_WORDS[request.reason]}
        </span>
        {request.wantedUntil === null ? null : (
          <>
            <span aria-hidden>·</span>
            <span className={styles.mono}>Would like it until {endWords(request.wantedUntil, nowMs)}</span>
          </>
        )}
        <span aria-hidden>·</span>
        <span>asked {timeAgo(new Date(request.requestedAt), nowMs)}</span>
      </span>
      {request.status === "open" ? (
        <span className={own.actions}>
          <SheetButton
            kind="text"
            tooltip={`Give ${team} more time`}
            hint="Pick the new end: more days, a date and time, or what they asked for. The share is extended at once."
            whyDisabled={revoked ?? cannot ?? (busy ? "Sending your answer already." : null)}
            onClick={() => {
              setGranting(!granting);
            }}
            testId={`${rowId}-grant`}
          >
            Grant
          </SheetButton>
          <SheetButton
            kind="text"
            tooltip={`Decline ${team}'s request`}
            hint="The share keeps its end. They see that you declined, and may ask again."
            whyDisabled={cannot ?? (busy ? "Sending your answer already." : null)}
            onClick={() => {
              void answer("declined");
            }}
            testId={`${rowId}-decline`}
          >
            Decline
          </SheetButton>
        </span>
      ) : null}
      {granting && request.status === "open" ? (
        <div className={own.form} role="group" aria-label={`Give ${team} more time`} data-testid={`${rowId}-choices`}>
          <EndChoice pick={pick} onPick={setPick} purpose="grant" askedFor={askedFor} nowMs={nowMs} testId={`${rowId}-end`} />
          <span className={own.actions}>
            <SheetButton
              kind="primary"
              tooltip="Give more time"
              hint={at === null ? "Pick the new end first." : `The share with ${whoWords(share)} will end ${endWords(at, nowMs)}.`}
              whyDisabled={problem ?? revoked ?? cannot ?? (busy ? "Sending your answer already." : null)}
              onClick={() => {
                void answer("granted");
              }}
              testId={`${rowId}-give`}
            >
              Give more time
            </SheetButton>
            <SheetButton
              kind="text"
              tooltip="Keep the end as it is"
              onClick={() => {
                setGranting(false);
              }}
            >
              Cancel
            </SheetButton>
          </span>
        </div>
      ) : null}
      {outcome === null ? null : <OutcomeLine outcome={outcome} testId={`${rowId}-outcome`} />}
      {error === null ? null : (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </li>
  );
}

function statusHint(request: CloudTimeRequest, nowMs: number): string {
  if (request.status === "open") return "Waiting for an answer from the team that made the share.";
  if (request.status === "granted") {
    return request.grantedUntil === null ? "More time was given." : `More time was given, until ${endWords(request.grantedUntil, nowMs)}.`;
  }
  return "The team that made the share declined. The share kept its end.";
}

// ------------------------------------------------------------------------ the receiving team's side

/**
 * Request more time on a share made to the signed-in team, and what became of the last request.
 * `endsAt` is the share's end when this team can still read it, and null for an ended one.
 */
export function RequestMoreTime({
  shareId,
  fromTeam,
  endsAt,
  nowMs,
  testId,
}: {
  shareId: string;
  /** The sharing team in words: "Team 36596". */
  fromTeam: string;
  endsAt: string | null;
  nowMs: number;
  testId: string;
}) {
  const { sent, teamId } = useTimeRequests();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<EndPick>({ kind: "days", days: 7 });
  const [reason, setReason] = useState<TimeRequestReason | "">("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (teamId === null) return null;
  const last = requestFor(sent, shareId, teamId);
  const waiting = last !== null && last.status === "open";
  const at = pickInstant(pick, endsAt, null, nowMs);
  const problem = pickProblem(pick, at, endsAt, nowMs, "ask");

  const send = async (): Promise<void> => {
    if (problem !== null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await askForMoreTime({
        shareId,
        ...(reason === "" ? {} : { reason }),
        ...(at === null ? {} : { wantedUntil: at }),
      });
      setOutcome({
        text: result.queued
          ? `Your request is saved on this computer. It reaches ${fromTeam} when this computer is back online.`
          : `Asked ${fromTeam} for more time. It shows on their Sharing page, and their answer shows here.`,
        queued: result.queued,
      });
      setOpen(false);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={own.block} data-testid={testId}>
      <div className={own.row}>
        {last === null ? null : (
          <>
            <span className={own.chip} data-status={last.status} data-testid={`${testId}-status`}>
              {TIME_REQUEST_STATUS_WORDS[last.status]}
            </span>
            <span className={own.meta} data-testid={`${testId}-answer`}>
              {last.status === "open"
                ? `Asked for more time ${timeAgo(new Date(last.requestedAt), nowMs)}; waiting for ${fromTeam}.`
                : last.status === "granted"
                  ? `${fromTeam} gave more time${last.grantedUntil === null ? "" : `, until ${endWords(last.grantedUntil, nowMs)}`}.`
                  : `${fromTeam} declined more time. You may ask again.`}
            </span>
          </>
        )}
        <SheetButton
          kind="text"
          tooltip={`Ask ${fromTeam} for more time`}
          hint="Pick how much more time and, if you like, a reason from the list. It shows on their Sharing page; no message is sent to anyone."
          whyDisabled={waiting ? `Your team already asked; ${fromTeam} has not answered yet.` : busy ? "Sending the request already." : null}
          onClick={() => {
            setOpen(!open);
          }}
          testId={`${testId}-open`}
        >
          Request more time
        </SheetButton>
      </div>
      {open && !waiting ? (
        <div className={own.form} role="group" aria-label={`Ask ${fromTeam} for more time`} data-testid={`${testId}-form`}>
          <EndChoice pick={pick} onPick={setPick} purpose="ask" askedFor={null} nowMs={nowMs} testId={`${testId}-end`} />
          <label className={own.field} htmlFor={reasonId}>
            Why, if you want to say (from a fixed list, so no message is sent)
            <select
              id={reasonId}
              className={styles.input}
              value={reason}
              data-testid={`${testId}-reason`}
              onChange={(event) => {
                setReason(event.target.value as TimeRequestReason | "");
              }}
            >
              <option value="">No reason given</option>
              {TIME_REQUEST_REASON_IDS.map((id) => (
                <option key={id} value={id}>
                  {TIME_REQUEST_REASON_WORDS[id]}
                </option>
              ))}
            </select>
          </label>
          <span className={own.actions}>
            <SheetButton
              kind="primary"
              tooltip="Send the request"
              hint={`${fromTeam} sees it on their Sharing page and can give more time or decline.`}
              whyDisabled={problem ?? (busy ? "Sending the request already." : null)}
              onClick={() => {
                void send();
              }}
              testId={`${testId}-send`}
            >
              Send request
            </SheetButton>
            <SheetButton
              kind="text"
              tooltip="Do not ask"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </SheetButton>
          </span>
        </div>
      ) : null}
      {outcome === null ? null : <OutcomeLine outcome={outcome} testId={`${testId}-outcome`} />}
      {error === null ? null : (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** The shares made to the team that it can no longer open, each with Request more time. */
export function EndedShares({ nowMs }: { nowMs: number }) {
  const { ended } = useTimeRequests();
  if (ended.length === 0) return null;
  return (
    <section className={styles.section} aria-label="Ended shares" data-testid="ended-shares">
      <h3 className={styles.sectionHead}>Ended shares</h3>

      <ul className={styles.list}>
        {ended.map((entry) => (
          <li key={entry.shareId} className={styles.item} data-testid={`ended-${entry.shareId}`}>
            <div className={styles.itemMain}>
              <span className={styles.itemWho}>Received from {entry.fromTeam.charAt(0).toLowerCase()}{entry.fromTeam.slice(1)}</span>
              <span className={styles.itemMeta}>
                <span>Ended or revoked</span>
                <span aria-hidden>·</span>
                <span>shared {timeAgo(new Date(entry.receivedAt), nowMs)}</span>
              </span>
            </div>
            <RequestMoreTime
              shareId={entry.shareId}
              fromTeam={entry.fromTeam}
              endsAt={null}
              nowMs={nowMs}
              testId={`ended-${entry.shareId}-time`}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
