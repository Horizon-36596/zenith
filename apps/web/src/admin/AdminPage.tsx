/**
 * The Horizon admins' review page at `#/admin` (spec 13 section 4.4, M-C7): the queue of verification
 * requests, disputes and appeals, the evidence and history of the one opened, and a decision with a
 * required one-sentence reason. One Horizon admin may decide every item alone (owner ruling
 * 2026-10-01): an appeal of their own first decision, and a team they are a member of, each with a
 * plain note that the record carries their name.
 *
 * A second view, All shares, lists every share of every team by its settings and the teams it
 * involves, never what it shows (`AllShares.tsx`, spec 13 section 13). A third, Bug reports, lists
 * the private reports people sent from Report a bug, to read and mark triaged or closed
 * (`BugReports.tsx`). A fourth, Beta access, lists the beta testers and the Horizon admins, and adds
 * them by user code and removes them (`BetaAccess.tsx`, owner rulings 2026-10-02 and 2026-10-03).
 *
 * Only a Horizon admin sees the page: `AdminRoute.tsx` opens it for nobody else, and the page checks
 * again itself, closing at once if the account signed in now is not an admin (issue #99).
 * Every read the page makes as an admin (the queue, an opened item, All shares, Bug reports, Beta
 * access) is recorded in the admin access log first, and every decision writes its own entry with it
 * (spec 13 section 13).
 * The page is docked at the right and is not modal (spec 11 section 1): the editor keeps working
 * beside it, and Escape closes it while focus is inside it.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import type { Claim, CloudBackend, Dispute, ReviewQueue, VerificationRequest } from "@horizon36596/zenith-cloud";
import { RowButton } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { AllShares } from "./AllShares";
import { BetaAccess } from "./BetaAccess";
import { BugReports } from "./BugReports";
import { ActionButton, TextArea } from "./controls";
import { Segmented } from "../components/Segmented";
import { claimCode, dayWords, decisionProblem, disputeView, queueItems, queueTeamIds, reviewerNotes, type QueueItem, type TeamNames } from "./model";
import { logAdminAccess } from "./store";
import { EvidenceList, History } from "./VerificationSection";
import { focusForInput } from "../components/inputModality";
import styles from "./admin.module.css";
import { cloudErrorSentence } from "../cloud/errorSentence";

type Access = "checking" | "signed-out" | "not-admin" | "admin";

/** The page's views: the team-number review queue, every team's shares, the bug reports and beta access. */
type View = "queue" | "shares" | "reports" | "beta";

const VIEW_OPTIONS: ReadonlyArray<{ value: View; label: string; does: string }> = [
  { value: "queue", label: "Team numbers", does: "The verification requests, disputes and appeals waiting for a reviewer." },
  { value: "shares", label: "All shares", does: "Every share of every team: its settings and the teams it involves, never what it shows." },
  { value: "reports", label: "Bug reports", does: "The reports people sent from Report a bug, to read and mark triaged or closed." },
  { value: "beta", label: "Beta access", does: "The beta testers and the Horizon admins, to add by user code and remove." },
];

const VIEW_TITLES: Record<View, string> = { queue: "Team number review", shares: "All shares", reports: "Bug reports", beta: "Beta access" };
const REFRESH_WORDS: Record<View, { label: string; hint: string }> = {
  queue: { label: "Refresh the queue", hint: "Reads the queue again from the database." },
  shares: { label: "Refresh the shares", hint: "Reads every share again from the database." },
  reports: { label: "Refresh the reports", hint: "Reads every bug report again from the database." },
  beta: { label: "Refresh the lists", hint: "Reads the testers and admins again from the database." },
};

interface Opened {
  item: QueueItem;
  request: VerificationRequest | null;
  dispute: Dispute | null;
  claim: Claim | null;
}

function message(error: unknown): string {
  return cloudErrorSentence(error);
}

const KIND_WORDS: Record<QueueItem["kind"], string> = {
  appeal: "Appeal",
  dispute: "Dispute",
  request: "Request",
};

export function AdminPage({ backend, onClose, now = () => new Date() }: { backend: CloudBackend | null; onClose: () => void; now?: () => Date }) {
  const titleId = useId();
  const ref = useRef<HTMLElement | null>(null);
  const [access, setAccess] = useState<Access>("checking");
  const [queue, setQueue] = useState<ReviewQueue | null>(null);
  const [names, setNames] = useState<TeamNames>(new Map());
  const [myTeamIds, setMyTeamIds] = useState<ReadonlySet<string>>(new Set());
  const [opened, setOpened] = useState<Opened | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [view, setView] = useState<View>("queue");
  const me = backend?.currentUser()?.uid ?? "";

  useEffect(() => {
    focusForInput(ref.current, { preventScroll: true });
  }, []);

  // Signing in or switching user beside the open page reads the queue again, as the new user.
  useEffect(() => {
    if (backend === null) return;
    return backend.onAuthChange(() => {
      setGeneration((value) => value + 1);
    });
  }, [backend]);

  useEffect(() => {
    let live = true;
    void (async () => {
      if (backend === null || backend.currentUser() === null) {
        setAccess("signed-out");
        onClose();
        return;
      }
      const admin = await backend.isHorizonAdmin().catch(() => false);
      if (!live) return;
      setAccess(admin ? "admin" : "not-admin");
      if (!admin) {
        onClose();
        return;
      }
      try {
        await logAdminAccess(backend, "queue.list");
        const next = await backend.listReviewQueue();
        // The teams the reviewer is a member of, for the note beside a decision about one of them.
        const mine = new Set((await backend.listMyTeams().catch(() => [])).map((m) => m.teamId));
        const found = new Map<string, string>();
        for (const id of queueTeamIds(next)) {
          const team = await backend.getTeam(id).catch(() => null);
          if (team !== null) found.set(id, team.name);
        }
        if (!live) return;
        setQueue(next);
        setNames(found);
        setMyTeamIds(mine);
      } catch (err) {
        if (live) setError(message(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [backend, generation, onClose]);

  const open = useCallback(
    async (item: QueueItem) => {
      if (backend === null || queue === null) return;
      setError(null);
      setNotice(null);
      await logAdminAccess(backend, "queue.open", item.id);
      const request = item.kind === "request" ? (queue.requests.find((r) => r.id === item.id) ?? null) : null;
      const dispute = item.kind === "request" ? null : ([...queue.disputes, ...queue.appeals].find((d) => d.id === item.id) ?? null);
      const claim = await backend.getClaim(item.teamNumber).catch(() => null);
      const more = new Map(names);
      for (const entry of claim?.history ?? []) {
        if (!more.has(entry.teamId)) {
          const team = await backend.getTeam(entry.teamId).catch(() => null);
          if (team !== null) more.set(entry.teamId, team.name);
        }
      }
      setNames(more);
      setOpened({ item, request, dispute, claim });
    },
    [backend, queue, names],
  );

  const decide = useCallback(
    async (run: () => Promise<void>, done: string) => {
      setBusy(true);
      setError(null);
      try {
        await run();
        setNotice(done);
        setOpened(null);
        setGeneration((g) => g + 1);
      } catch (err) {
        setError(message(err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const items = queue === null ? [] : queueItems(queue, names);

  return (
    <section
      ref={ref}
      className={styles.page}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-testid="admin-page"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <header className={styles.pageHead}>
        <h2 id={titleId} className={styles.pageTitle}>
          {access === "admin" ? VIEW_TITLES[view] : VIEW_TITLES.queue}
        </h2>
        <span className={styles.spacer} />
        {access === "admin" ? <Segmented label="View" options={VIEW_OPTIONS} value={view} onChange={setView} testId="admin-view" /> : null}
        {access === "admin" ? (
          <RowButton
            icon={RefreshCw}
            label={REFRESH_WORDS[view].label}
            hint={REFRESH_WORDS[view].hint}
            onClick={() => {
              setGeneration((g) => g + 1);
            }}
            testId="admin-refresh"
          />
        ) : null}
        <RowButton icon={X} label="Close" shortcut="Esc" hint="Close the review page. Nothing is sent." onClick={onClose} testId="admin-close" />
      </header>

      {access !== "admin" ? (
        <div className={styles.notice}>
          <p className={styles.sentence} data-testid="admin-checking">
            Loading…
          </p>
        </div>
      ) : view === "shares" && backend !== null ? (
        <div className={styles.pageBody} data-view="shares">
          <AllShares backend={backend} generation={generation} now={now} />
        </div>
      ) : view === "reports" && backend !== null ? (
        <div className={styles.pageBody} data-view="reports">
          <BugReports backend={backend} generation={generation} />
        </div>
      ) : view === "beta" && backend !== null ? (
        <div className={styles.pageBody} data-view="beta">
          <BetaAccess backend={backend} generation={generation} />
        </div>
      ) : (
        <div className={styles.pageBody}>
          <div className={styles.queue}>
            <div className={styles.section}>
              <h3 className={styles.sectionHead}>Waiting for a reviewer</h3>
              {notice === null ? null : <p className={styles.prose} data-testid="admin-notice">{notice}</p>}
              {queue === null ? (
                <p className={styles.prose}>Loading the queue…</p>
              ) : items.length === 0 ? (
                <p className={styles.prose} data-testid="admin-queue-empty">Nothing is waiting.</p>
              ) : (
                <ul className={styles.list} data-testid="admin-queue">
                  {items.map((item) => (
                    <li key={`${item.kind}-${item.id}`}>
                      <Tooltip label={`Open this ${KIND_WORDS[item.kind].toLowerCase()}`} hint="Shows its evidence and history, and the decision form.">
                        <button
                          type="button"
                          className={styles.queueRow}
                          aria-pressed={opened?.item.id === item.id}
                          data-testid={`admin-queue-${item.kind}-${item.id}`}
                          onClick={() => {
                            void open(item);
                          }}
                        >
                          <span>{item.title}</span>
                          <span className={styles.meta}>
                            <span>{KIND_WORDS[item.kind]}</span>
                            <span className={styles.mono}>{`waiting since ${dayWords(item.since)}`}</span>
                          </span>
                        </button>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <div className={styles.detail}>
            {error === null ? null : <p className={styles.error} data-testid="admin-error">{error}</p>}
            {opened === null ? (
              <p className={styles.prose}>No item open.</p>
            ) : opened.request !== null ? (
              <RequestReview
                key={`${opened.item.kind}:${opened.item.id}`}
                request={opened.request}
                claim={opened.claim}
                names={names}
                notes={reviewerNotes([opened.request.teamId], myTeamIds, null, me)}
                busy={busy}
                onDecide={(verdict, reason) => {
                  const request = opened.request;
                  if (backend === null || request === null) return;
                  void decide(
                    async () => {
                      await (await backend.decideVerification(request.id, { verdict, reason })).sent;
                    },
                    verdict === "verified" ? `Verified ${String(request.teamNumber)}.` : `Declined ${String(request.teamNumber)} for now.`,
                  );
                }}
              />
            ) : opened.dispute !== null ? (
              <DisputeReview
                key={`${opened.item.kind}:${opened.item.id}`}
                dispute={opened.dispute}
                claim={opened.claim}
                names={names}
                notes={reviewerNotes(
                  [opened.dispute.holderTeamId, opened.dispute.challengerTeamId],
                  myTeamIds,
                  opened.dispute.status === "appealed" ? (opened.dispute.decision?.by ?? null) : null,
                  me,
                )}
                now={now()}
                busy={busy}
                onDecide={(winner, reason) => {
                  const dispute = opened.dispute;
                  if (backend === null || dispute === null) return;
                  const appeal = dispute.status === "appealed";
                  void decide(
                    async () => {
                      const queued = appeal
                        ? await backend.decideAppeal(dispute.id, { winner, reason })
                        : await backend.decideDispute(dispute.id, { winner, reason });
                      await queued.sent;
                    },
                    appeal ? `Decided the appeal on ${String(dispute.teamNumber)}; it is final.` : `Decided the dispute on ${String(dispute.teamNumber)}.`,
                  );
                }}
              />
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

function ReasonField({ reason, onChange, testId }: { reason: string; onChange: (value: string) => void; testId: string }) {
  return (
    <TextArea
      label="Reason, in one sentence"
      tooltip="Required. The teams read exactly this sentence next to your decision."
      value={reason}
      onChange={onChange}
      placeholder="Robot photo with the claim code, and the team is listed at an event."
      testId={testId}
    />
  );
}

function RequestReview({
  request,
  claim,
  names,
  notes,
  busy,
  onDecide,
}: {
  request: VerificationRequest;
  claim: Claim | null;
  names: TeamNames;
  notes: string[];
  busy: boolean;
  onDecide: (verdict: "verified" | "declined", reason: string) => void;
}) {
  const [verdict, setVerdict] = useState<"verified" | "declined" | null>(null);
  const [reason, setReason] = useState("");
  const problem = decisionProblem(verdict, reason);
  const contested = claim !== null && (claim.status !== "unverified" || claim.teamId !== request.teamId);
  return (
    <div className={styles.section} data-testid="admin-request">
      <h3 className={styles.sectionHead}>{`Verify ${String(request.teamNumber)} for ${names.get(request.teamId) ?? "a team"}`}</h3>
      <p className={styles.prose}>
        A photo should show the code <span className={styles.mono} data-testid="admin-claim-code">{claimCode(request.teamId, request.teamNumber)}</span> on
        a card.
      </p>
      {contested ? <p className={styles.error}>The number is contested or held by another team now: decline this request and decide the dispute.</p> : null}
      <EvidenceList evidence={request.evidence} testId="admin-request-evidence" />
      <History claim={claim} names={names} />
      <Segmented
        label="Outcome"
        options={[
          { value: "verified", label: "Verify", does: `Marks ${String(request.teamNumber)} verified for this team.` },
          { value: "declined", label: "Decline", does: "Leaves the number unverified; the team can ask again with more evidence." },
        ]}
        value={verdict}
        onChange={setVerdict}
        testId="admin-verdict"
      />
      <ReasonField reason={reason} onChange={setReason} testId="admin-reason" />
      {reason.trim() !== "" && problem !== null ? <p className={styles.hint}>{problem}</p> : null}
      <ReviewerNotes notes={notes} />
      <div className={styles.row}>
        <ActionButton
          kind="primary"
          tooltip="Decide"
          hint="Records your decision and reason; the team reads the reason."
          whyDisabled={busy ? "A request is on its way." : problem}
          onClick={() => {
            if (verdict !== null) onDecide(verdict, reason.trim());
          }}
          testId="admin-decide"
        >
          Decide
        </ActionButton>
      </div>
    </div>
  );
}

function DisputeReview({
  dispute,
  claim,
  names,
  notes,
  now,
  busy,
  onDecide,
}: {
  dispute: Dispute;
  claim: Claim | null;
  names: TeamNames;
  notes: string[];
  now: Date;
  busy: boolean;
  onDecide: (winner: string, reason: string) => void;
}) {
  const [winner, setWinner] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const view = disputeView(dispute, "", names, now);
  const appeal = dispute.status === "appealed";
  const problem = decisionProblem(winner, reason);
  return (
    <div className={styles.section} data-testid="admin-dispute">
      <h3 className={styles.sectionHead}>{`${appeal ? "Appeal" : "Dispute"} on ${String(dispute.teamNumber)}`}</h3>
      <p className={styles.prose}>{view.state}</p>
      <div className={styles.sides}>
        {view.sides.map((side) => (
          <div key={side.teamId} className={styles.side}>
            <p className={styles.sideName}>{side.name}</p>
            <p className={styles.hint}>{side.role === "holder" ? "Claimed the number first" : "Claimed it second"}</p>
            <EvidenceList evidence={side.evidence} testId={`admin-dispute-evidence-${side.role}`} />
          </div>
        ))}
      </div>
      {view.decision === null ? null : <p className={styles.sentence}>{`First decision: ${view.decision}`}</p>}
      {view.appeal === null ? null : <p className={styles.sentence} data-testid="admin-appeal-reason">{view.appeal}</p>}
      <History claim={claim} names={names} />
      <Segmented
        label="Who gets the number"
        options={view.sides.map((side) => ({
          value: side.teamId,
          label: side.name,
          does: `Gives ${String(dispute.teamNumber)} to ${side.name}, verified. The other team keeps its library with no number.`,
        }))}
        value={winner}
        onChange={setWinner}
        testId="admin-winner"
      />
      <ReasonField reason={reason} onChange={setReason} testId="admin-reason" />
      {reason.trim() !== "" && problem !== null ? <p className={styles.hint}>{problem}</p> : null}
      <ReviewerNotes notes={notes} />
      <div className={styles.row}>
        <ActionButton
          kind="primary"
          tooltip={appeal ? "Decide the appeal" : "Decide"}
          hint={appeal ? "Final. Both teams read your reason." : "Both teams read your reason. The team that loses may appeal once within 14 days."}
          whyDisabled={busy ? "A request is on its way." : problem}
          onClick={() => {
            if (winner !== null) onDecide(winner, reason.trim());
          }}
          testId="admin-decide"
        >
          {appeal ? "Decide appeal" : "Decide"}
        </ActionButton>
      </div>
    </div>
  );
}

/** Plain notes beside a decision the reviewer may make but should know is recorded with their name. */
function ReviewerNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <>
      {notes.map((note) => (
        <p key={note} className={styles.hint} data-testid="admin-reviewer-note">
          {note}
        </p>
      ))}
    </>
  );
}
