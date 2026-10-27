/**
 * The always-visible notes that hold a literal sentence (issue #238, UI_GUIDE section 9.13). An
 * explanation belongs in the description table (`descriptions/`), where it is linted and collapses
 * in Labels only; a `<p className={styles.note}>` with prose written into it in `panels/` or
 * `settings/` is the inline paragraph that table replaces. `help.test.ts` fails on a new one.
 *
 * `NOTE_LITERAL_ALLOWLIST` counts the sites each file had when the rule came in. Some are state,
 * warning, empty-state or tool-mode text, which stays; the rest are explanations the rewrite units
 * (issues #241, #242, #246) move into the table. Each of those lowers its file's count, and the test
 * fails when a count is higher than the file's sites, so the list only shrinks. The sheets and
 * dialogs are read by a second check further down, with each kept sentence listed under its class.
 */

/** The folders, under `apps/web/src`, the rule covers. */
export const NOTE_LITERAL_DIRS = ["panels", "settings"] as const;

/** Today's sites, per file under `apps/web/src`, with `/` separators. */
export const NOTE_LITERAL_ALLOWLIST: Readonly<Record<string, number>> = {
  "panels/EnvelopeSection.tsx": 2,
  "panels/WaypointSection.tsx": 1,
  "settings/ProjectPanes.tsx": 1,
  "settings/RobotPanes.tsx": 2,
};

const OPEN = /<p\s+className=\{styles\.note\}[^>]*>/g;
/** What `SHEET_OPEN` matches for a site `OPEN` already reads: it stops just after the class name. */
const NOTE_OPEN = /^<p\s+className=\{styles\.note$/;
/**
 * A quoted string or template literal that reads as prose: at least two words, or one word that
 * starts a sentence (a capital letter) or ends one (a full stop, question mark or exclamation mark).
 */
const PROSE_STRING = /(["'`])(?:[^"'`]*[A-Za-z]+\s+[A-Za-z]+[^"'`]*|\s*[A-Z][^"'`]*|[^"'`]*[A-Za-z][.!?]\s*)\1/;

/** Whether the inside of a note, up to its `</p>`, writes a sentence into the source. */
export function holdsLiteral(inside: string): boolean {
  // Text outside every `{…}` and every tag is JSX text: a literal however it is spelled. The name
  // and attributes of a child element (`<strong>`) are not text, so a value wrapped in one is not.
  let depth = 0;
  let inTag = false;
  let outside = "";
  for (const char of inside) {
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && char === "<") inTag = true;
    else if (depth === 0 && char === ">" && inTag) inTag = false;
    else if (depth === 0 && !inTag) outside += char;
  }
  if (/[A-Za-z]/.test(outside)) return true;
  return PROSE_STRING.test(inside);
}

/** How many notes with a literal each file has, for the files that have any. */
export function noteLiteralSites(files: ReadonlyArray<{ path: string; text: string }>): Record<string, number> {
  const sites: Record<string, number> = {};
  for (const { path, text } of files) {
    for (const match of text.matchAll(OPEN)) {
      const start = match.index + match[0].length;
      const end = text.indexOf("</p>", start);
      if (end === -1 || !holdsLiteral(text.slice(start, end))) continue;
      sites[path] = (sites[path] ?? 0) + 1;
    }
  }
  return sites;
}

/** What breaks the rule: a file with more sites than its allowance, or an allowance it no longer needs. */
export function noteLiteralProblems(
  sites: Readonly<Record<string, number>>,
  allowlist: Readonly<Record<string, number>> = NOTE_LITERAL_ALLOWLIST,
): string[] {
  const problems: string[] = [];
  for (const [path, count] of Object.entries(sites)) {
    const allowed = allowlist[path] ?? 0;
    if (count > allowed) {
      problems.push(
        `${path} has ${String(count)} <p className={styles.note}> with a literal sentence, ${String(allowed)} allowed: put an explanation in help/descriptions/, or pass state, a warning or an empty state in as a value`,
      );
    }
  }
  for (const [path, allowed] of Object.entries(allowlist)) {
    const count = sites[path] ?? 0;
    if (count < allowed) problems.push(`${path} is allowed ${String(allowed)} but has ${String(count)}: lower NOTE_LITERAL_ALLOWLIST`);
  }
  return problems;
}

/*
 * The sheets and dialogs (issue #248, UI_GUIDE section 9.13). They draw their own always-visible
 * sentences under many class names, not only `styles.note`, so the check here reads every `<p>` and
 * `<span>` whose class is one of `PROSE_CLASSES` and which writes a sentence into the source. Only
 * state, a warning or an empty state may do that, and each such site is listed in
 * `SHEET_NOTE_ALLOWLIST` with its class and its whole text. `settings/` is read here too, except the
 * `<p className={styles.note}>` sites the check above already counts. An explanation goes in a tooltip `hint=`, a `?` help entry or the
 * description table, and a sentence that restates its control's label is deleted.
 */

/** The folders, under `apps/web/src`, whose sheets and dialogs the check reads. */
export const SHEET_NOTE_DIRS = [
  "account",
  "admin",
  "cloud",
  "dialogs",
  "github",
  "library",
  "project",
  "proposals",
  "report",
  "settings",
] as const;

/**
 * What a sentence that may stay is: `state` says a fact the controls do not show, `warn` names a risk
 * or says why something cannot happen, and `empty` says what is missing.
 */
export type SheetNoteClass = "state" | "warn" | "empty";

export interface SheetNoteSite {
  /** The file under `apps/web/src`, with `/` separators. */
  file: string;
  kind: SheetNoteClass;
  /** The site's whole text as it is written in the source, with its whitespace made single spaces. */
  text: string;
}

/**
 * The class names that draw a sentence in these folders. The list is fixed, so a sentence under a
 * class that is not here is not read: a new prose class is added here when it comes in.
 */
export const PROSE_CLASSES = [
  "prose",
  "hint",
  "note",
  "paneNote",
  "empty",
  "emptyLine",
  "emptyHint",
  "lead",
  "sentence",
  "warn",
  "notice",
  "caution",
  "detail",
  "description",
  "rowDescription",
  "intro",
  "sub",
  "caption",
  "meta",
  "itemMeta",
  "rowMeta",
  "changeWhy",
  "stepDetail",
] as const;
const PROSE = PROSE_CLASSES.join("|");
/**
 * A `<p>` or `<span>` whose class is a prose class: a module class on any import name
 * (`styles.prose`, `dialogs.prose`, `accountStyles.hint`), one inside a template, or a plain string
 * class (`className="hint"`).
 */
const SHEET_OPEN = new RegExp(
  String.raw`<(p|span)\b(?:[^>{}]|\{[^}]*\})*?className=(?:\{(?:` +
    "`[^`]*?)?" +
    String.raw`[A-Za-z_$][\w$]*\.(?:${PROSE})\b|"(?:[^"]*\s)?(?:${PROSE})(?=[\s"]))`,
  "g",
);

/** The index just past the `>` that ends the tag opened at `from`, skipping a `>` inside `{…}`. */
function endOfOpeningTag(text: string, from: number): number {
  let depth = 0;
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
    else if (char === ">" && depth === 0) return at + 1;
  }
  return -1;
}

/** Every prose-class `<p>` and `<span>` in the files that writes a sentence, with the text it holds. */
export function sheetNoteSites(
  files: ReadonlyArray<{ path: string; text: string }>,
): Array<{ file: string; text: string }> {
  const found: Array<{ file: string; text: string }> = [];
  for (const { path, text } of files) {
    const readByNoteCheck = NOTE_LITERAL_DIRS.some((dir) => path.startsWith(`${dir}/`));
    for (const match of text.matchAll(SHEET_OPEN)) {
      // A `<p className={styles.note}>` in `panels/` or `settings/` is counted by the check above.
      if (readByNoteCheck && NOTE_OPEN.test(match[0])) continue;
      const tag = match[1] ?? "p";
      const start = endOfOpeningTag(text, match.index + match[0].length);
      if (start === -1) continue;
      const end = text.indexOf(`</${tag}>`, start);
      if (end === -1) continue;
      const inside = text.slice(start, end);
      if (!holdsLiteral(inside)) continue;
      found.push({ file: path, text: inside.replace(/\s+/g, " ").trim() });
    }
  }
  return found;
}

/** What breaks the rule: a sentence that is not listed, or a listed one that is no longer there. */
export function sheetNoteProblems(
  sites: ReadonlyArray<{ file: string; text: string }>,
  allowlist: readonly SheetNoteSite[] = SHEET_NOTE_ALLOWLIST,
): string[] {
  const problems: string[] = [];
  // Each entry covers one site whose whole text is the entry's text, so a longer sentence that starts
  // like a listed one, or a second copy of a listed one, is a new site.
  const unused = [...allowlist];
  for (const site of sites) {
    const at = unused.findIndex((entry) => entry.file === site.file && entry.text === site.text);
    if (at !== -1) {
      unused.splice(at, 1);
      continue;
    }
    problems.push(
      `${site.file} writes "${site.text.slice(0, 70)}" into an always-visible note: delete it, or move it to a tooltip hint, the ? help or the description table. Only state, a warning or an empty state may stay, and then it is listed in SHEET_NOTE_ALLOWLIST with its class`,
    );
  }
  for (const entry of unused) {
    problems.push(`${entry.file} no longer has "${entry.text.slice(0, 70)}": remove it from SHEET_NOTE_ALLOWLIST`);
  }
  return problems;
}

/** `state`: a fact the controls do not show, such as what a sheet is doing, who sent what, or what was found. */
const STATE: ReadonlyArray<readonly [file: string, text: string]> = [
  ["account/FakeUsers.tsx", "This page is fake device {String(device.index + 1)} of {String(device.count)}."],
  ["account/SignInSheet.tsx", "Sign in to join the team that sent you this link."],
  ["account/SignInSheet.tsx", "Type <span className={styles.mono} data-testid=\"signin-device-code\">{progress.userCode}</span> on{\" \"} <a className={styles.textLink} href={progress.verificationUri} target=\"_blank\" rel=\"noreferrer\"> GitHub&apos;s page </a> , then come back here."],
  ["account/SignInSheet.tsx", "Finish signing in in your browser, then come back here."],
  ["account/SignInSheet.tsx", "Check your email. The link to sign in went to <span className={styles.mono}>{state.emailSentTo}</span>."],
  ["account/SignInSheet.tsx", "This link was opened on a different computer. Type the email address it was sent to."],
  ["account/SignInSheet.tsx", "Send your user code to a Horizon (FTC 36596) admin, then press Check again."],
  ["account/SignInSheet.tsx", "{join.joinedAs === \"pending\" ? `You asked to join ${join.teamName ?? \"the team\"}. An owner or admin has to approve you.` : `You joined ${join.teamName ?? \"the team\"} as ${ROLE_WORDS[join.joinedAs].toLowerCase()}.`}"],
  ["account/SignInSheet.tsx", "Join <strong>{teamLabel({ number: join.teamNumber, name: join.teamName ?? \"a team\" })}</strong> as{\" \"} {ROLE_WORDS[invite.role].toLowerCase()}."],
  ["account/SignInSheet.tsx", "{invite.autoApprove ? \"The invite lets you in at once.\" : \"An owner or admin approves you first.\"}"],
  ["account/TeamKeys.tsx", "<span>approved {timeAgo(device.approvedAt, nowMs)}"],
  ["account/TeamsSheet.tsx", "You are not in a team yet."],
  ["account/TeamsSheet.tsx", "The number shows as unverified until a Horizon admin checks it."],
  ["account/TeamsSheet.tsx", "Your membership is waiting for approval."],
  ["account/TeamsSheet.tsx", "{endsMs === null ? \"Pick when the invite ends.\" : `Ends ${whenWords(new Date(endsMs))}.`}{\" \"} {inviteRole === \"viewer\" ? \"A\" : \"An\"} {ROLE_WORDS[inviteRole].toLowerCase()} invite for{\" \"} {uses === 1 ? \"one person\" : `${maxUses} people`} {autoApprove ? \", let in at once.\" : \", each approved by an owner or admin.\"}"],
  ["admin/AdminPage.tsx", "A photo should show the code <span className={styles.mono} data-testid=\"admin-claim-code\">{claimCode(request.teamId, request.teamNumber)}</span> on a card."],
  ["admin/AdminPage.tsx", "{side.role === \"holder\" ? \"Claimed the number first\" : \"Claimed it second\"}"],
  ["admin/AdminPage.tsx", "{`First decision: ${view.decision}`}"],
  ["admin/BetaAccess.tsx", "Nobody can remove themselves."],
  ["admin/BugReports.tsx", "{`Sent ${whenWords(report.createdAt)}`}"],
  ["admin/BugReports.tsx", "{`Marked ${whenWords(report.updatedAt)}`}"],
  ["admin/BugReports.tsx", "The reporter did not include their auto file."],
  ["admin/VerificationSection.tsx", "{team?.number == null ? \"Your team has no FTC number yet.\" : `FTC ${String(team.number)}: ${badge.meaning}`}"],
  ["admin/VerificationSection.tsx", "For a photo, write <span className={styles.mono} data-testid=\"verification-claim-code\">{code}</span> on a card and hold it next to your robot. Paste a link: Zenith stores no files."],
  ["admin/VerificationSection.tsx", "{side.role === \"holder\" ? \"Claimed the number first\" : \"Claimed it second\"}"],
  ["admin/VerificationSection.tsx", "{`Decision: ${view.decision}`}"],
  ["admin/VerificationSection.tsx", "{`Appeal decision, final: ${view.appealDecision}`}"],
  ["cloud/ProjectionPreview.tsx", "Named “{projection.title}”"],
  ["cloud/ProjectionPreview.tsx", "{phase === null ? \"Between phases.\" : `${PHASE_WORDS[phase]} at this moment.`}"],
  ["cloud/ReceivedShares.tsx", "{entry.kept ? \"Kept for offline on this computer\" : \"Opened on this computer\"}"],
  ["cloud/SharedAutoViewer.tsx", "Read only. {version}"],
  ["cloud/ShareSheet.tsx", "Catching up with your last edit."],
  ["cloud/ShareSheet.tsx", "Members of {created.teamNumbers.length === 1 ? \"that team\" : \"those teams\"} can open it once they sign in."],
  ["cloud/ShareSheet.tsx", "This auto already has {existing} {existing === 1 ? \"share\" : \"shares\"}.{\" \"} <SheetButton kind=\"text\" tooltip=\"Open the Sharing page\" hint=\"See this auto's shares on the Sharing page, with Show all for every share and invite your team has made.\" onClick={() => { openSharingSheet(\"sharing\", { autoId }); }} > See them on the Sharing page </SheetButton>"],
  ["cloud/ShareSheet.tsx", "Your partner will see it named “{autoName}”."],
  ["cloud/SharingPage.tsx", "<span> Showing shares of <span data-testid=\"sharing-filter-auto\">{filterName}</span> </span> <span aria-hidden>·</span> <SheetButton kind=\"text\" tooltip=\"Show all\" hint={`List every share and invite ${team} has made, not only those of ${filterName}.`} onClick={showAllShares} testId=\"sharing-filter-show-all\" > Show all </SheetButton>"],
  ["cloud/TimeRequests.tsx", "{last.status === \"open\" ? `Asked for more time ${timeAgo(new Date(last.requestedAt), nowMs)}; waiting for ${fromTeam}.` : last.status === \"granted\" ? `${fromTeam} gave more time${last.grantedUntil === null ? \"\" : `, until ${endWords(last.grantedUntil, nowMs)}`}.` : `${fromTeam} declined more time. You may ask again.`}"],
  ["cloud/TimeRequests.tsx", "<span>Ended or revoked"],
  ["dialogs/Dialogs.tsx", "Read only: Save asks where to put your copy."],
  ["dialogs/Dialogs.tsx", "It writes {trace}"],
  ["dialogs/ImportCommandsDialog.tsx", "Adds what <code className=\"mono\">{project.link.robot}</code> is missing from your robot&apos;s registered commands and conditions. Nothing you wrote there changes. New commands get an estimate of &quot;unknown&quot;."],
  ["dialogs/SaveChoiceDialog.tsx", "{isExample ? \"The example is read only.\" : \"These files were opened read only.\"} Choose where{\" \"} <code className={`mono ${styles.file}`}>{fileName}</code> goes."],
  ["dialogs/SaveChoiceDialog.tsx", "<code className={`mono ${styles.file}`}>{fileName}</code> follows {followed === 1 ? \"1 waypoint\" : `${String(followed)} waypoints`} by name. {counts}"],
  ["dialogs/SaveChoiceDialog.tsx", "The auto drives where it does now. {project}&apos;s waypoints.json is not changed."],
  ["dialogs/SaveChoiceDialog.tsx", "With the poses they have here. None already there change.{differsOwn}"],
  ["dialogs/SaveChoiceDialog.tsx", "The {differs === 1 ? \"one\" : \"ones\"} somewhere else follow{differs === 1 ? \"s\" : \"\"} {project}&apos;s, so there the robot drives to the {differs === 1 ? \"pose\" : \"poses\"} listed for {project}.{missingOwn}"],
  ["dialogs/SetupDialog.tsx", "<code className=\"mono\">{folder}</code> has no <code className=\"mono\">zenith.json</code>, so Zenith is not set up there yet."],
  ["dialogs/SetupDialog.tsx", "Wrote {written.join(\", \")}."],
  ["dialogs/UnsavedDialog.tsx", "{unsavedPrompt.lead ?? `${unsavedPrompt.fileName} has edits that are not saved.`} {unsavedPrompt.next}"],
  ["dialogs/WaypointDialog.tsx", "A new waypoint at {question.pose.xIn.toFixed(1)}, {question.pose.yIn.toFixed(1)} in, facing{\" \"} {radToDeg(question.pose.headingRad).toFixed(0)}°. No step is added."],
  ["dialogs/WaypointDialog.tsx", "A new waypoint at the pose {ownerName(question.owner)} stands at. {capitalised(ownerName(question.owner))} then follows it."],
  ["github/CommitDialog.tsx", "Commits <code className=\"mono\">{message}</code> on{\" \"} <code className=\"mono\">{repo?.branch ?? \"—\"}</code>."],
  ["github/OpenFromGitHub.tsx", "Signed in as {auth.login}."],
  ["github/ReviewView.tsx", "The document itself changed: {model.header.join(\", \")}."],
  ["github/SignInDialog.tsx", "Permissions: {describeScopes(auth.scopes)}. {auth.keep === undefined || inApp ? null : <> {KEPT_WORDS[auth.keep]}</>}"],
  ["github/SignInDialog.tsx", "Type <code className=\"mono\">{device.userCode}</code> on{\" \"} <a className={styles.link} href={device.verificationUri} target=\"_blank\" rel=\"noreferrer\"> {device.verificationUri} </a> ."],
  ["github/SignInDialog.tsx", "The GitHub CLI is signed in on this computer."],
  ["github/OpenFromGitHub.tsx", "{project.name} is a clone of <code className=\"mono\">{originName(origin)}</code>."],
  ["github/OpenFromGitHub.tsx", "{project.name} is a clone of <code className=\"mono\">{originName(origin)}</code>."],
  ["dialogs/Dialogs.tsx", "{project.name} is a clone of {origin.owner}/{origin.repo}."],
  ["library/LibrarySheet.tsx", "{partners ? <LibraryShareChip autoId={auto.id} testId={`library-auto-${slug}-sharing`} /> : null} <span> {rows.length} revision{rows.length === 1 ? \"\" : \"s\"}"],
  ["library/RevisionReviewView.tsx", "What {solidSide.phrase} does differently from {ghostSide.phrase}."],
  ["library/RevisionReviewView.tsx", "The document itself differs: {model.header.join(\", \")}."],
  ["library/RevisionReviewView.tsx", "{pair.diverged ? \"Both were published from the same revision.\" : \"Two revisions from one line of work.\"}"],
  ["project/desktopPanel.tsx", "Working out what would change…"],
  ["project/desktopPanel.tsx", "{panel.phase === \"done\" ? \"Deployed. \" : \"\"} Copies every valid auto, the waypoints, the robot and the field file into{\" \"} <code className={styles.code}>{result.deployDir}</code> {stubs ? \" and refreshes the generated OpMode stubs\" : \"\"}. Nothing is installed on the robot."],
  ["project/desktopPanel.tsx", "The stubs run on the {RUNTIME_LABEL[result.commandLibrary].name} runtime ( <code className={styles.code}>{RUNTIME_LABEL[result.commandLibrary].pkg}</code>)."],
  ["project/hostPanel.tsx", "Save sends the open auto back to {name}."],
  ["proposals/ProposalEditView.tsx", "Share <code>{session.shareRef.shareId}</code> from {teamInSentence(session.share.fromTeam)}, at revision {session.shareRef.revision}."],
  ["proposals/ProposalEditView.tsx", "Loaded from a file, which records no share or revision."],
  ["proposals/ProposalReviewView.tsx", "<strong>The team library revision the proposal was made against.</strong> Steps that have changed since then are conflicts and can only be rejected."],
  ["proposals/ProposalReviewView.tsx", "Opened from share <code>{state.shareRef.shareId}</code>, revision {state.shareRef.revision}, which is{\" \"} {state.share ?? \"live\"}."],
  ["proposals/ProposalReviewView.tsx", "{review.rows.filter((row) => row.applied).length} applied so far."],
  ["report/ReportBugDialog.tsx", "{outcome.queued ? \"Thank you. Your report is saved on this device and goes to Horizon, privately, when you are back online.\" : \"Thank you. Your report went to Horizon privately.\"}"],
  ["report/ReportBugDialog.tsx", "{canSend ? \"Your report goes privately to Horizon (FTC 36596). Only Horizon admins can read it, and nobody can reply through Zenith.\" : cloud ? \"Sign in to send this report privately to Horizon. You can also copy it and send it yourself.\" : ( <> This build of Zenith cannot send reports. Copy the report, then paste it into{\" \"} {newIssueLink}. Anyone can read issues there. </> )}"],
  ["settings/ProjectPanes.tsx", "Both libraries run the same autos.{\" \"} <a className={styles.link} href={LIBRARIES_DOC} target=\"_blank\" rel=\"noreferrer\"> Choosing a command library </a>"],
  ["dialogs/SetupDialog.tsx", "{existingLine(folder, existing)} Set up points zenith.json at the autos where they are."],
  ["project/desktopPanel.tsx", "Deploying…"],
  ["project/desktopPanel.tsx", "Zenith leaves the other {countOf(status.otherChanges, \"changed file\")} alone."],
  ["project/desktopPanel.tsx", "Open pull request pushes the branch first."],
];

/** `warn`: a risk, a privacy fact, a confirmation, or why something cannot happen. */
const WARN: ReadonlyArray<readonly [file: string, text: string]> = [
  ["dialogs/BetaNotice.tsx", "It has been tested mostly by one team, Horizon (FTC 36596), so some things may break."],
  ["dialogs/BetaNotice.tsx", "Found a bug? Use Help, Report a bug, or open an issue on{\" \"} <a className={styles.link} href={ISSUES_URL} target=\"_blank\" rel=\"noreferrer\" data-testid=\"beta-notice-issues\"> GitHub </a> ."],
  ["github/OpenFromGitHub.tsx", "Zenith never writes to {repo.base}."],
  ["settings/PresetsPane.tsx", "Presets are yours, on this computer. A preset file carries one to a teammate, and Add to project to everyone who opens the project."],
  ["settings/PresetsPane.tsx", "You changed {plural(count, \"setting\", \"settings\")} from {from}."],
  ["settings/PresetsPane.tsx", "{name} has keys of its own. Replace your keys with them?"],
  ["account/SignInSheet.tsx", "To sign in you must be 13 or older, or use a school account your school approved for Zenith. See the{\" \"} <a className={styles.textLink} href={TERMS_URL} target=\"_blank\" rel=\"noreferrer\" data-testid=\"signin-terms-link\"> terms </a> ."],
  ["account/SignInSheet.tsx", "School Google accounts often cannot sign in to apps the school has not approved. Use another way, or give your teacher{\" \"} <a className={styles.textLink} href={SCHOOL_GUIDE_URL} target=\"_blank\" rel=\"noreferrer\" data-testid=\"school-guide-link\" > the one-page guide for the school&apos;s admin </a> ."],
  ["account/TeamKeys.tsx", "They can never be approved, and one can stop a teammate&apos;s real device from asking."],
  ["account/TeamKeys.tsx", "Make a new recovery code? The old one stops working at once, so print or save the new one now."],
  ["admin/AllShares.tsx", "What a share shows, its paths, title and commands, is for the teams it names and never for Horizon admins."],
  ["admin/BugReports.tsx", "Nobody can reply through Zenith."],
  ["cloud/ProjectionPreview.tsx", "{projection.commands === undefined ? \"Steps and commands show stand-in names.\" : \"Steps show stand-in names; commands show their real names.\"}"],
  ["cloud/ShareSheet.tsx", "<TriangleAlert className={styles.cautionIcon} size={16} strokeWidth={1.75} aria-hidden /> {status.kind === \"unpublished\" ? \"Publish this auto to your team library first.\" : `This auto has changes that are not in the team library since revision ${String(status.n)}. Publish them first.`}"],
  ["cloud/ShareSheet.tsx", "<TriangleAlert className={styles.cautionIcon} size={16} strokeWidth={1.75} aria-hidden /> {`This computer is offline and has not looked up ${created.teamNumbers.length === 1 ? `team ${String(created.teamNumbers[0])}` : \"those teams\"} yet. The share is made and sent once it is back online, if this page is still open.`}"],
  ["cloud/ShareSheet.tsx", "<TriangleAlert className={styles.cautionIcon} size={16} strokeWidth={1.75} aria-hidden /> Anyone who gets this link will be able to see it, without signing in."],
  ["dialogs/Dialogs.tsx", "This browser has no folder picker. Pick the files below, or use a Chromium browser; saving then downloads the file instead of writing it."],
  ["dialogs/Dialogs.tsx", "{fullSim ? `${name} did not offer to simulate from here, so load a trace it wrote instead.` : `${name} did not offer to simulate from here.`}"],
  ["dialogs/SaveChoiceDialog.tsx", "The example's robot and field may differ from the ones this auto was made for. It opens read only."],
  ["dialogs/SetupDialog.tsx", "{teamCode ? `Read ${countOf(plan.filesScanned, \"Java or Kotlin file\", \"Java and Kotlin files\")} in TeamCode.` : `${folder} has no TeamCode folder, so there was no robot code to read.`}"],
  ["dialogs/SetupDialog.tsx", "{folder} already has {taken.join(\", \")}, so Set up would write over {taken.length === 1 ? \"it\" : \"them\"}. Move{\" \"} {taken.length === 1 ? \"it\" : \"them\"} out of the way first."],
  ["dialogs/SetupDialog.tsx", "No robot class yet, so Deploy writes no OpMode."],
  ["github/CommitDialog.tsx", "{repo?.branch} is the base branch, which Zenith never writes to. Name a work branch in the open-project dialog."],
  ["github/ReviewView.tsx", "Read only: this is someone&apos;s proposal, not your working copy."],
  ["github/SignInDialog.tsx", "The token you paste is held in {inApp ? \"Zenith\" : \"this browser\"} and sent only to{\" \"} <code className=\"mono\">api.github.com</code>."],
  ["github/SignInDialog.tsx", "Ticked, Zenith keeps it encrypted on this computer until you sign out; unticked, until Zenith closes."],
  ["github/SignInDialog.tsx", "Full instructions:{\" \"} <a className={styles.link} href={README_URL} target=\"_blank\" rel=\"noreferrer\"> packages/github/README.md </a> ."],
  ["github/SignInDialog.tsx", "GitHub then lets Zenith read and write <strong>every repository your account can</strong>, private ones included. GitHub cannot limit this kind of sign-in to one repository. Zenith only touches the repository you open, and never writes to its base branch. An organisation that restricts outside apps has to approve Zenith once before its repositories show up."],
  ["github/SignInDialog.tsx", "GitHub mode then has the GitHub CLI&apos;s permissions, which usually reach every repository your account can. The token stays in memory until you sign out or close Zenith."],
  ["project/desktopPanel.tsx", "No OpMode is written, because <code className={styles.code}>zenith.json</code> has no{\" \"} <code className={styles.code}>codegen</code> section, so the Driver Station will not list these autos unless your own OpModes load them."],
  ["proposals/ProposalReviewView.tsx", "<strong>Your auto as it was when you opened this proposal.</strong>{\" \"} {cloudEnabled() ? \"No team library revision exists yet. If the auto has changed since you shared it, the proposal is refused as stale.\" : \"If the auto has changed since you made the share file, the proposal is refused as stale.\"}"],
  ["report/ReportBugDialog.tsx", "Please do not include names, email addresses or anything private. Paths on your computer become [path]."],
  ["report/ReportBugDialog.tsx", "Nothing else about you or your team is sent."],
  ["report/ReportBugDialog.tsx", "{copyFailedWords(\"the report\", true)}"],
  ["report/ReportBugDialog.tsx", "{editor.auto === null ? \" No auto is open.\" : attachment.ok ? cloud ? ` Horizon admins will see this file's paths: where your robot drives and when. ${String(attachment.sizeKb)} KB, without its authors.` : ` Pasted into an issue, this file's paths are public: where your robot drives and when. ${String(attachment.sizeKb)} KB, without its authors.` : ` Too large to include (${String(attachment.sizeKb ?? 0)} KB).`}"],
  ["settings/ProjectPanes.tsx", "These switches are yours, on this computer. They never change a project&apos;s files."],
  ["project/desktopPanel.tsx", "{fileName} has unsaved edits. {what}, so save it first."],
  ["project/desktopPanel.tsx", "Committing moves your work to {status.workBranch}. Zenith never writes to {status.base}."],
  ["project/desktopPanel.tsx", "{\" \"} {cliSentence(github)}{\" \"} <button type=\"button\" className={styles.linkButton} onClick={() => void checkGitAgain()} data-testid=\"desktop-git-check-again\"> Check again </button>"],
];

/** `empty`: what is missing or still loading. */
const EMPTY: ReadonlyArray<readonly [file: string, text: string]> = [
  ["account/SignInSheet.tsx", "{join.problem ?? \"Reading the invite…\"}"],
  ["account/TeamsSheet.tsx", "No invites yet."],
  ["account/TeamsSheet.tsx", "Nothing yet."],
  ["admin/AdminPage.tsx", "Loading…"],
  ["admin/AdminPage.tsx", "Loading the queue…"],
  ["admin/AdminPage.tsx", "Nothing is waiting."],
  ["admin/AdminPage.tsx", "No item open."],
  ["admin/AllShares.tsx", "Loading every share…"],
  ["admin/AllShares.tsx", "{rows.length === 0 ? \"No team has shared an auto yet.\" : \"No share matches these filters.\"}"],
  ["admin/BetaAccess.tsx", "Loading the lists…"],
  ["admin/BugReports.tsx", "Loading the reports…"],
  ["admin/BugReports.tsx", "{reports.length === 0 ? \"Nobody has sent a report yet.\" : \"No report has this status.\"}"],
  ["admin/BugReports.tsx", "No report open."],
  ["admin/VerificationSection.tsx", "Loading the team number's record…"],
  ["admin/VerificationSection.tsx", "No evidence yet."],
  ["cloud/ProjectionPreview.tsx", "None."],
  ["cloud/ProjectionPreview.tsx", "None."],
  ["cloud/ProjectionPreview.tsx", "None."],
  ["cloud/ReceivedShares.tsx", "No other team has shared an auto with {team} yet."],
  ["cloud/ShareSheet.tsx", "{projectionProblem ?? \"Nothing to show yet.\"}"],
  ["cloud/SharingPage.tsx", "{filterName === null ? \"Nothing is shared outside the team.\" : `${filterName} is not shared outside the team.`}"],
  ["dialogs/Dialogs.tsx", "Pick the folder with <code className=\"mono\">zenith.json</code> at its root."],
  ["dialogs/Dialogs.tsx", "Run the command below in {where}, then load the trace it writes."],
  ["dialogs/Dialogs.tsx", "{project === null ? \"No project is open.\" : \"zenith.json declares no sim command, so there is nothing to run.\"}"],
  ["dialogs/Dialogs.tsx", "No auto is open."],
  ["dialogs/ImportCommandsDialog.tsx", "Open a project first."],
  ["dialogs/SetupDialog.tsx", "{library === null ? \"Add these lines to build.dependencies.gradle, with your command library's own line (Robot runtime, Install, has both), then sync Gradle.\" : `Add these lines to build.dependencies.gradle for the ${LIBRARY_LABEL[library]} runtime, then sync Gradle.`}"],
  ["dialogs/WaypointDialog.tsx", "Looking for the autos that follow {question.name}…"],
  ["github/OpenFromGitHub.tsx", "Sign in to list the repositories your token can push to."],
  ["github/OpenFromGitHub.tsx", "Listing the repositories this token can push to…"],
  ["github/OpenFromGitHub.tsx", "{repos === null ? \"No repositories yet.\" : \"No repository this token can push to matches that.\"}"],
  ["github/ReviewView.tsx", "{model.identical ? \"The two versions of this auto are identical.\" : (model.reason ?? \"No step changed.\")}"],
  ["github/ReviewView.tsx", "{derived.findingsReason ?? \"This version of the auto cannot be drawn.\"}"],
  ["library/RevisionReviewView.tsx", "{model.identical ? \"The two versions are identical.\" : (model.reason ?? \"No step changed.\")}"],
  ["library/RevisionReviewView.tsx", "{files === null ? \"Open your robot's folder first: these revisions were published without robot.json and a field.\" : (solidDerived.findingsReason ?? \"This version of the auto cannot be drawn.\")}"],
  ["project/hostPanel.tsx", "{name} sent no autos."],
  ["project/hostPanel.tsx", "Pick one of the autos {name} sent, or start a new one."],
  ["proposals/ProposalEditView.tsx", "Open a project first."],
  ["proposals/ProposalEditView.tsx", "No changes yet."],
  ["proposals/ProposalEditView.tsx", "Nothing selected."],
  ["proposals/ProposalReviewView.tsx", "{proposedDerived?.findingsReason ?? \"The proposed auto cannot be drawn.\"}"],
  ["proposals/ProposalReviewView.tsx", "This proposal holds no changes."],
  ["settings/RobotPanes.tsx", "No arguments"],
  ["project/desktopPanel.tsx", "No auto is open. Open the auto to commit, then open this panel again."],
];

/**
 * Every sentence a sheet or dialog may write into an always-visible note, with its class. A site
 * matches an entry when its whole text is the entry's text, and each entry covers one site. The list
 * only shrinks: an entry whose sentence is gone fails the test.
 */
export const SHEET_NOTE_ALLOWLIST: readonly SheetNoteSite[] = [
  ...STATE.map(([file, text]): SheetNoteSite => ({ file, kind: "state", text })),
  ...WARN.map(([file, text]): SheetNoteSite => ({ file, kind: "warn", text })),
  ...EMPTY.map(([file, text]): SheetNoteSite => ({ file, kind: "empty", text })),
];
