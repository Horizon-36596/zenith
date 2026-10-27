/**
 * The share dialog (spec 13 sections 8.1 to 8.5), as a non-modal sheet.
 *
 * It leads with the one sentence of section 8.4, which updates with every control. Below it: who
 * (specific teams, or anyone with the link), what they can do (view, or propose), which version
 * (this one, or follow the latest), and until when. "See it as they will" shows exactly what would
 * be sent before anything is. An anyone-with-the-link share takes a second step that says, in so
 * many words, that anyone who gets the link can see it without signing in.
 */
import { useEffect, useId, useRef, useState } from "react";
import { CloudUpload, Copy, Plus, TriangleAlert, X } from "lucide-react";
import { shareSentence } from "@horizon36596/zenith-core";
import { LoadingLine, OfflineLine } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { useSim } from "../state/sim";
import { useCopy } from "../app/copyText";
import { useDerived, useEditor } from "../state/store";
import { account, useAccount } from "../account/store";
import { PUBLIC_APP_URL, isWebPage } from "../account/config";
import { whyCannotPublish } from "../account/permissions";
import { FirstShareSafetyCode, KeyChangedWarning, NumberChangedWarning } from "../account/keys";
import { KeyWaiting, useWaitingForKey } from "../account/TeamKeys";
import { publishOpenAuto, whyCannotPublishOpenAuto } from "../library/actions";
import type { LibraryStatus } from "../library/libraryModel";
import { libraryAutoIdOf, openAutoStatus } from "./openAuto";
import { OutboxNotice } from "./OutboxNotice";
import { ProjectionPreview } from "./ProjectionPreview";
import { buildProjection, type BuiltProjection, type ProjectionSource } from "./projectionModel";
import {
  DEFAULT_DRAFT,
  addTeam,
  draftProjectionChoice,
  draftSettings,
  draftToRequest,
  parseTeamNumber,
  removeTeam,
  shareActorOf,
  shareLink,
  shareLinkBase,
  utcOffsetAt,
  whyCannotMakeShare,
  whyCannotShare,
  withAudience,
  type ExpiryChoice,
  type ShareDraft,
} from "./shareModel";
import { Segmented, type SegmentOption } from "../components/Segmented";
import { Sheet, SheetButton } from "./controls";
import { STOPPED_SHARES, autoNameOf, draftLeadWords, sentenceFor } from "./words";
import { shareAgainDraft } from "./stoppedSharesModel";
import {
  checkPartnerKeys,
  closeSharingSheet,
  cloudNow,
  createShare,
  openSharingSheet,
  sharesOf,
  useCloud,
} from "./store";
import { NO_ANSWERS, answerOptions, answered, withAnswer, type KeyAnswers } from "./keyAnswers";
import type { OutboxEntry } from "@horizon36596/zenith-cloud";
import type { Audience, Level, Mode, PartnerKeyWarning, PendingShareResult, Share } from "./types";
import styles from "./cloud.module.css";

/** Which expiry option is pressed, as the segmented switch names it. */
type ExpiryKey = "1" | "7" | "30" | "date";

const EXPIRY_OPTIONS: ReadonlyArray<SegmentOption<ExpiryKey>> = [
  { value: "1", label: "1 day", does: "The share ends 24 hours from now." },
  { value: "7", label: "7 days", does: "The share ends a week from now. This is the default." },
  { value: "30", label: "30 days", does: "The share ends 30 days from now." },
  {
    value: "date",
    label: "Until a date",
    does: "Pick the day the share ends, and a time if you want one. With no time it works until the end of that day.",
  },
];

const keyOf = (choice: ExpiryChoice): ExpiryKey =>
  choice.kind === "days" ? (String(choice.days) as ExpiryKey) : choice.kind;

function choiceOf(key: ExpiryKey, previous: ExpiryChoice, nowMs: number): ExpiryChoice {
  if (key === "date") {
    if (previous.kind === "date") return previous;
    // Start the picker a week out, the default, so the sentence has a date to say at once.
    const inAWeek = new Date(nowMs + 7 * 86_400_000);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return {
      kind: "date",
      date: `${String(inAWeek.getFullYear())}-${pad(inAWeek.getMonth() + 1)}-${pad(inAWeek.getDate())}`,
    };
  }
  return { kind: "days", days: Number(key) as 1 | 7 | 30 };
}

type Step = "edit" | "confirmLink" | "keyChanged" | "done";

/** Why the library does not yet hold the version a share would be made from, or null. */
function libraryProblem(status: LibraryStatus): string | null {
  switch (status.kind) {
    case "loading":
      return "Reading the team library…";
    case "unreadable":
      return status.why;
    case "unpublished":
      return "Publish this auto to your team library first.";
    case "changed":
      return `This auto has changes since revision ${String(status.n)}. Publish them first.`;
    case "published":
      return null;
  }
}

/**
 * The share dialog's first step for an auto the library does not hold as it is: a share is made
 * from a published revision (section 8.3), so the other team sees exactly that version.
 */
function PublishFirst({ status }: { status: LibraryStatus }) {
  const accountState = useAccount();
  if (status.kind === "published") return null;
  if (status.kind === "loading" || status.kind === "unreadable") {
    return (
      <LoadingLine
        line="Reading the team library…"
        error={status.kind === "unreadable" ? status.why : null}
        onRetry={() => void account.refreshLibrary()}
        testId="share-library-loading"
      />
    );
  }
  const why = whyCannotPublishOpenAuto() ?? whyCannotPublish(account.role());
  return (
    <section className={styles.section} aria-label="Publish first" data-testid="share-publish-first">
      <p className={styles.caution}>
        <TriangleAlert className={styles.cautionIcon} size={16} strokeWidth={1.75} aria-hidden />
        {status.kind === "unpublished"
          ? "Publish this auto to your team library first."
          : `This auto has changes that are not in the team library since revision ${String(status.n)}. Publish them first.`}
      </p>
      <div className={styles.row}>
        <SheetButton
          kind="primary"
          tooltip="Publish to the team library"
          hint="Adds a revision to the team library and changes nothing on disk. A share shows that revision."
          whyDisabled={accountState.busy ? "Publishing already." : why}
          onClick={() => {
            void publishOpenAuto();
          }}
          testId="share-publish"
        >
          <CloudUpload size={16} strokeWidth={1.75} aria-hidden />
          Publish to the team library
        </SheetButton>
      </div>
    </section>
  );
}

/**
 * How a share that was waiting for the connection went, once it is back: made (with the share as the
 * cloud now holds it), or not made and why. Null while it still waits, and for a share that never did.
 */
export function waitingOutcome(
  created: Share,
  pending: Readonly<Record<string, PendingShareResult>>,
  outbox: ReadonlyArray<Pick<OutboxEntry, "id" | "state" | "error">>,
): { ok: true; share: Share } | { ok: false; sentence: string } | null {
  if (created.waitsForConnection === true) {
    const result = pending[created.id];
    if (result === undefined) return null;
    return result.ok && result.share !== undefined ? { ok: true, share: result.share } : { ok: false, sentence: result.sentence };
  }
  if (created.queued !== true || created.outboxId === undefined) return null;
  const entry = outbox.find((item) => item.id === created.outboxId);
  if (entry === undefined || entry.state === "queued") return null;
  const { queued: _queued, outboxId: _outboxId, ...sent } = created;
  if (entry.state === "sent") return { ok: true, share: sent };
  const who = created.audience === "link" ? "the link" : teamsWords(created.teamNumbers);
  const why = entry.error ?? (entry.state === "dropped" ? "signing out dropped it before it was sent." : "the cloud refused it.");
  return { ok: false, sentence: `Did not share with ${who}: ${why}` };
}

/** "team 12345" or "teams 12345, 23456". */
const teamsWords = (numbers: readonly number[]): string => `${numbers.length === 1 ? "team" : "teams"} ${numbers.join(", ")}`;

export function ShareSheet() {
  const editor = useEditor();
  const cloud = useCloud();
  const accountState = useAccount();
  const status = openAutoStatus(editor, accountState);
  // "Share again" on a stopped share of the open auto starts from that share's settings.
  const [again] = useState(() => (cloud.shareAgain !== null && cloud.shareAgain.autoId === libraryAutoIdOf(status) ? cloud.shareAgain : null));
  const [draft, setDraft] = useState<ShareDraft>(() => (again === null ? DEFAULT_DRAFT : shareAgainDraft(again)));
  const [teamText, setTeamText] = useState("");
  const [teamError, setTeamError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const { copy: copyLink, label: copyLabel } = useCopy();
  const [step, setStep] = useState<Step>("edit");
  const [created, setCreated] = useState<Share | null>(null);
  /**
   * What to ask about the teams before sending, still to be answered: changed keys, numbers that
   * now lead to another team, and first shares; and what the person answered so far.
   */
  const [keyWarnings, setKeyWarnings] = useState<PartnerKeyWarning[]>([]);
  const [answers, setAnswers] = useState<KeyAnswers>(NO_ANSWERS);
  // Command names, the auto's name and which version are rarely changed, so they sit under More
  // options with their values on its line; a draft that already changes one opens it.
  const [moreOpen, setMoreOpen] = useState(() => draft.includeCommands || draft.includeTitle || draft.mode !== "pinned");
  const moreNow = [
    draft.includeCommands ? "Command names shown" : "Command names hidden",
    draft.includeTitle ? "Name shown" : "Name hidden",
    draft.mode === "follow" ? "Follows the latest version" : "This version",
  ].join(" · ");
  /** Why a share that waited for the connection was not made, once it is back, until the next send. */
  const [notMade, setNotMade] = useState<string | null>(null);
  const waiting = useWaitingForKey();

  // A share that waits for the connection, on this page or in the Outbox, is followed until it
  // goes: once made the sheet says it was shared, and once refused it goes back to the settings
  // with the reason and Share again, which checks the teams and shows any safety code first.
  const outcome = created === null ? null : waitingOutcome(created, cloud.pendingShares, accountState.outbox?.entries ?? []);
  useEffect(() => {
    if (outcome === null || created === null) return;
    if (outcome.ok) {
      setCreated(outcome.share);
      return;
    }
    setNotMade(outcome.sentence);
    setCreated(null);
    setStep("edit");
  }, [outcome, created]);

  const coarsenId = useId();
  const commandsId = useId();
  const titleId = useId();
  const titleHelpId = useId();

  // The projection is built from the same plan and instant-sim run the editor shows. The sheet is
  // only mounted while it is open, so an edit or a drag with it closed builds nothing, and
  // `buildProjection` keeps each result per sim run, so re-renders with it open rebuild nothing.
  const plan = useDerived().plan;
  const sim = useSim(plan, plan?.robot ?? null, plan?.field ?? null);
  const fresh: ProjectionSource | null =
    plan !== null && sim.trace !== null && !sim.stale ? { plan, trace: sim.trace } : null;
  // While the sim catches up with an edit, the preview keeps showing the last version it built.
  const lastSource = useRef<ProjectionSource | null>(null);
  if (fresh !== null) lastSource.current = fresh;
  const source = fresh ?? lastSource.current;
  const autoName = autoNameOf(editor);
  const built: BuiltProjection | null =
    source === null ? null : buildProjection(source, draftProjectionChoice(draft, autoName));
  const projectionProblem =
    plan === null
      ? "This auto has errors, so there is nothing to share yet. Fix them first."
      : sim.reason !== null && sim.trace === null
        ? `The instant sim could not run this auto: ${sim.reason}`
        : fresh === null
          ? "The preview is catching up with your last edit."
          : built !== null && !built.ok
            ? built.reason
            : null;

  const nowMs = cloudNow();
  const autoId = libraryAutoIdOf(status);
  const settings = draftSettings(draft, nowMs);
  const existing = sharesOf(cloud.shares, autoId).filter((share) => share.revokedAt === null).length;
  const sentence = draftLeadWords(settings, existing, shareSentence(settings, nowMs, { utcOffsetMinutes: utcOffsetAt(settings.expiresAt, nowMs) }));
  const roleProblem = whyCannotMakeShare(shareActorOf(accountState), settings);
  const blocked =
    editor.auto === null
      ? "Open an auto first."
      : waiting
        ? "This device does not have the team key yet. A teammate approves it first."
        : (libraryProblem(status) ?? roleProblem ?? whyCannotShare(draft, nowMs) ?? projectionProblem);
  const request =
    status.kind !== "published" || fresh === null || built === null || !built.ok
      ? null
      : draftToRequest(draft, status.autoId, { id: status.revisionId, n: status.n }, nowMs, built.canonical);

  const close = (): void => {
    closeSharingSheet();
  };

  const addTyped = (): void => {
    const result = parseTeamNumber(teamText, draft, cloud.session.teamNumber);
    if (!result.ok) {
      setTeamError(result.why);
      return;
    }
    setDraft(addTeam(draft, result.teamNumber));
    setTeamText("");
    setTeamError(null);
  };

  /**
   * Sends the share. For a share to teams it first checks each team's key against the one this
   * device used for it before (spec 14 section 4.6), and each number against the team this device
   * shared with under it. A changed key or number stops here with a warning, and a team this device
   * never shared with shows its safety code; each answer comes back here with that team answered.
   *
   * The cloud refuses a share that names a team whose safety code was never shown, which happens
   * when a number the check found no team for, or another team for, leads to a team at the send.
   * The dialog then checks the teams once more, which shows the code of the team each number leads
   * to now, or says that the number is nobody's; a second refusal in a row stays as the error.
   */
  const send = async (given: KeyAnswers = answers, checkedAgain = false): Promise<void> => {
    if (request === null || blocked !== null) return;
    setNotMade(null);
    if (request.audience === "teams") {
      const checked = await checkPartnerKeys(request.teamNumbers);
      if (!checked.ok) return;
      const open = checked.warnings.filter((warning) => !answered(given, warning));
      if (open.length > 0) {
        setKeyWarnings(open);
        setStep("keyChanged");
        return;
      }
    }
    const who = `${request.teamNumbers.length === 1 ? "team" : "teams"} ${request.teamNumbers.join(", ")}`;
    // Offline the share is saved on this computer and waits in the Outbox (spec 13 section 6), so
    // the status line must not say it was shared.
    const done = (created: Share): string =>
      created.waitsForConnection === true
        ? `Share waiting on this page. It is made for ${who} when this computer is back online.`
        : created.queued === true
          ? request.audience === "link"
            ? "Link saved on this computer. It works for others once this computer is back online and the Outbox sends it."
            : `Share saved on this computer. It reaches ${who} when this computer is back online and the Outbox sends it.`
          : request.audience === "link"
            ? "Link created. Anyone who has it can view this auto."
            : `Shared with ${who}.`;
    let codeNotShown = false;
    const share = await createShare(
      request,
      done,
      answerOptions(given),
      () => {
        codeNotShown = true;
      },
      again?.id,
    );
    if (share !== null) {
      setCreated(share);
      setStep("done");
      setAnswers(NO_ANSWERS);
    } else if (codeNotShown && !checkedAgain) {
      await send(given, true);
    }
  };

  const preview = (
    <section className={styles.section} aria-label="What they will get" data-testid="share-preview">
      <h3 className={styles.sectionHead}>What they will get</h3>
      {built === null || !built.ok || plan === null ? (
        <p className={styles.hint} data-testid="share-preview-none">
          {projectionProblem ?? "Nothing to show yet."}
        </p>
      ) : (
        <>
          {fresh === null ? <p className={styles.hint}>Catching up with your last edit.</p> : null}
          <ProjectionPreview
            projection={built.projection}
            canonical={built.canonical}
            bytes={built.bytes}
            field={plan.field}
          />
        </>
      )}
    </section>
  );

  if (step === "done" && created !== null) {
    // A link share's secret is its key: the link is the only place it goes (spec 14).
    // In the desktop app the page is zenith://app/, which nobody else can open, so the link is the public web app's (sweep D12).
    const base = isWebPage(window.location.href) ? shareLinkBase(window.location, import.meta.env.BASE_URL) : PUBLIC_APP_URL;
    const link = created.linkSecret === undefined ? "" : shareLink(created.linkSecret, base);
    return (
      <Sheet
        title={created.queued === true ? `Waiting to share ${autoName}` : `Shared ${autoName}`}
        help="share"
        testId="share-sheet"
        widthPx={480}
        onClose={close}
        lead={
          <p className={styles.sentence} data-testid="share-sentence">
            {sentenceFor(created, nowMs)}
          </p>
        }
        footer={
          <>
            <SheetButton
              tooltip="Open the Sharing page"
              hint="See every share and invite your team has made, and change or revoke any of them."
              onClick={() => {
                openSharingSheet("sharing");
              }}
              testId="share-open-page"
            >
              Open the Sharing page
            </SheetButton>
            <SheetButton kind="primary" tooltip="Close this panel" onClick={close} testId="share-done">
              Done
            </SheetButton>
          </>
        }
      >
        {created.waitsForConnection === true ? (
          <p className={styles.caution} role="status" data-testid="share-waits-for-connection">
            <TriangleAlert className={styles.cautionIcon} size={16} strokeWidth={1.75} aria-hidden />
            {`This computer is offline and has not looked up ${created.teamNumbers.length === 1 ? `team ${String(created.teamNumbers[0])}` : "those teams"} yet. The share is made and sent once it is back online, if this page is still open.`}
          </p>
        ) : created.queued === true ? (
          <OutboxNotice
            testId="share-queued"
            text={
              created.audience === "link"
                ? "This computer is offline, so the link is saved here and waits in the Outbox. Until it is sent, the link opens for nobody else."
                : `This computer is offline, so the share is saved here and waits in the Outbox. ${created.teamNumbers.length === 1 ? "That team" : "Those teams"} cannot see it until it is sent, when this computer is back online.`
            }
          />
        ) : null}
        {created.audience === "link" ? (
          <section className={styles.section} aria-label="The link">
            <h3 className={styles.sectionHead}>The link</h3>
            <div className={styles.row}>
              <span className={styles.link} data-testid="share-link">
                {link}
              </span>
              <SheetButton
                tooltip="Copy the link"
                hint="Put the link on the clipboard, to paste where you want to post it."
                onClick={() => {
                  void copyLink("the link", link, { select: document.querySelector('[data-testid="share-link"]') });
                }}
                testId="share-copy-link"
              >
                <Copy size={16} strokeWidth={1.75} aria-hidden />
                {copyLabel("Copy")}
              </SheetButton>
            </div>
          </section>
        ) : (
          <p className={styles.prose}>
            Members of {created.teamNumbers.length === 1 ? "that team" : "those teams"} can open it once
            they sign in.
          </p>
        )}
      </Sheet>
    );
  }

  const warning = keyWarnings[0];
  if (step === "keyChanged" && warning !== undefined) {
    // The person chose to send after reading this warning: ask the next, or send once none is left.
    const answer = (): void => {
      const next = withAnswer(answers, warning);
      setAnswers(next);
      const rest = keyWarnings.slice(1);
      setKeyWarnings(rest);
      if (rest.length === 0) void send(next);
    };
    const dontSend = (): void => {
      setKeyWarnings([]);
      setAnswers(NO_ANSWERS);
      setStep("edit");
    };
    return (
      <Sheet
        title={`Share ${autoName}`}
        help="share"
        testId="share-sheet"
        widthPx={480}
        onClose={close}
        lead={
          <p className={styles.sentence} data-testid="share-sentence">
            {sentence}
          </p>
        }
      >
        {warning.kind === "number-changed" ? (
          <NumberChangedWarning
            teamNumber={warning.teamNumber}
            teamName={warning.teamName}
            safetyCode={warning.safetyCode}
            previousTeamName={warning.previousTeamName ?? null}
            previousSafetyCode={warning.previousSafetyCode ?? null}
            busy={cloud.busy}
            onContinue={answer}
            onDontSend={dontSend}
          />
        ) : warning.kind === "first-use" ? (
          <FirstShareSafetyCode
            teamName={warning.teamName ?? `Team ${String(warning.teamNumber)}`}
            teamNumber={warning.teamName === null ? null : warning.teamNumber}
            safetyCode={warning.safetyCode}
            busy={cloud.busy}
            onShare={answer}
            onDontSend={dontSend}
          />
        ) : (
          <KeyChangedWarning
            teamName={warning.teamName ?? `Team ${String(warning.teamNumber)}`}
            teamNumber={warning.teamName === null ? null : warning.teamNumber}
            safetyCode={warning.safetyCode}
            busy={cloud.busy}
            onContinue={answer}
            onDontSend={dontSend}
          />
        )}
        {cloud.error === null ? null : <p className={styles.error}>{cloud.error}</p>}
      </Sheet>
    );
  }

  if (step === "confirmLink") {
    return (
      <Sheet
        title="Share with anyone who has the link?"
        help="share"
        testId="share-sheet"
        widthPx={480}
        onClose={close}
        lead={
          <p className={styles.caution} data-testid="share-link-warning">
            <TriangleAlert className={styles.cautionIcon} size={16} strokeWidth={1.75} aria-hidden />
            Anyone who gets this link will be able to see it, without signing in.
          </p>
        }
        footer={
          <>
            <SheetButton
              tooltip="Go back to the settings"
              hint="Nothing has been sent yet."
              onClick={() => {
                setStep("edit");
              }}
              testId="share-back"
            >
              Back
            </SheetButton>
            <SheetButton
              kind="primary"
              tooltip="Create the link"
              hint="Create the link now. You can revoke it from the Sharing page."
              whyDisabled={cloud.busy ? "Creating the link already." : blocked}
              onClick={() => {
                void send();
              }}
              testId="share-confirm-link"
            >
              Create the link
            </SheetButton>
          </>
        }
      >
        <p className={styles.sentence} data-testid="share-sentence">
          {sentence}
        </p>
        {cloud.error === null ? null : <p className={styles.error}>{cloud.error}</p>}
        {preview}
      </Sheet>
    );
  }

  const audienceOptions: ReadonlyArray<SegmentOption<Audience>> = [
    { value: "teams", label: "Specific teams", does: "Only signed-in members of the teams you name can open it." },
    {
      value: "link",
      label: "Anyone with the link",
      does: "Anyone you give the link to can view it, without signing in. It is never listed anywhere.",
    },
  ];
  const levelOptions: ReadonlyArray<SegmentOption<Level>> = [
    { value: "view", label: "View", does: "They can see where your robot drives and when. This is the default." },
    {
      value: "propose",
      label: "Propose changes",
      does: "They can also see the shape of your steps and send you changes, which you accept or reject one by one.",
      whyDisabled: draft.audience === "link" ? "A link is view only." : null,
    },
  ];
  const modeOptions: ReadonlyArray<SegmentOption<Mode>> = [
    {
      value: "pinned",
      label: "This version",
      does: "They see exactly this version, even after you publish a newer one. This is the default.",
    },
    {
      value: "follow",
      label: "Follow the latest version",
      does: "Each time you publish this auto, what they see updates to match.",
    },
  ];

  return (
    <Sheet
      title={`Share ${autoName}`}
      help="share"
      testId="share-sheet"
      widthPx={480}
      onClose={close}
      lead={
        <p className={styles.sentence} aria-live="polite" data-testid="share-sentence">
          {sentence}
        </p>
      }
      footer={
        <>
          <SheetButton tooltip="Close without sharing" hint="Nothing is sent." onClick={close} testId="share-cancel">
            Cancel
          </SheetButton>
          <SheetButton
            kind="primary"
            tooltip={draft.audience === "link" ? "Create a link" : "Share with these teams"}
            hint={
              draft.audience === "link"
                ? "Asks you to confirm first, because anyone with the link can see it."
                : "Send the share now. You can extend, change or revoke it from the Sharing page."
            }
            whyDisabled={cloud.busy ? "Sharing already." : blocked}
            onClick={() => {
              if (draft.audience === "link") setStep("confirmLink");
              else void send();
            }}
            testId="share-submit"
          >
            {draft.audience === "link" ? "Create a link" : notMade === null ? "Share" : "Share again"}
          </SheetButton>
        </>
      }
    >
      {notMade === null ? null : (
        <p className={styles.error} role="alert" data-testid="share-not-made">
          {notMade}
        </p>
      )}
      {accountState.online ? null : (
        <OfflineLine testId="share-offline">
          This computer is offline. A share waits on this computer and reaches the other team when you are back online.
        </OfflineLine>
      )}
      {waiting ? <KeyWaiting /> : <PublishFirst status={status} />}

      {again === null ? null : (
        <p className={styles.caution} data-testid="share-again-note">
          <TriangleAlert className={styles.cautionIcon} size={16} strokeWidth={1.75} aria-hidden />
          {STOPPED_SHARES.dialog}
        </p>
      )}

      {existing === 0 ? null : (
        <p className={styles.hint}>
          This auto already has {existing} {existing === 1 ? "share" : "shares"}.{" "}
          <SheetButton
            kind="text"
            tooltip="Open the Sharing page"
            hint="See this auto's shares on the Sharing page, with Show all for every share and invite your team has made."
            onClick={() => {
              openSharingSheet("sharing", { autoId });
            }}
          >
            See them on the Sharing page
          </SheetButton>
        </p>
      )}

      <section className={styles.section} aria-label="Who">
        <h3 className={styles.sectionHead}>Who</h3>
        <Segmented
          label="Who can open it"
          options={audienceOptions}
          value={draft.audience}
          onChange={(audience) => {
            setDraft(withAudience(draft, audience));
          }}
          testId="share-audience"
        />
        {draft.audience === "teams" ? (
          <>
            {draft.teamNumbers.length === 0 ? null : (
              <ul className={styles.teams} aria-label="Teams" data-testid="share-teams">
                {draft.teamNumbers.map((number) => (
                  <li key={number} className={styles.team} data-testid={`share-team-${String(number)}`}>
                    {number}
                    <Tooltip label={`Remove team ${String(number)}`}>
                      <button
                        type="button"
                        className={styles.chipButton}
                        aria-label={`Remove team ${String(number)}`}
                        onClick={() => {
                          setDraft(removeTeam(draft, number));
                        }}
                      >
                        <X size={12} strokeWidth={1.75} aria-hidden />
                      </button>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            )}
            <div className={styles.row}>
              <Tooltip label="Team number" hint="Type an FTC team number, then press Enter or Add team.">
                <input
                  className={styles.input}
                  inputMode="numeric"
                  placeholder="Team number"
                  aria-label="Team number"
                  value={teamText}
                  data-testid="share-team-input"
                  onChange={(event) => {
                    setTeamText(event.target.value);
                    setTeamError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addTyped();
                    }
                  }}
                />
              </Tooltip>
              <SheetButton
                tooltip="Add team"
                hint="Add this team to the share. Every member of the team will see the same thing."
                onClick={addTyped}
                testId="share-team-add"
              >
                <Plus size={16} strokeWidth={1.75} aria-hidden />
                Add team
              </SheetButton>
            </div>
            {teamError === null ? null : (
              <p className={styles.error} role="alert" data-testid="share-team-error">
                {teamError}
              </p>
            )}
          </>
        ) : null}
      </section>

      <section className={styles.section} aria-label="What they can do">
        <h3 className={styles.sectionHead}>What they can do</h3>
        <Segmented
          label="What they can do"
          options={levelOptions}
          value={settings.level}
          onChange={(level) => {
            setDraft({ ...draft, level });
          }}
          testId="share-level"
        />
      </section>

      <details
        className={styles.section}
        open={moreOpen}
        onToggle={(event) => {
          setMoreOpen(event.currentTarget.open);
        }}
        data-testid="share-more"
      >
        <summary className={styles.moreSummary} data-testid="share-more-options">
          More options
          {moreOpen ? null : (
            <span className={styles.moreNow} data-testid="share-more-now">
              {moreNow}
            </span>
          )}
        </summary>
        <div className={styles.more}>
        <section className={styles.section} aria-label="Command names" data-testid="share-commands">
          <h3 className={styles.sectionHead}>Command names</h3>
          <Tooltip
            label="Include command names"
            hint="Off by default: commands show as stand-ins such as cmd3. Turn it on if you do not mind a partner reading their names and settings."
          >
            <label className={styles.check} htmlFor={commandsId}>
              <input
                id={commandsId}
                type="checkbox"
                checked={draft.includeCommands}
                data-testid="share-include-commands"
                onChange={(event) => {
                  setDraft({ ...draft, includeCommands: event.target.checked });
                }}
              />
              Include command names
            </label>
          </Tooltip>

        </section>

        <section className={styles.section} aria-label="The auto's name" data-testid="share-title">
          <h3 className={styles.sectionHead}>The auto&apos;s name</h3>
          <Tooltip
            label="Include the auto's name"
            hint="Off by default: your partner sees this auto under your team's name only. Turn it on if you want them to see what you call it."
          >
            <label className={styles.check} htmlFor={titleId}>
              <input
                id={titleId}
                type="checkbox"
                checked={draft.includeTitle}
                aria-describedby={titleHelpId}
                data-testid="share-include-title"
                onChange={(event) => {
                  setDraft({ ...draft, includeTitle: event.target.checked });
                }}
              />
              Include the auto&apos;s name
            </label>
          </Tooltip>
          <p id={titleHelpId} className={styles.hint} data-testid="share-include-title-help">
            Your partner will see it named “{autoName}”.
          </p>
        </section>

        <section className={styles.section} aria-label="Which version">
          <h3 className={styles.sectionHead}>Which version</h3>
          <Segmented
            label="Which version they see"
            options={modeOptions}
            value={draft.mode}
            onChange={(mode) => {
              setDraft({ ...draft, mode });
            }}
            testId="share-mode"
          />
        </section>
        </div>
      </details>

      <section className={styles.section} aria-label="Until">
        <h3 className={styles.sectionHead}>Until</h3>
        <Segmented
          label="When the share ends"
          options={EXPIRY_OPTIONS}
          value={keyOf(draft.expiry)}
          onChange={(key) => {
            setDraft({ ...draft, expiry: choiceOf(key, draft.expiry, nowMs) });
          }}
          testId="share-expiry"
        />
        {draft.expiry.kind === "date" ? (
          <div className={styles.row}>
            <Tooltip label="The last day the share works" hint="Without a time, it works until the end of this day, on your clock.">
              <input
                type="date"
                className={styles.input}
                aria-label="The last day the share works"
                value={draft.expiry.date}
                data-testid="share-expiry-day"
                onChange={(event) => {
                  const expiry = draft.expiry.kind === "date" ? draft.expiry : { kind: "date" as const, date: "" };
                  setDraft({ ...draft, expiry: { ...expiry, date: event.target.value } });
                }}
              />
            </Tooltip>
            <Tooltip label="The time it ends, if you want one" hint="Leave it empty to share until the end of the day. The time is on your clock.">
              <input
                type="time"
                className={styles.input}
                aria-label="The time the share ends"
                value={draft.expiry.time ?? ""}
                data-testid="share-expiry-time"
                onChange={(event) => {
                  const expiry = draft.expiry.kind === "date" ? draft.expiry : { kind: "date" as const, date: "" };
                  setDraft({ ...draft, expiry: { ...expiry, time: event.target.value } });
                }}
              />
            </Tooltip>
          </div>
        ) : null}
      </section>

      <section className={styles.section} aria-label="See it as they will">
        <Tooltip
          label="Coarsen what they see"
          hint="Rounds positions to 2 in, headings to 5 degrees and times to 0.25 s: they see where and roughly when. The box is not rounded. Off by default."
        >
          <label className={styles.check} htmlFor={coarsenId}>
            <input
              id={coarsenId}
              type="checkbox"
              checked={draft.coarsen}
              data-testid="share-coarsen"
              onChange={(event) => {
                setDraft({ ...draft, coarsen: event.target.checked });
              }}
            />
            Coarsen what they see
          </label>
        </Tooltip>
        <div className={styles.row}>
          <SheetButton
            tooltip={showPreview ? "Hide what they will get" : "See it as they will"}
            hint="Show exactly what will be sent, before anything is."
            whyDisabled={editor.auto === null ? "Open an auto first." : null}
            onClick={() => {
              setShowPreview(!showPreview);
            }}
            testId="share-see-as-they-will"
          >
            {showPreview ? "Hide the preview" : "See it as they will"}
          </SheetButton>
        </div>

      </section>
      {showPreview ? preview : null}

      {cloud.error === null ? null : (
        <p className={styles.error} role="alert">
          {cloud.error}
        </p>
      )}
    </Sheet>
  );
}
