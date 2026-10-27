/**
 * The Settings sections that belong to the cloud account (spec 13 sections 4.1 and 12.3), moved
 * here from the old account sheet (issue #97): Account, Teams, Privacy and data, Admin and
 * Developer. Each keeps the controls, words and test ids it had in the sheet.
 *
 * "Sign out everywhere" shows only when the backend can end the other sessions, and none can: that
 * means revoking the user's refresh tokens, which Firebase lets only its Admin SDK do, and the Admin
 * SDK runs only in server code, such as Cloud Functions, which the no-cost Spark plan does not have
 * (ADR 0009). The Firebase web SDK signs out this device only. So the button stays hidden; for a lost
 * device, a team's admins remove the member, and a Horizon admin can disable the account in the console.
 *
 * Deleting the account asks in the pane itself, never in a second modal (spec 11 section 1). So does
 * signing out while changes still wait in the Outbox, since signing out drops them (issue #319).
 */
import { useEffect, useState } from "react";
import { SheetButton } from "../cloud/controls";
import { DevReadsSlot } from "../cloud/DevReadsSlot";
import { ConfirmRow } from "../components/ConfirmRow";
import { Tooltip } from "../components/Tooltip";
import { downloadText } from "../project/fallback";
import { AdminDashboardEntry, openAdminDashboard } from "../account/AdminEntry";
import { RoleChip, StatusChip } from "../account/chips";
import { FakeUsers } from "../account/FakeUsers";
import { Feedback } from "../account/Feedback";
import { feedbackMounted } from "../account/feedbackShown";
import { NativeWait } from "../account/SignInSheet";
import { account, openAccountPanel, useAccount } from "../account/store";
import { signOutDropsWords, teamLabel } from "../account/words";
import accountStyles from "../account/account.module.css";
import { Group, Row } from "./parts";
import { signInMethodOf } from "./sections";
import { closeSettings } from "./store";
import styles from "./Settings.module.css";

/** Whether the backend can sign out every other device. Found by shape; no backend has it yet. */
const canSignOutEverywhere = (): boolean => {
  const backend = account.cloud() as unknown as { signOutEverywhere?: unknown } | null;
  return typeof backend?.signOutEverywhere === "function";
};

/** Opens an account sheet in the window's place: the sheet docks at the right, and Settings is modal. */
function openSheet(panel: "signIn" | "teams"): void {
  closeSettings();
  openAccountPanel(panel);
}

export function AccountPane() {
  const state = useAccount();
  const signedIn = state.user !== null && state.profile !== null;
  const [name, setName] = useState(state.profile?.displayName ?? "");
  // Another user on this computer (the fake cloud's switch of user) brings their own name.
  const savedName = state.profile?.displayName ?? "";
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const waiting = state.outbox?.queued ?? 0;
  useEffect(() => {
    setName(savedName);
  }, [savedName]);
  // This pane shows the account's failures itself, so they stay off the status line.
  useEffect(() => feedbackMounted(), []);

  if (!signedIn || state.user === null) {
    return (
      <Group>
        <Row label="Not signed in" testId="settings-signed-out">
          <SheetButton
            kind="primary"
            tooltip="Sign in"
            hint="An account adds a team library and sharing; everything else works without one. Closes Settings."
            testId="settings-sign-in"
            onClick={() => {
              openSheet("signIn");
            }}
          >
            Sign in
          </SheetButton>
        </Row>
      </Group>
    );
  }

  const trimmed = name.trim();
  const nameWhy =
    trimmed === "" ? "Type a display name." : trimmed === state.profile?.displayName ? "This is already your name." : null;

  return (
    <>
      <Group title="Profile">
        <Row label="Display name" testId="settings-display-name">
          <form
            className={styles.inline}
            onSubmit={(event) => {
              event.preventDefault();
              if (nameWhy === null) void account.saveDisplayName(trimmed);
            }}
          >
            <Tooltip label="Display name" hint="Shown to the members of your teams, never to other teams.">
              <input
                className={accountStyles.input}
                aria-label="Display name"
                maxLength={80}
                value={name}
                data-testid="account-display-name"
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </Tooltip>
            <SheetButton
              tooltip="Save the display name"
              whyDisabled={nameWhy}
              testId="account-display-name-save"
              onClick={() => void account.saveDisplayName(trimmed)}
            >
              Save
            </SheetButton>
          </form>
        </Row>
        <Row
          label="Signed in with"
          description={
            state.user.email === null ? undefined : (
              <span className={styles.mono} data-testid="settings-email">
                {state.user.email}
              </span>
            )
          }
          testId="settings-sign-in-method"
        >
          <span className={styles.value}>{signInMethodOf(state.user.providerIds)}</span>
        </Row>
        <Row
          label="Sign out"
          testId="settings-sign-out"
          below={
            confirmSignOut && waiting > 0 ? (
              <ConfirmRow
                testId="account-sign-out-confirm"
                confirmTestId="account-sign-out-yes"
                cancelTestId="account-sign-out-no"
                sentence={signOutDropsWords(waiting, state.online)}
                verb="Sign out anyway"
                onConfirm={() => {
                  setConfirmSignOut(false);
                  closeSettings();
                  void account.signOut();
                }}
                onCancel={() => {
                  setConfirmSignOut(false);
                }}
              />
            ) : undefined
          }
        >
          <span className={styles.inline}>
            <SheetButton
              tooltip="Sign out"
              hint={
                waiting > 0
                  ? "Changes are still waiting in the Outbox, and signing out drops them. Asks first, here."
                  : "Signs out on this computer and clears the team library's offline copy here. Closes Settings."
              }
              testId="account-sign-out"
              onClick={() => {
                if (waiting > 0) {
                  setConfirmSignOut(true);
                  return;
                }
                closeSettings();
                void account.signOut();
              }}
            >
              Sign out
            </SheetButton>
            {canSignOutEverywhere() ? (
              <SheetButton tooltip="Sign out everywhere" hint="Ends your sessions on every computer." onClick={() => undefined}>
                Sign out everywhere
              </SheetButton>
            ) : null}
          </span>
        </Row>
      </Group>
      {/* Only an error from this pane's own requests. The account's last notice belongs to whatever made it, such as a publish (issue #414). */}
      {state.error === null ? null : (
        <p className={accountStyles.error} role="alert" data-testid="account-error">
          {state.error}
        </p>
      )}
    </>
  );
}

export function TeamsPane() {
  const state = useAccount();
  return (
    <>
      <Group title="Your teams" aside={<span className={styles.mono}>{String(state.memberships.length)}</span>}>
        {state.memberships.length === 0 ? (
          <Row label="Not in a team yet" testId="settings-no-teams" />
        ) : (
          <div className={styles.list} data-testid="account-teams">
            {state.memberships.map((membership) => (
              <Row
                key={membership.teamId}
                label={teamLabel(membership.team)}
                description={
                  <span className={styles.chips}>
                    <RoleChip role={membership.role} />
                    {membership.team === null ? null : <StatusChip status={membership.team.status} />}
                  </span>
                }
              >
                <SheetButton
                  kind="text"
                  tooltip="Open this team"
                  hint="Members, invites, keys and settings, in the Teams panel."
                  onClick={() => {
                    account.selectTeam(membership.teamId);
                    openSheet("teams");
                  }}
                >
                  Open
                </SheetButton>
              </Row>
            ))}
          </div>
        )}
      </Group>
      <Group>
        <Row label="Manage teams">
          <SheetButton
            tooltip="Teams"
            hint="Create a team, invite and approve members, and set roles. Closes Settings."
            testId="account-open-teams"
            onClick={() => {
              openSheet("teams");
            }}
          >
            Open Teams
          </SheetButton>
        </Row>
      </Group>
      <Feedback />
    </>
  );
}

export function DataPane() {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteWhy = account.whyCannotDeleteAccount();
  return (
    <>
      <Group title="Your data">
        <Row label="Export my data" testId="settings-export">
          <SheetButton
            tooltip="Export my data"
            hint="Downloads your profile, your memberships, and the revisions, shares, proposals, requests, evidence, appeals and log entries you wrote."
            testId="account-export"
            onClick={() => {
              void account.exportMyData().then((text) => {
                if (text !== null) downloadText("zenith-my-data.json", text);
              });
            }}
          >
            Export my data
          </SheetButton>
        </Row>
      </Group>
      <Group title="Delete account">
        <Row
          label="Delete my account"
          testId="settings-delete"
          below={
            confirmDelete && deleteWhy === null ? (
              <ConfirmRow
                testId="account-delete-confirm"
                confirmTestId="account-delete-yes"
                cancelTestId="account-delete-no"
                sentence="This removes you from every team and deletes your profile and your sign-in. It cannot be undone. The autos you published stay in your teams' libraries. First you sign in again with the same account, so Zenith knows it is you; if you do not finish that sign-in, nothing is deleted."
                verb="Delete my account"
                onConfirm={() => void account.deleteAccount()}
                onCancel={() => {
                  setConfirmDelete(false);
                }}
              >
                <NativeWait />
              </ConfirmRow>
            ) : deleteWhy === null ? undefined : (
              <p className={styles.note} data-testid="settings-delete-why">
                {deleteWhy}
              </p>
            )
          }
        >
          <SheetButton
            tooltip="Delete my account"
            hint="Removes you from every team and deletes your profile and sign-in. Asks first, here."
            whyDisabled={deleteWhy}
            testId="account-delete"
            onClick={() => {
              setConfirmDelete(true);
            }}
          >
            Delete my account
          </SheetButton>
        </Row>
      </Group>
      <Feedback />
    </>
  );
}

export function AdminPane({ admin }: { admin: boolean }) {
  return (
    <AdminDashboardEntry
      admin={admin}
      onOpen={() => {
        // The admin page takes the whole window, so Settings makes way for it.
        closeSettings();
        openAdminDashboard();
      }}
    />
  );
}

export function DeveloperPane() {
  return (
    <div className={styles.developer}>
      <FakeUsers />
      <DevReadsSlot />
      <Feedback />
    </div>
  );
}
