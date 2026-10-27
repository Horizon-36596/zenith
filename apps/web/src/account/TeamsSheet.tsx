/**
 * Teams (spec 13 sections 4.2 and 4.3): create a team, its members and
 * their roles, invites with a calendar expiry, the two sharing settings and Publish on every save,
 * the activity log, and leaving or deleting the team. Every control is enabled or not by
 * `permissions.ts`, and a disabled one says why in its tooltip.
 *
 * The team key (spec 14) shows here too: the recovery code once after a team is created, a device
 * waiting for the key, approving a new member by typing the code their device shows, what the
 * encryption means and who may do what (`TeamPrivacy`), the devices that hold the key, and the
 * recovery and team safety codes one click away (`TeamKeys.tsx`).
 */
import { useId, useState } from "react";
import { Copy } from "lucide-react";
import type { ActiveRole, Invite, InviteRole, Member } from "@horizon36596/zenith-cloud";
import { VerificationSection } from "../admin/VerificationSection";
import { useVerificationBackend } from "../admin/store";
import { Segmented } from "../components/Segmented";
import { Sheet, SheetButton } from "../cloud/controls";
import { LoadingLine, RowButton } from "../components/primitives";
import { readTeamNumber } from "../lib/teamNumber";
import { ConfirmRow } from "../components/ConfirmRow";
import { Tooltip } from "../components/Tooltip";
import { copyText } from "../app/copyText";
import { Feedback } from "./Feedback";
import { linkPageUrl } from "./config";
import { ExpiryPicker } from "./ExpiryPicker";
import { ApproveWithCode, RECOVERY_SHEET, TeamPrivacy } from "./keys";
import { NO_MEMBER_REQUEST } from "./model";
import { KeyProblem, KeyWaiting, RecoveryCodeStep, TeamKeyAlerts, TeamKeysSection } from "./TeamKeys";
import { RoleChip, StatusChip } from "./chips";
import {
  DEFAULT_INVITE_EXPIRY,
  expiryMs,
  inviteState,
  inviteStateWords,
  joinLink,
  whyCannotCreateInvite,
  type InviteExpiryChoice,
} from "./invites";
import {
  ROLE_DOES,
  ROLE_WORDS,
  isAdminRole,
  roleChoices,
  whyCannotApproveMember,
  whyCannotChangeRole,
  whyCannotDeleteTeam,
  whyCannotEditSettings,
  whyCannotInvite,
  whyCannotLeave,
  whyCannotRemove,
  whyCannotTransfer,
  whyCannotViewActivity,
} from "./permissions";
import { account, useAccount } from "./store";
import { activityWords, removedFromWords, teamLabel, timeAgo, whenWords } from "./words";
import styles from "./account.module.css";

export function TeamsSheet() {
  const state = useAccount();
  const membership = state.memberships.find((m) => m.teamId === state.teamId) ?? null;
  if (state.newRecoveryCode !== null) {
    // The recovery code comes first and alone: it is shown this once, and the team needs it saved.
    return (
      <Sheet
        title={state.newRecoveryCode.replacing ? RECOVERY_SHEET.titleReplacing : RECOVERY_SHEET.title}
        help="teams"
        testId="teams-sheet"
        widthPx={460}
        onClose={() => {
          account.close();
        }}
      >
        <RecoveryCodeStep />
        <Feedback />
      </Sheet>
    );
  }
  return (
    <Sheet
      title="Teams"
      help="teams"
      testId="teams-sheet"
      widthPx={460}
      onClose={() => {
        account.close();
      }}
      lead={<TeamPicker />}
    >
      {membership === null ? <CreateTeam first={state.memberships.length === 0} /> : <TeamDetail />}
      {membership === null ? null : <CreateTeam first={false} />}
      <Feedback offerNewRecoveryCode />
    </Sheet>
  );
}

function TeamPicker() {
  const state = useAccount();
  const removed =
    state.removedFrom === null ? null : (
      <p className={styles.lead} data-testid="teams-removed-from">
        {removedFromWords(state.removedFrom)}
      </p>
    );
  if (state.memberships.length === 0) {
    return removed ?? <p className={styles.lead}>You are not in a team yet.</p>;
  }
  const current = state.memberships.find((m) => m.teamId === state.teamId);
  return (
    <>
      {removed}
      <div className={styles.row}>
        <Tooltip label="Team" hint="The team whose members, settings and library are shown.">
          <select
            className={styles.select}
            aria-label="Team"
            value={state.teamId ?? ""}
            data-testid="teams-picker"
            onChange={(event) => {
              account.selectTeam(event.target.value);
            }}
          >
            {state.memberships.map((m) => (
              <option key={m.teamId} value={m.teamId}>
                {teamLabel(m.team)}
              </option>
            ))}
          </select>
        </Tooltip>
        {current?.team === null || current?.team === undefined ? null : (
          <StatusChip status={current.team.status} testId="teams-status" />
        )}
        {current === undefined ? null : <RoleChip role={current.role} testId="teams-my-role" />}
      </div>
    </>
  );
}

function CreateTeam({ first }: { first: boolean }) {
  const [open, setOpen] = useState(first);
  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const state = useAccount();
  const numberProblemId = useId();
  // The number is optional; one typed is read by the app's one rule (issue #502), and its sentence
  // shows under the field rather than only in Create team's tooltip.
  const reading = number.trim() === "" ? null : readTeamNumber(number);
  const numberValue = reading?.ok === true ? reading.teamNumber : null;
  const numberWhy = reading !== null && !reading.ok ? reading.why : null;
  const why = numberWhy ?? (name.trim() === "" ? "Type the team's name." : state.busy ? "Creating…" : null);
  if (!open) {
    return (
      <div className={styles.row}>
        <SheetButton
          kind="text"
          tooltip="Create another team"
          hint="You can belong to more than one team."
          testId="teams-create-open"
          onClick={() => {
            setOpen(true);
          }}
        >
          Create another team
        </SheetButton>
      </div>
    );
  }
  return (
    <section className={styles.section} data-testid="teams-create">
      <h3 className={styles.sectionHead}>Create a team</h3>
      <p className={styles.prose}>
        The number shows as unverified until a Horizon admin checks it.
      </p>
      <form
        className={styles.row}
        onSubmit={(event) => {
          event.preventDefault();
          if (why === null) void account.createTeam({ number: numberValue, name: name.trim() });
        }}
      >
        <label className={styles.label}>
          FTC team number
          <Tooltip
            label="FTC team number"
            hint="Optional. One team per number; leave it blank if your team has none yet."
          >
            <input
              className={`${styles.input} ${styles.number}`}
              inputMode="numeric"
              value={number}
              aria-invalid={numberWhy === null ? undefined : true}
              aria-describedby={numberWhy === null ? undefined : numberProblemId}
              data-testid="teams-create-number"
              onChange={(event) => {
                setNumber(event.target.value);
              }}
            />
          </Tooltip>
        </label>
        <label className={styles.label}>
          Team name
          <Tooltip label="Team name" hint="What your team calls itself, up to 100 characters.">
            <input
              className={styles.input}
              maxLength={100}
              value={name}
              data-testid="teams-create-name"
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Tooltip>
        </label>
      </form>
      {numberWhy === null ? null : (
        <p className={styles.error} role="alert" id={numberProblemId} data-testid="teams-create-number-error">
          {numberWhy}
        </p>
      )}
      <div className={styles.row}>
        <SheetButton
          kind={first ? "primary" : "secondary"}
          tooltip="Create the team"
          hint="You become its owner."
          whyDisabled={why}
          testId="teams-create-submit"
          onClick={() => {
            void account.createTeam({ number: numberValue, name: name.trim() }).then((done) => {
              if (done) {
                setNumber("");
                setName("");
                setOpen(false);
              }
            });
          }}
        >
          Create team
        </SheetButton>
      </div>
    </section>
  );
}

function TeamDetail() {
  const state = useAccount();
  const role = account.role();
  // The page's one backend, the one the account signed in to (account/wiring.ts).
  const backend = useVerificationBackend();
  if (role === "pending") {
    return (
      <>
        <p className={styles.prose} data-testid="teams-pending">
          Your membership is waiting for approval.
        </p>
        <KeyWaiting />
        <KeyProblem />
      </>
    );
  }
  if (state.team === null) {
    return <LoadingLine line="Reading the team…" error={state.teamReadError} onRetry={() => void account.refreshTeam()} testId="teams-loading" />;
  }
  return (
    <>
      <KeyWaiting />
      <KeyProblem />
      <TeamKeyAlerts />
      <Members />
      {state.team.settings === undefined ? null : (
        <TeamPrivacy
          editorsMayProposeShare={state.team.settings.editorsMayProposeShare}
          editorsMayLinkShare={state.team.settings.editorsMayLinkShare}
        />
      )}
      <TeamKeysSection />
      {backend === null || state.teamId === null ? null : (
        <VerificationSection
          key={`${state.teamId}:${state.user?.uid ?? ""}`}
          backend={backend}
          teamId={state.teamId}
          canManage={isAdminRole(role)}
        />
      )}
      {isAdminRole(role) ? <Invites /> : null}
      <Settings />
      {whyCannotViewActivity(role) === null ? <Activity /> : null}
      <LeaveOrDelete />
    </>
  );
}

function Members() {
  const state = useAccount();
  const me = state.user?.uid ?? "";
  const members = state.team?.members ?? [];
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionHead}>Members</h3>

      <ul className={styles.list} data-testid="teams-members">
        {members.map((member) => (
          <MemberRow key={member.uid} member={member} me={me} />
        ))}
      </ul>
    </section>
  );
}

function MemberRow({ member, me }: { member: Member; me: string }) {
  const role = account.role();
  const [confirm, setConfirm] = useState<"remove" | "transfer" | null>(null);
  const [approving, setApproving] = useState(false);
  const state = useAccount();
  const changeWhy = whyCannotChangeRole(role, me, member);
  // The member's own role first, then what the actor may give; owner is given by Make owner.
  const current = member.role === "pending" ? null : member.role;
  const roleOptions: ActiveRole[] = [
    ...(current === null ? [] : [current]),
    ...(changeWhy === null ? roleChoices(role, me, member).filter((r) => r !== "owner" && r !== current) : []),
  ];
  const removeWhy = whyCannotRemove(role, me, member);
  const approveWhy = whyCannotApproveMember(role, member);
  const transferWhy = whyCannotTransfer(role, me, member);
  const testId = `member-${member.displayName.replace(/\s+/g, "-").toLowerCase()}`;
  // An active member's role is the select beside it, so only a pending one shows a chip.
  const pendingChip = member.role === "pending" ? <RoleChip role={member.role} /> : null;
  return (
    <li className={styles.item} data-testid={testId} data-role={member.role}>
      <div className={styles.itemMain}>
        <span className={styles.itemTitle}>
          {member.displayName}
          {member.uid === me ? " (you)" : ""}
        </span>
        <span className={styles.itemMeta}>
          {pendingChip}
          {member.role === "pending" && member.requestedRole !== undefined ? (
            <span>asks to be {ROLE_WORDS[member.requestedRole].toLowerCase()}</span>
          ) : null}
        </span>
      </div>
      <div className={styles.itemActions}>
        {member.role === "pending" ? (
          <SheetButton
            kind="text"
            tooltip="Approve"
            hint={`Let ${member.displayName} in as ${ROLE_WORDS[member.requestedRole ?? "viewer"].toLowerCase()}.`}
            whyDisabled={approveWhy}
            testId={`${testId}-approve`}
            onClick={() => {
              setApproving(true);
            }}
          >
            Approve
          </SheetButton>
        ) : (
          <Tooltip
            label="Role"
            hint={
              changeWhy === null
                ? "What this member may do. Hover a role in the list for what it allows."
                : `Unavailable: ${changeWhy}`
            }
          >
            <select
              className={styles.select}
              aria-label={`Role of ${member.displayName}`}
              aria-disabled={changeWhy !== null}
              disabled={changeWhy !== null}
              value={member.role}
              data-testid={`${testId}-role`}
              onChange={(event) => void account.setRole(member.uid, event.target.value as ActiveRole)}
            >
              {roleOptions.map((r) => (
                <option key={r} value={r} title={ROLE_DOES[r]}>
                  {ROLE_WORDS[r]}
                </option>
              ))}
            </select>
          </Tooltip>
        )}
        {member.uid === me ? null : (
          <SheetButton
            kind="text"
            tooltip="Make owner"
            hint="Transfer ownership: this member becomes an owner. You stay one until they change your role."
            whyDisabled={transferWhy}
            testId={`${testId}-transfer`}
            onClick={() => {
              setConfirm("transfer");
            }}
          >
            Make owner
          </SheetButton>
        )}
        {member.uid === me ? null : (
          <SheetButton
            kind="text"
            tooltip="Remove from the team"
            hint="Asks first. They lose access to the team library at once, and the team key changes."
            whyDisabled={removeWhy}
            testId={`${testId}-remove`}
            onClick={() => {
              setConfirm("remove");
            }}
          >
            Remove
          </SheetButton>
        )}
      </div>
      {approving && member.role === "pending" && approveWhy === null ? (
        <div className={`${styles.itemFollowUp} ${styles.confirm}`}>
          <ApproveWithCode
            who={member.displayName}
            kind="member"
            busy={state.busy}
            whyCannotApprove={account.memberKeyRequest(member.uid) === null ? NO_MEMBER_REQUEST : null}
            testId={`${testId}-check`}
            onApprove={(approvalCode) =>
              account.approveWithCode(member.uid, approvalCode).then(() => {
                setApproving(false);
              })
            }
            onDecline={() => {
              setApproving(false);
            }}
          />
        </div>
      ) : null}
      {confirm === null ? null : (
        <ConfirmRow
          testId={`${testId}-confirm`}
          confirmTestId={`${testId}-confirm-yes`}
          sentence={
            confirm === "remove"
              ? `Remove ${member.displayName} from the team? They can come back only with a new invite. The team key changes, so they cannot open anything made after.`
              : `Make ${member.displayName} an owner? Owners can delete the team and change anyone's role, yours included.`
          }
          verb={confirm === "remove" ? "Remove" : "Make owner"}
          whyDisabled={state.busy ? "Sending the last change." : null}
          onConfirm={() => {
            const work = confirm === "remove" ? account.removeMember(member.uid) : account.transferOwnership(member.uid);
            void work.then(() => {
              setConfirm(null);
            });
          }}
          onCancel={() => {
            setConfirm(null);
          }}
        />
      )}
    </li>
  );
}

const INVITE_ROLES: ReadonlyArray<{ value: InviteRole; label: string; does: string }> = [
  { value: "viewer", label: "Viewer", does: ROLE_DOES.viewer },
  { value: "editor", label: "Editor", does: ROLE_DOES.editor },
  { value: "admin", label: "Admin", does: ROLE_DOES.admin },
];

function Invites() {
  const state = useAccount();
  const role = account.role();
  const [inviteRole, setInviteRole] = useState<InviteRole>("editor");
  const [expiry, setExpiry] = useState<InviteExpiryChoice>(DEFAULT_INVITE_EXPIRY);
  const [maxUses, setMaxUses] = useState("1");
  const [autoApproveChoice, setAutoApprove] = useState(false);
  // An admin invite never lets anyone in at once (owner ruling 2026-10-25).
  const autoApprove = autoApproveChoice && inviteRole !== "admin";
  const uses = Number(maxUses);
  const nowMs = Date.now();
  const why = whyCannotInvite(role) ?? whyCannotCreateInvite(expiry, uses, nowMs) ?? (state.busy ? "Working…" : null);
  const endsMs = expiryMs(expiry, nowMs);
  const last = state.lastInvite;

  return (
    <section className={styles.section} data-testid="teams-invites">
      <h3 className={styles.sectionHead}>Invites</h3>
      <div className={styles.stack}>
        <Segmented
          label="Role the invite gives"
          options={INVITE_ROLES}
          value={inviteRole}
          testId="invite-role"
          onChange={setInviteRole}
        />
        <ExpiryPicker value={expiry} onChange={setExpiry} testId="invite-expiry" verb="ends" />
        <div className={styles.row}>
          <label className={styles.inlineLabel}>
            Uses
            <Tooltip
              label="How many people can use it"
              hint="One is safest. Raise it to send one link to a whole group."
            >
              <input
                className={`${styles.input} ${styles.number}`}
                inputMode="numeric"
                value={maxUses}
                data-testid="invite-max-uses"
                onChange={(event) => {
                  setMaxUses(event.target.value);
                }}
              />
            </Tooltip>
          </label>
          <Tooltip
            label="Approve automatically"
            hint={
              inviteRole === "admin"
                ? "Not for an admin invite: an owner or admin approves each new admin."
                : "Off: each new member waits for an owner or admin to approve them. On: they are in at once."
            }
          >
            <label className={styles.inlineLabel}>
              <input
                className={styles.checkbox}
                type="checkbox"
                checked={autoApprove}
                disabled={inviteRole === "admin"}
                data-testid="invite-auto-approve"
                onChange={(event) => {
                  setAutoApprove(event.target.checked);
                }}
              />
              Approve automatically
            </label>
          </Tooltip>
        </div>
        <p className={styles.hint}>
          {endsMs === null ? "Pick when the invite ends." : `Ends ${whenWords(new Date(endsMs))}.`}{" "}
          {inviteRole === "viewer" ? "A" : "An"} {ROLE_WORDS[inviteRole].toLowerCase()} invite for{" "}
          {uses === 1 ? "one person" : `${maxUses} people`}
          {autoApprove ? ", let in at once." : ", each approved by an owner or admin."}
        </p>
        <SheetButton
          kind="primary"
          tooltip="Make the invite"
          hint="Makes a link to send to your teammate. Nothing is sent for you."
          whyDisabled={why}
          testId="invite-create"
          onClick={() => void account.createInvite({ role: inviteRole, expiry, maxUses: uses, autoApprove })}
        >
          Make invite
        </SheetButton>
      </div>

      {last === null ? null : <InviteLink invite={last} />}

      {state.team?.invites.length === 0 ? (
        <p className={styles.hint} data-testid="invites-none">
          No invites yet.
        </p>
      ) : (
        <ul className={styles.list} data-testid="invites-list">
          {state.team?.invites.map((invite) => (
            <InviteRow key={invite.code} invite={invite} />
          ))}
        </ul>
      )}
    </section>
  );
}

function InviteLink({ invite }: { invite: Invite }) {
  // In the desktop app the page is zenith://app/, which nobody else can open (sweep D12).
  const link = joinLink(invite.code, linkPageUrl(window.location.href));
  return (
    <div className={styles.row} data-testid="invite-link">
      <span className={styles.link} title={link} data-testid="invite-link-text">
        {link}
      </span>
      <RowButton
        icon={Copy}
        label="Copy the invite link"
        hint="Send it to your teammate by any message you like."
        testId="invite-link-copy"
        onClick={(event) => {
          void copyText("the invite link", link, {
            select: event.currentTarget.closest('[data-testid="invite-link"]')?.querySelector('[data-testid="invite-link-text"]') ?? null,
          });
        }}
      />
    </div>
  );
}

function InviteRow({ invite }: { invite: Invite }) {
  const [extending, setExtending] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [choice, setChoice] = useState<InviteExpiryChoice>({ kind: "days", days: 7 });
  const nowMs = Date.now();
  const live = inviteState(invite, nowMs);
  const testId = `invite-row-${invite.code.slice(0, 8)}`;
  // A used-up invite lets nobody else in, so more time would do nothing; a new invite would.
  const closed = invite.revoked
    ? "A revoked invite stays revoked; make a new one."
    : live === "usedUp"
      ? "Every use of this invite is taken, so more time would not help. Make a new invite instead."
      : null;
  return (
    <li className={styles.item} data-testid={testId} data-state={live}>
      <div className={styles.itemMain}>
        <span className={styles.itemTitle}>
          {ROLE_WORDS[invite.role]} invite{invite.autoApprove ? ", approved automatically" : ""}
        </span>
        <span className={styles.itemMeta}>
          <span data-testid={`${testId}-left`}>{inviteStateWords(invite, nowMs)}</span>
          <span className={styles.mono}>
            {String(invite.uses)} of {String(invite.maxUses)} used
          </span>
          <span>ends {whenWords(invite.expiresAt)}</span>
        </span>
      </div>
      <div className={styles.itemActions}>
        <SheetButton
          kind="text"
          tooltip="Extend"
          hint="Give the invite more time, from its current end."
          whyDisabled={closed}
          testId={`${testId}-extend`}
          onClick={() => {
            setExtending(!extending);
          }}
        >
          Extend
        </SheetButton>
        <SheetButton
          kind="text"
          tooltip="Revoke"
          hint="Stop anyone else joining with this invite. Asks first."
          whyDisabled={invite.revoked ? "This invite is already revoked." : null}
          testId={`${testId}-revoke`}
          onClick={() => {
            setRevoking(true);
          }}
        >
          Revoke
        </SheetButton>
      </div>
      {extending && closed === null ? (
        <div className={styles.itemFollowUp}>
          <ExpiryPicker
            value={choice}
            onChange={setChoice}
            testId={`${testId}-extend-by`}
            verb="extends"
            startMs={invite.expiresAt.getTime()}
          />
          <SheetButton
            tooltip="Extend the invite"
            testId={`${testId}-extend-apply`}
            onClick={() => {
              void account.extendInvite(invite.code, choice).then((done) => {
                if (done) setExtending(false);
              });
            }}
          >
            Apply
          </SheetButton>
        </div>
      ) : null}
      {revoking && !invite.revoked ? (
        <ConfirmRow
          testId={`${testId}-revoke-confirm`}
          confirmTestId={`${testId}-revoke-yes`}
          sentence="Revoke this invite? Nobody else can join with it. Nobody who already joined is removed."
          verb="Revoke"
          verbHint="This cannot be undone."
          onConfirm={() => void account.revokeInvite(invite.code)}
          onCancel={() => {
            setRevoking(false);
          }}
        />
      ) : null}
    </li>
  );
}

function Settings() {
  const state = useAccount();
  const role = account.role();
  const why = whyCannotEditSettings(role);
  const settings = state.team?.settings;
  if (settings === undefined) return null;
  const toggle = (
    key: "editorsMayProposeShare" | "editorsMayLinkShare" | "publishOnSave" | "membersMayApproveDevices",
    label: string,
    does: string,
  ) => (
    <Tooltip label={label} hint={why === null ? does : `Unavailable: ${why}`}>
      <label className={styles.inlineLabel}>
        <input
          className={styles.checkbox}
          type="checkbox"
          checked={settings[key]}
          aria-disabled={why !== null}
          disabled={why !== null}
          data-testid={`settings-${key}`}
          onChange={(event) => void account.updateSettings({ [key]: event.target.checked })}
        />
        {label}
      </label>
    </Tooltip>
  );
  return (
    <section className={styles.section} data-testid="teams-settings">
      <h3 className={styles.sectionHead}>Settings</h3>
      <div className={styles.stack}>
        {toggle(
          "editorsMayProposeShare",
          "Editors may share at the propose level",
          "Off by default: only owners and admins let other teams propose changes.",
        )}
        {toggle(
          "editorsMayLinkShare",
          "Editors may make anyone-with-the-link shares",
          "Off by default: only owners and admins make a share that anyone with the link can open.",
        )}
        {toggle(
          "publishOnSave",
          "Publish on every save",
          "Each time a member saves an auto, it is also published to the team library as a new revision.",
        )}
        {toggle(
          "membersMayApproveDevices",
          "Any member may approve a teammate's new device",
          "Off by default: a member's new device is approved by one of their own devices, or by an owner or admin. Changing it also makes a new team key when this device can, so teammates' apps know who may approve.",
        )}
      </div>
    </section>
  );
}

function Activity() {
  const state = useAccount();
  const names = new Map((state.team?.members ?? []).map((m) => [m.uid, m.displayName]));
  const entries = state.team?.activity ?? [];
  const nowMs = Date.now();
  return (
    <section className={styles.section} data-testid="teams-activity">
      <h3 className={styles.sectionHead}>Activity</h3>

      {entries.length === 0 ? (
        <p className={styles.hint}>Nothing yet.</p>
      ) : (
        <ul className={styles.list}>
          {entries.slice(0, 50).map((entry) => (
            <li key={entry.id} className={styles.item}>
              <div className={styles.itemMain}>
                <span className={styles.itemTitle}>{activityWords(entry, names)}</span>
                <span className={styles.itemMeta}>
                  <Tooltip label={whenWords(entry.at)}>
                    <span tabIndex={0}>{timeAgo(entry.at, nowMs)}</span>
                  </Tooltip>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LeaveOrDelete() {
  const state = useAccount();
  const role = account.role();
  const team = state.memberships.find((m) => m.teamId === state.teamId)?.team ?? null;
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [leaving, setLeaving] = useState(false);
  const leaveWhy = whyCannotLeave(role);
  const deleteWhy = whyCannotDeleteTeam(role);
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionHead}>Leave or delete</h3>
      <div className={styles.row}>
        <SheetButton
          tooltip="Leave team"
          hint="Asks you first. You lose access to its library at once."
          whyDisabled={leaveWhy}
          testId="teams-leave"
          onClick={() => {
            setTyping(false);
            setLeaving(true);
          }}
        >
          Leave team
        </SheetButton>
        <SheetButton
          tooltip="Delete team"
          hint="Asks you to type the team's name first."
          whyDisabled={deleteWhy}
          testId="teams-delete"
          onClick={() => {
            setLeaving(false);
            setTyping(true);
          }}
        >
          Delete team
        </SheetButton>
      </div>
      {leaveWhy === null ? null : (
        <p className={styles.hint} data-testid="teams-leave-why">
          {leaveWhy}
        </p>
      )}
      {leaving && leaveWhy === null && team !== null ? (
        <ConfirmRow
          testId="teams-leave-confirm"
          confirmTestId="teams-leave-yes"
          cancelTestId="teams-leave-keep"
          sentence={
            <>
              Leave <strong>{team.name}</strong>? You lose access to its library at once, and only a new invite from an
              owner or admin lets you back in.
            </>
          }
          verb="Leave team"
          onConfirm={() => {
            setLeaving(false);
            void account.leaveTeam();
          }}
          onCancel={() => {
            setLeaving(false);
          }}
        />
      ) : null}
      {typing && deleteWhy === null && team !== null ? (
        <ConfirmRow
          testId="teams-delete-confirm"
          confirmTestId="teams-delete-yes"
          sentence={
            <>
              This revokes every share the team made, which stay as revoked records, then deletes its members, invites,
              settings, activity log and library. A claim on its number that has review history is kept, held by no
              team. The team cannot be made again under the same id. Type <strong>{team.name}</strong> to confirm.
            </>
          }
          verb="Delete team"
          verbHint="This cannot be undone."
          whyDisabled={typed.trim() === team.name ? null : `Type ${team.name} exactly.`}
          onConfirm={() => void account.deleteTeam(typed)}
          onCancel={() => {
            setTyping(false);
            setTyped("");
          }}
        >
          <Tooltip label="Team name" hint="Type it exactly as shown.">
            <input
              className={styles.input}
              aria-label="Type the team's name to confirm"
              value={typed}
              data-testid="teams-delete-typed"
              onChange={(event) => {
                setTyped(event.target.value);
              }}
            />
          </Tooltip>
        </ConfirmRow>
      ) : null}
    </section>
  );
}
