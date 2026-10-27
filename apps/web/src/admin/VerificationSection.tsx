/**
 * The team's Verification section (spec 13 section 4.4, M-C7), for the account page to mount:
 * the status badge, Claim a number for a team with none, Request verification with evidence rows,
 * the claim's history, every dispute the team is in with both teams' evidence and the reviewer's
 * reason, and Appeal while the 14 days last. It renders inline wherever it is placed; nothing here is
 * modal.
 *
 *   <VerificationSection backend={backend} teamId={teamId} canManage={role is owner or admin} />
 */
import { useCallback, useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import type { Claim, CloudBackend, Dispute, EvidenceKind, Team, VerificationRequest } from "@horizon36596/zenith-cloud";
import { MAX_REQUEST_EVIDENCE } from "@horizon36596/zenith-cloud/verification";
import { RowButton } from "../components/primitives";
import { readTeamNumber } from "../lib/teamNumber";
import { ActionButton, EvidenceAddress, StatusBadge, TextArea, TextField } from "./controls";
import { Segmented } from "../components/Segmented";
import {
  EVIDENCE_KIND_WORDS,
  appealWindowWords,
  badgeFor,
  claimCode,
  dayWords,
  disputeView,
  emptyRow,
  filledRows,
  historyRows,
  isLive,
  requestProblem,
  requestSentence,
  rowProblems,
  toInput,
  type DisputeView,
  type EvidenceRow,
  type TeamNames,
} from "./model";
import styles from "./admin.module.css";
import { cloudErrorSentence } from "../cloud/errorSentence";

export interface VerificationSectionProps {
  backend: CloudBackend;
  teamId: string;
  /** True for the team's owners and admins, who claim, ask, add evidence and appeal. */
  canManage: boolean;
  /** The clock for the appeal window. Tests pass a fixed one. */
  now?: () => Date;
}

interface Loaded {
  team: Team | null;
  claim: Claim | null;
  requests: VerificationRequest[];
  disputes: Dispute[];
  names: TeamNames;
}

const KIND_OPTIONS = (["photo", "event", "statement"] as const).map((kind) => ({
  value: kind,
  label: EVIDENCE_KIND_WORDS[kind].label,
  does: EVIDENCE_KIND_WORDS[kind].does,
}));

function message(error: unknown): string {
  return cloudErrorSentence(error);
}

/** Everything the section shows, read once per change. */
async function load(backend: CloudBackend, teamId: string): Promise<Loaded> {
  const team = await backend.getTeam(teamId);
  const disputes = await backend.listDisputes(teamId).catch(() => [] as Dispute[]);
  const number = team?.number ?? disputes.find(isLive)?.teamNumber ?? disputes[0]?.teamNumber ?? null;
  // With the team, so the history holds the steps this team was involved in (spec 13 section 4.4).
  const claim = number === null ? null : await backend.getClaim(number, teamId);
  const requests = await backend.listVerificationRequests(teamId).catch(() => [] as VerificationRequest[]);
  const ids = new Set<string>([teamId]);
  for (const d of disputes) {
    ids.add(d.holderTeamId);
    ids.add(d.challengerTeamId);
  }
  for (const entry of claim?.history ?? []) ids.add(entry.teamId);
  const names = new Map<string, string>();
  for (const id of ids) {
    const other = id === teamId ? team : await backend.getTeam(id).catch(() => null);
    if (other !== null) names.set(id, id === teamId ? `${other.name} (your team)` : other.name);
  }
  return { team, claim, requests, disputes, names };
}

export function VerificationSection({ backend, teamId, canManage, now = () => new Date() }: VerificationSectionProps) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let live = true;
    load(backend, teamId)
      .then((loaded) => {
        if (live) setData(loaded);
      })
      .catch((err: unknown) => {
        if (live) setError(message(err));
      });
    return () => {
      live = false;
    };
  }, [backend, teamId, generation]);

  /** Runs one request, then reloads; the sentence it resolves to becomes the notice. */
  const act = useCallback(async (run: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await run());
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
      setGeneration((g) => g + 1);
    }
  }, []);

  if (data === null) {
    return (
      <section className={styles.section} data-testid="verification-section">
        <h3 className={styles.sectionHead}>Verification</h3>
        {error === null ? <p className={styles.prose}>Loading the team number's record…</p> : <p className={styles.error}>{error}</p>}
      </section>
    );
  }

  const { team, claim, requests, disputes, names } = data;
  const badge = badgeFor(teamId, team, claim, disputes);
  const holds = team?.number != null && claim !== null && claim.teamId === teamId;
  const openRequest = requests.find((r) => r.status === "open") ?? null;
  const liveDispute = disputes.find(isLive) ?? null;
  const canRequest = canManage && holds && claim.status === "unverified" && openRequest === null && liveDispute === null;
  const at = now();

  return (
    <section className={styles.section} data-testid="verification-section" aria-busy={busy}>
      <h3 className={styles.sectionHead}>
        Verification
        <StatusBadge badge={badge} testId="verification-badge" />
      </h3>
      <p className={styles.prose}>
        {team?.number == null
          ? "Your team has no FTC number yet."
          : `FTC ${String(team.number)}: ${badge.meaning}`}
      </p>
      {notice === null ? null : <p className={styles.sentence} data-testid="verification-notice">{notice}</p>}
      {error === null ? null : <p className={styles.error} data-testid="verification-error">{error}</p>}

      {canManage && team?.number == null && liveDispute === null ? (
        <ClaimNumber
          busy={busy}
          onClaim={(teamNumber) => {
            void act(async () => {
              const queued = await backend.claimNumber(teamId, teamNumber);
              await queued.sent;
              return queued.value.outcome === "claimed"
                ? `Your team now claims ${String(teamNumber)}. Ask for verification when you have your evidence.`
                : `Another team already claims ${String(teamNumber)}, unverified. Both claims now show as contested, and a Horizon admin will review the evidence from both teams.`;
            });
          }}
        />
      ) : null}

      {canRequest ? (
        <RequestForm
          teamNumber={team.number ?? 0}
          code={claimCode(teamId, team.number ?? 0)}
          busy={busy}
          onSend={(rows) => {
            void act(async () => {
              const queued = await backend.requestVerification(teamId, filledRows(rows).map(toInput));
              await queued.sent;
              return "Sent. A Horizon admin will review your evidence and give a one-sentence reason.";
            });
          }}
        />
      ) : null}

      {requests.length === 0 ? null : (
        <div className={styles.section}>
          <h4 className={styles.sectionHead}>Requests</h4>
          <ul className={styles.list} data-testid="verification-requests">
            {requests.map((r) => (
              <li key={r.id} className={styles.listItem}>
                <span>{requestSentence(r)}</span>
                <span className={styles.meta}>
                  <span className={styles.mono}>{dayWords(r.createdAt)}</span>
                  <span>{`${String(r.evidence.length)} piece${r.evidence.length === 1 ? "" : "s"} of evidence`}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {disputes.map((dispute) => (
        <DisputeCard
          key={dispute.id}
          view={disputeView(dispute, teamId, names, at)}
          now={at}
          teamId={teamId}
          canManage={canManage}
          busy={busy}
          onEvidence={(row) => {
            void act(async () => {
              await (await backend.addDisputeEvidence(dispute.id, { ...toInput(row), team: teamId })).sent;
              return "Added. Both teams and the reviewer can see it.";
            });
          }}
          onAppeal={(reason) => {
            void act(async () => {
              await (await backend.appealDispute(dispute.id, { team: teamId, reason })).sent;
              return "Appealed. A Horizon admin will decide, and that decision is final.";
            });
          }}
        />
      ))}

      <History claim={claim} names={names} />
    </section>
  );
}

// ------------------------------------------------------------------------ claim a number

function ClaimNumber({ busy, onClaim }: { busy: boolean; onClaim: (teamNumber: number) => void }) {
  const [text, setText] = useState("");
  // The app's one rule for a team number (issue #502), and its sentence when the text is not one.
  const read = readTeamNumber(text);
  return (
    <div className={styles.section}>
      <h4 className={styles.sectionHead}>Claim a number</h4>
      <div className={styles.row}>
        <TextField
          label="FTC team number"
          tooltip="Your team's number with FIRST. A number already verified to another team is refused; one claimed but unverified becomes contested."
          value={text}
          onChange={setText}
          mono
          testId="verification-claim-input"
        />
        <ActionButton
          tooltip="Claim this number"
          hint="Claims it for your team, or opens a review if another team claims it unverified."
          whyDisabled={busy ? "A request is on its way." : read.ok ? null : read.why}
          onClick={() => {
            if (read.ok) onClaim(read.teamNumber);
          }}
          testId="verification-claim"
        >
          Claim
        </ActionButton>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------ request verification

function EvidenceRows({
  rows,
  onChange,
  testId,
  removable,
}: {
  rows: EvidenceRow[];
  onChange: (rows: EvidenceRow[]) => void;
  testId: string;
  removable: boolean;
}) {
  const problems = rowProblems(rows);
  const change = (index: number, patch: Partial<EvidenceRow>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  return (
    <ol className={styles.list} data-testid={testId}>
      {rows.map((row, index) => (
        <li key={index} className={styles.evidenceRow} data-testid={`${testId}-${String(index)}`}>
          <Segmented<EvidenceKind>
            label="Kind of evidence"
            options={KIND_OPTIONS}
            value={row.kind}
            onChange={(kind) => {
              change(index, { kind });
            }}
            testId={`${testId}-${String(index)}-kind`}
          />
          <div className={styles.evidenceFields}>
            <TextField
              label="What it shows"
              tooltip="A few words the reviewer reads first. Both teams see it in a dispute."
              value={row.summary}
              placeholder={EVIDENCE_KIND_WORDS[row.kind].placeholder}
              onChange={(summary) => {
                change(index, { summary });
              }}
              testId={`${testId}-${String(index)}-summary`}
            />
            <TextField
              label={row.kind === "statement" ? "Link (optional)" : "Link"}
              tooltip="An https address where you host the photo or where the event result is published. Zenith stores no files."
              value={row.url}
              placeholder="https://"
              mono
              onChange={(url) => {
                change(index, { url });
              }}
              testId={`${testId}-${String(index)}-url`}
            />
            {problems[index] == null ? null : <p className={styles.hint}>{problems[index]}</p>}
          </div>
          {removable ? (
            <RowButton
              icon={X}
              label="Remove this evidence"
              hint="Takes this row out of the request. Nothing has been sent yet."
              disabled={rows.length <= 1}
              whyDisabled="A request needs at least one piece of evidence."
              onClick={() => {
                onChange(rows.filter((_, i) => i !== index));
              }}
              testId={`${testId}-${String(index)}-remove`}
            />
          ) : (
            <span />
          )}
        </li>
      ))}
    </ol>
  );
}

function RequestForm({
  teamNumber,
  code,
  busy,
  onSend,
}: {
  teamNumber: number;
  code: string;
  busy: boolean;
  onSend: (rows: EvidenceRow[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<EvidenceRow[]>([emptyRow("photo")]);
  if (!open) {
    return (
      <div className={styles.row}>
        <ActionButton
          kind="primary"
          tooltip="Request verification"
          hint={`Ask a Horizon admin to check that your team is ${String(teamNumber)}, with a photo, an event result or a statement.`}
          onClick={() => {
            setOpen(true);
          }}
          testId="verification-request-open"
        >
          Request verification
        </ActionButton>
      </div>
    );
  }
  const problem = requestProblem(rows, MAX_REQUEST_EVIDENCE);
  return (
    <div className={styles.section} data-testid="verification-request-form">
      <h4 className={styles.sectionHead}>Request verification</h4>
      <p className={styles.prose}>
        For a photo, write <span className={styles.mono} data-testid="verification-claim-code">{code}</span> on a card and hold it
        next to your robot. Paste a link: Zenith stores no files.
      </p>
      <EvidenceRows rows={rows} onChange={setRows} testId="verification-evidence" removable />
      <div className={styles.row}>
        <ActionButton
          kind="text"
          tooltip="Add evidence"
          hint={`Adds another row. A request carries up to ${String(MAX_REQUEST_EVIDENCE)}.`}
          whyDisabled={rows.length >= MAX_REQUEST_EVIDENCE ? `A request carries at most ${String(MAX_REQUEST_EVIDENCE)} pieces of evidence.` : null}
          onClick={() => {
            setRows([...rows, emptyRow("statement")]);
          }}
          testId="verification-evidence-add"
        >
          <Plus size={16} strokeWidth={1.75} aria-hidden />
          Add evidence
        </ActionButton>
        <span className={styles.spacer} />
        <ActionButton
          tooltip="Cancel"
          hint="Closes the form. Nothing is sent."
          onClick={() => {
            setOpen(false);
          }}
          testId="verification-request-cancel"
        >
          Cancel
        </ActionButton>
        <ActionButton
          kind="primary"
          tooltip="Send the request"
          hint="A Horizon admin reviews it and gives a one-sentence reason your team can read."
          whyDisabled={busy ? "A request is on its way." : problem}
          onClick={() => {
            onSend(rows);
          }}
          testId="verification-request-send"
        >
          Send request
        </ActionButton>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------ disputes

export function EvidenceList({ evidence, testId }: { evidence: ReadonlyArray<{ kind: EvidenceKind; summary: string; url?: string; at: Date }>; testId?: string }) {
  if (evidence.length === 0) return <p className={styles.hint}>No evidence yet.</p>;
  return (
    <ul className={styles.list} data-testid={testId}>
      {evidence.map((e, index) => (
        <li key={index} className={styles.listItem}>
          <span className={styles.meta}>
            <span>{EVIDENCE_KIND_WORDS[e.kind].label}</span>
            <span className={styles.mono}>{dayWords(e.at)}</span>
          </span>
          <span>{e.summary}</span>
          {e.url === undefined ? null : <EvidenceAddress url={e.url} />}
        </li>
      ))}
    </ul>
  );
}

function DisputeCard({
  view,
  now,
  teamId,
  canManage,
  busy,
  onEvidence,
  onAppeal,
}: {
  view: DisputeView;
  now: Date;
  teamId: string;
  canManage: boolean;
  busy: boolean;
  onEvidence: (row: EvidenceRow) => void;
  onAppeal: (reason: string) => void;
}) {
  const [row, setRow] = useState<EvidenceRow>(emptyRow("statement"));
  const [appealing, setAppealing] = useState(false);
  const [reason, setReason] = useState("");
  const lost = view.firstWinner !== null && view.firstWinner !== teamId;
  const rowProblem = requestProblem([row], 1);
  return (
    <div className={styles.section} data-testid={`verification-dispute-${view.id}`}>
      <h4 className={styles.sectionHead}>{`Review of ${String(view.teamNumber)}`}</h4>
      <p className={styles.sentence}>{view.state}</p>
      <div className={styles.sides}>
        {view.sides.map((side) => (
          <div key={side.teamId} className={styles.side}>
            <p className={styles.sideName}>{side.name}</p>
            <p className={styles.hint}>{side.role === "holder" ? "Claimed the number first" : "Claimed it second"}</p>
            <EvidenceList evidence={side.evidence} testId={`verification-dispute-evidence-${side.role}`} />
          </div>
        ))}
      </div>
      {view.decision === null ? null : <p className={styles.sentence} data-testid="verification-dispute-decision">{`Decision: ${view.decision}`}</p>}
      {view.appeal === null ? null : <p className={styles.prose}>{view.appeal}</p>}
      {view.appealDecision === null ? null : <p className={styles.sentence}>{`Appeal decision, final: ${view.appealDecision}`}</p>}

      {canManage && view.takesEvidence ? (
        <div className={styles.section}>
          <h4 className={styles.sectionHead}>Add your evidence</h4>
          <EvidenceRows rows={[row]} onChange={(rows) => { setRow(rows[0] ?? emptyRow()); }} testId="verification-dispute-add" removable={false} />
          <div className={styles.row}>
            <ActionButton
              tooltip="Add this evidence"
              hint="Both teams and the reviewer see it. Nothing sent here is private to the reviewer."
              whyDisabled={busy ? "A request is on its way." : rowProblem}
              onClick={() => {
                onEvidence(row);
                setRow(emptyRow("statement"));
              }}
              testId="verification-dispute-add-send"
            >
              Add evidence
            </ActionButton>
          </div>
        </div>
      ) : null}

      {canManage && view.whyNoAppeal === null ? (
        appealing ? (
          <div className={styles.section} data-testid="verification-appeal-form">
            <TextArea
              label="Why the decision is wrong"
              tooltip="Both teams and the reviewer read this. Say what the first decision missed."
              value={reason}
              onChange={setReason}
              testId="verification-appeal-reason"
            />
            <div className={styles.row}>
              <ActionButton
                tooltip="Cancel"
                hint="Closes the appeal. Nothing is sent."
                onClick={() => {
                  setAppealing(false);
                }}
              >
                Cancel
              </ActionButton>
              <ActionButton
                kind="primary"
                tooltip="Send the appeal"
                hint="Your one appeal. A Horizon admin decides it, possibly the one who decided first, and that decision is final."
                whyDisabled={busy ? "A request is on its way." : reason.trim() === "" ? "Say why the decision is wrong first." : null}
                onClick={() => {
                  onAppeal(reason.trim());
                }}
                testId="verification-appeal-send"
              >
                Send appeal
              </ActionButton>
            </div>
          </div>
        ) : (
          <div className={styles.row}>
            <ActionButton
              tooltip="Appeal"
              hint={`One appeal, decided by a Horizon admin. ${appealWindowWords(view.appealClosesAt, now)}`}
              onClick={() => {
                setAppealing(true);
              }}
              testId="verification-appeal"
            >
              Appeal
            </ActionButton>
          </div>
        )
      ) : null}
      {lost && view.whyNoAppeal !== null && view.appeal === null ? <p className={styles.hint}>{view.whyNoAppeal}</p> : null}
    </div>
  );
}

// ------------------------------------------------------------------------ history

export function History({ claim, names }: { claim: Claim | null; names: TeamNames }) {
  const rows = historyRows(claim, names);
  if (rows.length === 0) return null;
  return (
    <div className={styles.section}>
      <h4 className={styles.sectionHead}>{`History of ${String(claim?.teamNumber ?? "")}`}</h4>
      <ol className={styles.list} data-testid="verification-history">
        {rows.map((row) => (
          <li key={row.key} className={styles.listItem}>
            <span className={styles.meta}>
              <span className={styles.mono}>{row.day}</span>
            </span>
            <span>{row.sentence}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
