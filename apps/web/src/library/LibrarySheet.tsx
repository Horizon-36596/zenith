/**
 * The team library (spec 13 section 5): the team's autos, each with its sharing chip (section 8.4),
 * and every revision of each, with its number, author, time, the revision it was published from,
 * git commit and a Diverged badge; Publish to the team library; Open in project; Download project; Compare,
 * which opens two revisions in the review view (section 5.3); and Keep for offline (section 6).
 */
import { useState } from "react";
import { LibraryBig } from "lucide-react";
import type { AutoRecord, Revision } from "@horizon36596/zenith-cloud";
import { Sheet, SheetButton } from "../cloud/controls";
import { EmptyState, LoadingLine, OfflineLine } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { useFeature } from "../state/features";
import { useEditor } from "../state/store";
import { Feedback } from "../account/Feedback";
import { StatusChip } from "../account/chips";
import { whyCannotEditSettings, whyCannotOpenLibrary, whyCannotPublish } from "../account/permissions";
import { account, editorDirty, useAccount } from "../account/store";
import { KeyWaiting, useWaitingForKey } from "../account/TeamKeys";
import { teamLabel, timeAgo, whenWords } from "../account/words";
import styles from "../account/account.module.css";
import { downloadProject, openRevisionInProject, openRevisionReview, publishOpenAuto } from "./actions";
import { LibraryShareChip } from "./LibraryShareChip";
import { openDivergence, revisionRows, siblingsOf, whyCannotPublishFile } from "./libraryModel";
import { countOf } from "../lib/format";

/** Why the library cannot act on a device that is waiting for the team key. */
const WAITING_WHY = "This device does not have the team key yet. A teammate approves it first.";

export function LibrarySheet() {
  const state = useAccount();
  const editor = useEditor();
  const role = account.role();
  const team = state.memberships.find((m) => m.teamId === state.teamId)?.team ?? null;
  const waiting = useWaitingForKey();
  const closed = whyCannotOpenLibrary(role) ?? (waiting ? WAITING_WHY : null);
  const fileWhy = whyCannotPublishFile({
    fileName: editor.fileName,
    savedCanonical: editor.savedCanonical,
    dirty: editorDirty(editor),
    reviewing: editor.review !== null,
  });
  const publishWhy = whyCannotPublish(role) ?? fileWhy ?? (state.busy ? "Publishing already." : null);
  const { autos, revisions, loaded, readError } = state.library;
  const hasRevisions = autos.some((auto) => (revisions[auto.id]?.length ?? 0) > 0);
  const settingsWhy = whyCannotEditSettings(role);
  const publishOnSave = state.team?.settings.publishOnSave ?? false;

  return (
    <Sheet
      title="Team library"
      help="library"
      testId="library-sheet"
      widthPx={460}
      onClose={() => {
        account.close();
      }}
      lead={
        <div className={styles.stack}>
          <div className={styles.row}>
            <span className={styles.lead}>{teamLabel(team)}</span>
            {team === null ? null : <StatusChip status={team.status} />}
          </div>
          <div className={styles.row}>
            <SheetButton
              kind="primary"
              tooltip="Publish to the team library"
              hint={
                editor.fileName === null
                  ? undefined
                  : `Adds the saved ${editor.fileName} to the library as a new revision. Nothing is overwritten.`
              }
              whyDisabled={closed ?? publishWhy}
              testId="library-publish"
              onClick={() => void publishOpenAuto()}
            >
              Publish to the team library
            </SheetButton>
            <SheetButton
              tooltip="Keep for offline"
              hint="Fetches every auto and revision now, so the library opens at an event with no Wi-Fi."
              whyDisabled={
                closed ??
                (state.sharedComputer ? "This is marked as a shared computer, so nothing is kept offline here." : null)
              }
              testId="library-save-offline"
              onClick={() => void account.saveForOffline()}
            >
              Keep for offline
            </SheetButton>
            <SheetButton
              tooltip="Download project"
              hint="The newest revision of every auto, with the robot and field, as one zip. Open files reads it back; add a deploy section to its zenith.json to deploy from it."
              whyDisabled={closed ?? (hasRevisions ? null : "The library has no revisions yet.")}
              testId="library-download"
              onClick={() => {
                downloadProject(teamLabel(team));
              }}
            >
              Download project
            </SheetButton>
          </div>
          <Tooltip
            label="Publish on every save"
            hint={
              settingsWhy === null
                ? "A team setting: each save of an auto also publishes it as a new revision."
                : `Unavailable: ${settingsWhy} It is ${publishOnSave ? "on" : "off"} for this team.`
            }
          >
            <label className={styles.inlineLabel}>
              <input
                className={styles.checkbox}
                type="checkbox"
                checked={publishOnSave}
                aria-disabled={settingsWhy !== null}
                disabled={settingsWhy !== null}
                data-testid="library-publish-on-save"
                onChange={(event) => void account.updateSettings({ publishOnSave: event.target.checked })}
              />
              Publish on every save
            </label>
          </Tooltip>
          {state.online ? null : (
            <OfflineLine testId="library-offline">This computer is offline. What you saved for offline opens, and a publish waits in the Outbox.</OfflineLine>
          )}
        </div>
      }
    >
      {waiting ? (
        <KeyWaiting />
      ) : closed !== null ? (
        <p className={styles.prose}>{closed}</p>
      ) : !loaded ? (
        <LoadingLine
          line="Reading the library…"
          error={readError}
          onRetry={() => void account.refreshLibrary()}
          testId="library-loading"
        />
      ) : (
        <>
          {/* A later read failed: say so above what the last read found. */}
          {readError === null ? null : (
            <LoadingLine line="" error={readError} onRetry={() => void account.refreshLibrary()} testId="library-reread" />
          )}
          {autos.length === 0 ? (
            <EmptyState
              icon={LibraryBig}
              headline="No autos in the library yet"
              line="Publish current auto, above, adds the saved auto here. Each publish after it adds a revision."
              testId="library-empty"
            />
          ) : (
            <ul className={styles.list} data-testid="library-autos">
              {autos.map((auto) => (
                <AutoHistory key={auto.id} auto={auto} revisions={revisions[auto.id] ?? []} />
              ))}
            </ul>
          )}
        </>
      )}
      <Feedback />
    </Sheet>
  );
}

function AutoHistory({ auto, revisions }: { auto: AutoRecord; revisions: Revision[] }) {
  const partners = useFeature("partners");
  const state = useAccount();
  const [open, setOpen] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const members = state.team?.members ?? [];
  const base = account.baseOf(auto.id);
  const rows = revisionRows(revisions, members, base);
  const waiting = openDivergence(revisions);
  const nowMs = Date.now();
  const slug = auto.title
    .replace(/\.auto\.json$/, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase();

  const compare = (ids: readonly string[]) => {
    const [first, second] = ids;
    if (first === undefined || second === undefined) return;
    setPicked([]);
    openRevisionReview(auto.id, auto.title, [first, second]);
  };

  /** The pair a diverged row is compared with: this device's own first, so "mine" is on the left. */
  const pairFor = (id: string): [string, string] | null => {
    const sibling = siblingsOf(revisions, id)[0];
    if (sibling === undefined) return null;
    return base === sibling.id ? [sibling.id, id] : [id, sibling.id];
  };

  return (
    <li className={styles.item} data-testid={`library-auto-${slug}`}>
      <div className={styles.itemMain}>
        <span className={styles.itemTitle}>{auto.title}</span>
        <span className={styles.itemMeta}>
          {partners ? <LibraryShareChip autoId={auto.id} testId={`library-auto-${slug}-sharing`} /> : null}
          <span>
            {rows.length} revision{rows.length === 1 ? "" : "s"}
          </span>
          {waiting.length === 0 ? null : (
            <Tooltip
              label="Diverged"
              hint={`${countOf(waiting.length, "revision was", "revisions were")} published from the same one. Review them to keep one; nothing is lost either way.`}
            >
              <span className={styles.chip} data-tone="warn" tabIndex={0} data-testid={`library-auto-${slug}-diverged`}>
                Diverged
              </span>
            </Tooltip>
          )}
        </span>
      </div>
      <div className={styles.itemActions}>
        {waiting.length === 0 ? null : (
          <SheetButton
            kind="text"
            tooltip="Review the diverged revisions"
            hint="Opens both in the review view, one drawn over the other, with Keep mine, Keep theirs and Open in project."
            testId={`library-auto-${slug}-review`}
            onClick={() => {
              const [a, b] = waiting;
              if (a === undefined || b === undefined) return;
              compare(base === b.id ? [b.id, a.id] : [a.id, b.id]);
            }}
          >
            Review
          </SheetButton>
        )}
        <SheetButton
          kind="text"
          tooltip={open ? "Hide revisions" : "Show revisions"}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? "Hide" : "Show"}
        </SheetButton>
      </div>
      {open ? (
        <div className={styles.itemFollowUp}>
          <ul className={`${styles.list} ${styles.wide}`} data-testid={`library-revisions-${slug}`}>
            {rows.map((row) => {
              const revision = revisions.find((r) => r.id === row.id);
              const isPicked = picked.includes(row.id);
              const pair = row.diverged ? pairFor(row.id) : null;
              const sibling = siblingsOf(revisions, row.id)[0];
              const siblingWords =
                sibling === undefined
                  ? ""
                  : ` So was the other revision ${String(sibling.n)}, by ${
                      members.find((m) => m.uid === sibling.author)?.displayName ?? "a former member"
                    }.`;
              return (
                <li
                  key={row.id}
                  className={styles.item}
                  data-testid={`revision-${slug}-${String(row.n)}${row.diverged ? "-diverged" : ""}`}
                >
                  <div className={styles.itemMain}>
                    <span className={styles.itemTitle}>
                      Revision <span className={styles.mono}>{row.n}</span>
                      {row.latest ? " (newest)" : ""}
                    </span>
                    <span className={styles.itemMeta}>
                      <span>{row.authorName}</span>
                      <Tooltip label={whenWords(row.createdAt)}>
                        <span tabIndex={0}>{timeAgo(row.createdAt, nowMs)}</span>
                      </Tooltip>
                      {row.baseN === null ? (
                        <span data-testid="revision-base">first revision</span>
                      ) : (
                        <Tooltip
                          label={`From revision ${String(row.baseN)}`}
                          hint={`Published from revision ${String(row.baseN)}: the revision it was edited from.`}
                        >
                          <span tabIndex={0} data-testid="revision-base">
                            from revision <span className={styles.mono}>{row.baseN}</span>
                          </span>
                        </Tooltip>
                      )}
                      {row.gitSha === null ? null : (
                        <Tooltip
                          label="Git commit"
                          hint="The commit of the robot repository this revision was published from."
                        >
                          <span className={`${styles.chip} ${styles.mono}`} tabIndex={0}>
                            {row.gitSha}
                          </span>
                        </Tooltip>
                      )}
                      {row.diverged ? (
                        <Tooltip
                          label="Diverged"
                          hint={`Published from revision ${String(row.baseN ?? row.n - 1)}.${siblingWords} Both are kept; compare them to keep one.`}
                        >
                          <span className={styles.chip} data-tone="warn" tabIndex={0} data-testid="revision-diverged">
                            Diverged
                          </span>
                        </Tooltip>
                      ) : null}
                      {row.isBase ? (
                        <Tooltip
                          label="Your base"
                          hint="The revision this computer last published or opened: the next publish builds on it."
                        >
                          <span className={styles.chip} data-tone="accent" tabIndex={0}>
                            Your base
                          </span>
                        </Tooltip>
                      ) : null}
                    </span>
                  </div>
                  <div className={styles.itemActions}>
                    <SheetButton
                      kind="text"
                      tooltip="Open in project"
                      hint="Writes this revision into the open folder, ready to commit; a read-only project opens it unsaved."
                      testId={`revision-${slug}-${String(row.n)}-open`}
                      onClick={() => {
                        if (revision !== undefined) void openRevisionInProject(auto.title, revision);
                      }}
                    >
                      Open
                    </SheetButton>
                    {row.diverged ? (
                      <SheetButton
                        kind="text"
                        tooltip="Compare with the one it diverged from"
                        hint="Opens both in the review view, one drawn over the other, with the steps that differ and a choice of which to keep."
                        whyDisabled={pair === null ? "Its sibling is not in the library." : null}
                        testId={`revision-${slug}-${String(row.n)}-compare`}
                        onClick={() => {
                          if (pair !== null) compare(pair);
                        }}
                      >
                        Compare
                      </SheetButton>
                    ) : null}
                    <Tooltip label="Pick to compare" hint="Pick two revisions to open them in the review view.">
                      <input
                        className={styles.checkbox}
                        type="checkbox"
                        aria-label={`Pick revision ${String(row.n)} to compare`}
                        checked={isPicked}
                        onChange={() => {
                          const next = isPicked ? picked.filter((id) => id !== row.id) : [...picked, row.id].slice(-2);
                          setPicked(next);
                          if (next.length === 2) compare(next);
                        }}
                      />
                    </Tooltip>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </li>
  );
}
