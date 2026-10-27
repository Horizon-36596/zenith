/**
 * Signing in (spec 13 section 4.1), in a docked sheet that never blocks the app (spec 11 section 1):
 * the ways in, then the display name. There is no age screen (owner ruling 2026-10-02); the sheet
 * says what the Terms ask, 13 or older or a school account the school approved, beside the ways in.
 * A join link (`#/join/<code>`) runs through the same steps and ends on the join.
 * During the private beta, an account that is not on the beta list stops at the private-beta screen
 * instead of the display name or the join.
 */
import { useEffect, useState } from "react";
import type { SignInProvider } from "@horizon36596/zenith-cloud";
import { Sheet, SheetButton } from "../cloud/controls";
import { Tooltip } from "../components/Tooltip";
import { copyText } from "../app/copyText";
import { SCHOOL_GUIDE_URL, TERMS_URL, emailLinkEnabled } from "./config";
import { ROLE_WORDS } from "./permissions";
import { account, useAccount } from "./store";
import { StatusChip } from "./chips";
import { feedbackMounted } from "./feedbackShown";
import { DevReadsSlot } from "../cloud/DevReadsSlot";
import { FakeUsers } from "./FakeUsers";
import { desktopBridge } from "../project/desktop";
import { SharedComputerChoice } from "./keys";
import { teamLabel } from "./words";
import styles from "./account.module.css";

export function SignInSheet() {
  const state = useAccount();
  const joining = state.join !== null;
  // This sheet shows the account's failures itself, so they stay off the status line.
  useEffect(() => feedbackMounted(), []);
  return (
    <Sheet
      title={
        state.step === "join"
          ? "Join a team"
          : state.step === "profile"
            ? "Your display name"
            : state.step === "beta"
              ? "Private beta"
              : "Sign in"
      }
      help="signin"
      testId="signin-sheet"
      widthPx={400}
      onClose={() => {
        account.close();
      }}
      lead={
        joining && state.step !== "join" && state.step !== "beta" ? (
          <p className={styles.lead}>Sign in to join the team that sent you this link.</p>
        ) : undefined
      }
    >
      {state.step === "providers" ? <Providers /> : null}
      {state.step === "emailSent" ? <EmailSent /> : null}
      {state.step === "emailConfirm" ? <EmailConfirm /> : null}
      {state.step === "profile" ? <ProfileStep /> : null}
      {state.step === "join" ? <JoinStep /> : null}
      {state.step === "beta" ? <BetaStep /> : null}
      {state.error === null ? null : (
        <p className={styles.error} role="alert" data-testid="signin-error">
          {state.error}
        </p>
      )}
    </Sheet>
  );
}

/** The three providers, in the order the sheet shows them (section 4.1). */
const PROVIDER_BUTTONS: ReadonlyArray<{ provider: SignInProvider; label: string; hint: string; browserHint: string }> = [
  {
    provider: "github",
    label: "Sign in with GitHub",
    hint: "Opens GitHub's own sign-in window.",
    browserHint: "Opens GitHub in your browser and shows a code to type there.",
  },
  {
    provider: "microsoft",
    label: "Sign in with Microsoft",
    hint: "A personal Microsoft account or a work or school one.",
    browserHint: "Opens Microsoft's sign-in page in your browser. A personal account or a work or school one.",
  },
  {
    provider: "google",
    label: "Sign in with Google",
    hint: "Opens Google's own sign-in window.",
    browserHint: "Opens Google's sign-in page in your browser.",
  },
];

/**
 * In the desktop app, while the browser has the sign-in: what to do there, and a way to stop. Also
 * shown while Delete my account signs the account in again.
 */
export function NativeWait() {
  const progress = useAccount().nativeProgress;
  if (progress === null) return null;
  return (
    <div className={styles.section} data-testid="signin-native-wait">
      {progress.kind === "code" ? (
        <p className={styles.prose}>
          Type <span className={styles.mono} data-testid="signin-device-code">{progress.userCode}</span> on{" "}
          <a className={styles.textLink} href={progress.verificationUri} target="_blank" rel="noreferrer">
            GitHub&apos;s page
          </a>
          , then come back here.
        </p>
      ) : (
        <p className={styles.prose}>Finish signing in in your browser, then come back here.</p>
      )}
      <div className={styles.row}>
        <SheetButton
          tooltip="Stop signing in"
          hint="Stops waiting for the browser, so you can choose another way."
          testId="signin-native-cancel"
          onClick={() => void account.cancelSignIn()}
        >
          Cancel
        </SheetButton>
      </div>
    </div>
  );
}

function Providers() {
  const state = useAccount();
  const [email, setEmail] = useState("");
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const busy = state.busy ? "Signing in…" : null;
  return (
    <>
      <section className={styles.section} data-testid="signin-providers">

        <p className={styles.hint} data-testid="signin-terms">
          To sign in you must be 13 or older, or use a school account your school approved for Zenith. See the{" "}
          <a className={styles.textLink} href={TERMS_URL} target="_blank" rel="noreferrer" data-testid="signin-terms-link">
            terms
          </a>
          .
        </p>
        <div className={styles.providers}>
          {PROVIDER_BUTTONS.map(({ provider, label, hint, browserHint }) => {
            const route = state.signInRoutes[provider];
            if (route.kind === "unavailable") {
              return (
                <p key={provider} className={styles.hint} data-testid={`signin-${provider}-off`}>
                  {route.reason}
                </p>
              );
            }
            return (
              <SheetButton
                key={provider}
                tooltip={label}
                hint={route.kind === "native" ? browserHint : hint}
                whyDisabled={busy}
                testId={`signin-${provider}`}
                onClick={() => void account.signInWith(provider)}
              >
                {label}
              </SheetButton>
            );
          })}
          <NativeWait />
          <p className={styles.hint} data-testid="school-google-note">
            School Google accounts often cannot sign in to apps the school has not approved. Use another way, or give
            your teacher{" "}
            <a
              className={styles.textLink}
              href={SCHOOL_GUIDE_URL}
              target="_blank"
              rel="noreferrer"
              data-testid="school-guide-link"
            >
              the one-page guide for the school&apos;s admin
            </a>
            .
          </p>
        </div>
      </section>

      {emailLinkEnabled() ? (
      <section className={styles.section}>
        <h3 className={styles.sectionHead}>Or get a link by email</h3>
        <form
          className={`${styles.row} ${styles.rowEnd}`}
          onSubmit={(event) => {
            event.preventDefault();
            if (emailOk) void account.sendEmailLink(email);
          }}
        >
          {/* A visible label and an example address, so the box says what goes in it (issue #502). */}
          <label className={styles.label}>
            Email address
            <Tooltip
              label="Email address"
              hint="The link is sent here. It stays with your sign-in and no other team sees it."
            >
              <input
                className={styles.input}
                type="email"
                autoComplete="email"
                placeholder="name@example.com"
                value={email}
                data-testid="signin-email"
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
              />
            </Tooltip>
          </label>
          <SheetButton
            tooltip="Send a sign-in link"
            hint="Open the link in the email on this computer to finish signing in."
            whyDisabled={busy ?? (emailOk ? null : "Type your email address.")}
            testId="signin-email-send"
            onClick={() => void account.sendEmailLink(email)}
          >
            Send link
          </SheetButton>
        </form>
      </section>
      ) : null}

      <SharedComputerChoice
        value={state.sharedComputer ? "shared" : "own"}
        inDesktopApp={desktopBridge() !== null}
        onChange={(value) => void account.setSharedComputer(value === "shared")}
      />
      <FakeUsers />
      <DevReadsSlot />
    </>
  );
}

function EmailSent() {
  const state = useAccount();
  return (
    <section className={styles.section} data-testid="signin-email-sent">
      <p className={styles.lead}>
        Check your email. The link to sign in went to <span className={styles.mono}>{state.emailSentTo}</span>.
      </p>

      <div className={styles.row}>
        {state.fakeLink === null ? null : (
          <SheetButton
            kind="primary"
            tooltip="Open the sign-in link"
            hint="The fake cloud sends no email, so its link opens from here."
            testId="signin-fake-link"
            onClick={() => void account.openFakeLink()}
          >
            Open the link (fake cloud)
          </SheetButton>
        )}
        <SheetButton
          tooltip="Use another way"
          hint="Go back to the ways to sign in."
          testId="signin-email-back"
          onClick={() => {
            account.open("signIn");
          }}
        >
          Use another way
        </SheetButton>
      </div>
    </section>
  );
}

function EmailConfirm() {
  const [email, setEmail] = useState("");
  return (
    <section className={styles.section} data-testid="signin-email-confirm">
      <p className={styles.prose}>
        This link was opened on a different computer. Type the email address it was sent to.
      </p>
      <div className={styles.row}>
        <Tooltip label="Email address" hint="The address the sign-in link was sent to.">
          <input
            className={styles.input}
            type="email"
            aria-label="Email address"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </Tooltip>
        <SheetButton
          kind="primary"
          tooltip="Finish signing in"
          whyDisabled={email.trim() === "" ? "Type your email address." : null}
          onClick={() => void account.confirmEmail(email)}
        >
          Sign in
        </SheetButton>
      </div>
    </section>
  );
}

function ProfileStep() {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const why =
    trimmed === "" ? "Type a display name." : trimmed.length > 80 ? "A display name has at most 80 characters." : null;
  return (
    <section className={styles.section} data-testid="signin-profile">

      <form
        className={styles.row}
        onSubmit={(event) => {
          event.preventDefault();
          if (why === null) void account.saveDisplayName(trimmed);
        }}
      >
        <Tooltip label="Display name" hint="Shown to the members of your teams, never to other teams. A nickname is fine.">
          <input
            className={styles.input}
            aria-label="Display name"
            maxLength={80}
            value={name}
            data-testid="signin-display-name"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Tooltip>
        <SheetButton
          kind="primary"
          tooltip="Save the display name"
          whyDisabled={why}
          testId="signin-display-name-save"
          onClick={() => void account.saveDisplayName(trimmed)}
        >
          Save
        </SheetButton>
      </form>
    </section>
  );
}

/**
 * Signed in, but not on the private-beta list: the user code to send a Horizon admin, who adds it
 * (owner ruling 2026-10-03, issue #99; there is no way to ask from here), a way to check again once
 * it is added, and a way out.
 */
function BetaStep() {
  const state = useAccount();
  const code = state.user?.uid ?? "";
  return (
    <section className={styles.section} data-testid="signin-beta">
      <p className={styles.prose} data-testid="signin-beta-send-code">
        Send your user code to a Horizon (FTC 36596) admin, then press Check again.
      </p>
      <div className={styles.row}>
        <Tooltip label="Your user code" hint="The code a Horizon (FTC 36596) admin adds to the beta list.">
          <input
            className={`${styles.input} ${styles.userCode}`}
            readOnly
            aria-label="Your user code"
            value={code}
            data-testid="signin-beta-code"
            onFocus={(event) => {
              event.currentTarget.select();
            }}
          />
        </Tooltip>
        <SheetButton
          kind="primary"
          tooltip="Copy your user code"
          hint="Send it to a Horizon (FTC 36596) admin by any message you like."
          testId="signin-beta-copy"
          onClick={() => {
            void copyText("your user code", code, { select: document.querySelector('[data-testid="signin-beta-code"]') });
          }}
        >
          Copy
        </SheetButton>
      </div>
      <div className={styles.row}>
        <SheetButton
          tooltip="Check again"
          hint="Asks the cloud again whether this account is on the beta list."
          whyDisabled={state.busy ? "Checking…" : null}
          testId="signin-beta-check"
          onClick={() => void account.checkBetaAgain()}
        >
          Check again
        </SheetButton>
        <SheetButton
          tooltip="Sign out"
          hint="Signs this account out of Zenith on this computer."
          testId="signin-beta-sign-out"
          onClick={() => void account.signOut()}
        >
          Sign out
        </SheetButton>
      </div>
    </section>
  );
}

function JoinStep() {
  const state = useAccount();
  const join = state.join;
  if (join === null) return null;
  if (join.joinedAs !== null) {
    return (
      <section className={styles.section} data-testid="join-done">
        <p className={styles.lead}>
          {join.joinedAs === "pending"
            ? `You asked to join ${join.teamName ?? "the team"}. An owner or admin has to approve you.`
            : `You joined ${join.teamName ?? "the team"} as ${ROLE_WORDS[join.joinedAs].toLowerCase()}.`}
        </p>
        <div className={styles.row}>
          <SheetButton
            kind="primary"
            tooltip="Done"
            hint="Close this and show the team."
            testId="join-finish"
            onClick={() => {
              if (window.location.hash.startsWith("#/join/")) window.location.hash = "";
              account.finishJoin();
            }}
          >
            Show the team
          </SheetButton>
        </div>
      </section>
    );
  }
  const invite = join.invite;
  return (
    <section className={styles.section} data-testid="join-step">
      {invite === null ? (
        <p className={styles.prose}>{join.problem ?? "Reading the invite…"}</p>
      ) : (
        <>
          <p className={styles.lead}>
            Join <strong>{teamLabel({ number: join.teamNumber, name: join.teamName ?? "a team" })}</strong> as{" "}
            {ROLE_WORDS[invite.role].toLowerCase()}.
          </p>
          {join.teamStatus === null ? null : (
            <div className={styles.row}>
              <StatusChip status={join.teamStatus} testId="join-status" />
            </div>
          )}
          <p className={styles.prose}>
            {invite.autoApprove
              ? "The invite lets you in at once."
              : "An owner or admin approves you first."}
          </p>
          {join.problem === null ? null : <p className={styles.error}>{join.problem}</p>}
          <div className={styles.row}>
            <SheetButton
              kind="primary"
              tooltip="Join the team"
              whyDisabled={join.problem ?? (state.busy ? "Joining…" : null)}
              testId="join-submit"
              onClick={() => void account.redeemJoin()}
            >
              Join team
            </SheetButton>
          </div>
        </>
      )}
    </section>
  );
}
