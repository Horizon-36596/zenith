/**
 * The end-to-end encryption screens (`keys/`), wired to the account model (spec 14):
 *
 * - `RecoveryCodeStep`: the recovery code shown once, after a team is created or when an owner
 *   makes a new one, in place of the Teams sheet's body until the person prints it or ticks it saved.
 * - `KeyWaiting`: a device waiting for the team key, with the approval code to read out and the
 *   recovery code as the other way in. The team library, the share dialog, the Sharing page and the
 *   Teams sheet show it; local mode and link shares keep working meanwhile.
 * - `TeamKeyAlerts`: at the top of the team page, what needs doing now: the rotation banner for
 *   owners and admins, the devices waiting for approval, and requests that match no device.
 * - `TeamKeysSection`: under the privacy section, the devices that hold the key with Revoke, and,
 *   one click away because they are rarely needed, the recovery code and the team safety code.
 */
import { useEffect, useRef, useState } from "react";
import type { KeyRequest, TeamDevice } from "@horizon36596/zenith-cloud";
import { SheetButton } from "../cloud/controls";
import { ConfirmRow } from "../components/ConfirmRow";
import { Tooltip } from "../components/Tooltip";
import {
  DEVICES,
  NewDeviceRequestList,
  RecoveryCodeEntry,
  RecoveryCodeSheet,
  RotationPending,
  TeamSafetyCode,
  WaitingForKey,
  type DeviceRequest,
} from "./keys";
import { isAdminRole } from "./permissions";
import { account, useAccount } from "./store";
import { timeAgo } from "./words";
import styles from "./account.module.css";
import keyStyles from "./keys/keys.module.css";

/** The selected team's name and number, as the key screens name it. */
function useSelectedTeam(): { teamName: string; teamNumber: number | null } | null {
  const state = useAccount();
  const team = state.memberships.find((m) => m.teamId === state.teamId)?.team ?? null;
  return team === null ? null : { teamName: team.name, teamNumber: team.number };
}

/** True when this device is waiting for the selected team's key. */
export function useWaitingForKey(): boolean {
  const state = useAccount();
  return state.keys !== null && state.keys.teamId === state.teamId && state.keys.status?.state === "waiting";
}

/**
 * The recovery code to save, when there is one for a team this person is in; otherwise null. Its
 * Continue acts after Print or the saved tick, and then the code is forgotten.
 */
export function RecoveryCodeStep() {
  const state = useAccount();
  const shown = state.newRecoveryCode;
  if (shown === null) return null;
  const team = state.memberships.find((m) => m.teamId === shown.teamId)?.team ?? null;
  return (
    <RecoveryCodeSheet
      teamName={team?.name ?? "your team"}
      teamNumber={team?.number ?? null}
      code={shown.code}
      madeAt={new Date(shown.madeAtMs)}
      replacing={shown.replacing}
      busy={state.busy}
      onPrint={() => {
        window.print();
      }}
      onSaved={() => {
        account.dismissRecoveryCode();
      }}
    />
  );
}

/**
 * This device is waiting for the team key: the approval code to read out, who approves it, and the
 * recovery code instead. Renders nothing when the device holds the key.
 */
export function KeyWaiting() {
  const state = useAccount();
  const team = useSelectedTeam();
  const [recovering, setRecovering] = useState(false);
  const status = state.keys?.status ?? null;
  if (team === null || status === null || status.state !== "waiting" || state.keys?.teamId !== state.teamId) return null;
  if (recovering) {
    return (
      <RecoveryCodeEntry
        teamName={team.teamName}
        teamNumber={team.teamNumber}
        busy={state.busy}
        onSubmit={async (text) => {
          await account.useRecoveryCode(text);
          setRecovering(false);
        }}
        onCancel={() => {
          setRecovering(false);
        }}
      />
    );
  }
  return (
    <WaitingForKey
      teamName={team.teamName}
      teamNumber={team.teamNumber}
      code={state.keys?.approvalCode ?? ""}
      kind={account.role() === "pending" ? "member" : "device"}
      membersMayApprove={status.membersMayApproveDevices}
      requested={status.requested}
      savedOnDevice={status.savedOnDevice}
      busy={state.busy}
      onAskAgain={() => void account.askForKeyAgain()}
      onUseRecoveryCode={() => {
        setRecovering(true);
      }}
    />
  );
}

/** Why the key could not be read, when it could not; a plain sentence, never a crash. */
export function KeyProblem() {
  const state = useAccount();
  const problem = state.keys?.teamId === state.teamId ? (state.keys?.problem ?? null) : null;
  if (problem === null) return null;
  return (
    <p className={styles.error} role="alert" data-testid="team-key-problem">
      {problem}
    </p>
  );
}

/** The selected team's key state when this device holds the key; otherwise null. */
function useReadyKeys() {
  const state = useAccount();
  const keys = state.keys?.teamId === state.teamId ? state.keys : null;
  const status = keys?.status ?? null;
  return keys === null || status === null || status.state !== "ready" ? null : { keys, status };
}

/** What needs doing now on the team page: a key to rotate, devices waiting, requests to delete. */
export function TeamKeyAlerts() {
  const state = useAccount();
  const role = account.role();
  const ready = useReadyKeys();
  if (ready === null) return null;
  const { keys, status } = ready;
  const admin = isAdminRole(role);
  const why = state.busy ? "Working…" : null;
  const requests: DeviceRequest[] = keys.requests
    .filter((request) => request.kind === "device" && request.matchesDevice)
    .map((request) => ({
      deviceId: request.deviceId,
      who: request.displayName === "" ? "A member" : request.displayName,
      deviceLabel: null,
      code: request.code,
      requestedAt: request.requestedAt,
      isYours: request.isYours,
    }));
  return (
    <>
      {admin && status.rotationPending ? (
        <RotationPending
          busy={state.busy}
          whyCannotRotate={state.online ? null : "Making a new key needs a connection. Try again once this computer is back online."}
          onRotate={() => void account.completeKeyRotation()}
        />
      ) : null}
      <NewDeviceRequestList
        requests={requests}
        nowMs={Date.now()}
        busyDeviceIds={state.busy ? new Set(requests.map((r) => r.deviceId)) : undefined}
        onApprove={(deviceId, approvalCode) => account.grantDevice(deviceId, approvalCode)}
        onDecline={(deviceId) => void account.declineDevice(deviceId)}
      />
      {admin ? <MismatchedRequests requests={keys.requests.filter((request) => !request.matchesDevice)} busyWhy={why} /> : null}
    </>
  );
}

/**
 * The devices that hold the team key, then the recovery code and the team safety code in a
 * disclosure: both are needed rarely (a partner checked once, a code replaced each season), so they
 * stay one click away instead of taking the page.
 */
export function TeamKeysSection() {
  const state = useAccount();
  const role = account.role();
  const ready = useReadyKeys();
  if (ready === null) return null;
  const { keys, status } = ready;
  const why = state.busy ? "Working…" : null;
  return (
    <>
      <Devices devices={keys.devices} admin={isAdminRole(role)} busyWhy={why} />
      <details className={styles.section} data-testid="team-codes">
        <summary className={keyStyles.moreSummary} data-testid="team-codes-open">
          {DEVICES.codes}
        </summary>
        <div className={keyStyles.more}>
          <RecoveryCode owner={role === "owner"} busyWhy={why} />
          <TeamSafetyCode code={status.safetyCode} />
        </div>
      </details>
    </>
  );
}

/**
 * Key requests that match no real device record, for owners and admins, each with Delete. A member
 * can put a request at the id a teammate's next device will have, before that device asks, which
 * keeps the real device from asking; deleting the request lets it ask.
 */
function MismatchedRequests({ requests, busyWhy }: { requests: readonly KeyRequest[]; busyWhy: string | null }) {
  if (requests.length === 0) return null;
  return (
    <section className={styles.section} data-testid="mismatched-requests">
      <h3 className={styles.sectionHead}>Requests that match no device</h3>
      <p className={styles.hint}>They can never be approved, and one can stop a teammate&apos;s real device from asking.</p>
      <ul className={styles.list}>
        {requests.map((request) => (
          <li key={request.deviceId} className={styles.item} data-testid={`mismatched-request-${request.deviceId}`}>
            <div className={styles.itemMain}>
              <span className={styles.itemTitle}>{request.displayName === "" ? "A member" : request.displayName}</span>
            </div>
            <div className={styles.itemActions}>
              <SheetButton
                kind="text"
                tooltip="Delete the request"
                hint="The request cannot be approved. Deleting it lets the real device at that id ask for the key."
                whyDisabled={busyWhy}
                testId={`mismatched-request-${request.deviceId}-delete`}
                onClick={() => void account.declineDevice(request.deviceId)}
              >
                Delete
              </SheetButton>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Why an owner or admin cannot revoke the device they are on. */
const REVOKE_OWN_ADMIN_DEVICE =
  "An owner's or admin's device cannot take the team key from itself: only a new team key keeps a device out, and no device can make one that leaves itself out. Revoke it from another of your devices, or ask another owner or admin.";

/** The devices holding the team key, each with Revoke, which asks first and says the key changes. */
function Devices({ devices, admin, busyWhy }: { devices: readonly TeamDevice[]; admin: boolean; busyWhy: string | null }) {
  const state = useAccount();
  const me = state.user?.uid ?? "";
  const [confirming, setConfirming] = useState<string | null>(null);
  if (devices.length === 0) return null;
  const nowMs = Date.now();
  return (
    <section className={styles.section} data-testid="team-devices">
      <Tooltip label={DEVICES.heading} hint={DEVICES.why} delay="long">
        <h3 className={styles.sectionHead}>{DEVICES.heading}</h3>
      </Tooltip>
      <p className={styles.hint}>{DEVICES.approvers(state.team?.settings?.membersMayApproveDevices ?? false)}</p>
      <ul className={styles.list}>
        {devices.map((device) => {
          const testId = `team-device-${device.deviceId}`;
          const whose = device.uid === me ? "Your device" : `${device.displayName === "" ? "A member" : device.displayName}'s device`;
          const canRevoke = admin || device.uid === me;
          const whyNot = !canRevoke ? "Only owners and admins revoke another member's device." : admin && device.isThisDevice ? REVOKE_OWN_ADMIN_DEVICE : busyWhy;
          return (
            <li key={device.deviceId} className={styles.item} data-testid={testId}>
              <div className={styles.itemMain}>
                <span className={styles.itemTitle}>
                  {whose}
                  {device.isThisDevice ? " (this one)" : ""}
                </span>
                <span className={styles.itemMeta}>
                  <span>approved {timeAgo(device.approvedAt, nowMs)}</span>
                </span>
              </div>
              <div className={styles.itemActions}>
                <SheetButton
                  kind="text"
                  tooltip="Revoke device"
                  hint="Asks first. The device can no longer open the team library, and the team key changes."
                  whyDisabled={whyNot}
                  testId={`${testId}-revoke`}
                  onClick={() => {
                    setConfirming(device.deviceId);
                  }}
                >
                  Revoke
                </SheetButton>
              </div>
              {confirming === device.deviceId ? (
                <ConfirmRow
                  testId={`${testId}-confirm`}
                  confirmTestId={`${testId}-confirm-yes`}
                  sentence={
                    device.isThisDevice
                      ? "Revoke this device? It loses the team library, and an owner or admin then makes a new team key."
                      : `Revoke ${whose.toLowerCase().startsWith("your") ? "your device" : whose}? The team key changes, so it cannot open anything new.`
                  }
                  verb="Revoke"
                  whyDisabled={busyWhy}
                  onConfirm={() => {
                    void account.revokeDevice(device.deviceId).then(() => {
                      setConfirming(null);
                    });
                  }}
                  onCancel={() => {
                    setConfirming(null);
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The recovery code: why it exists, for everyone, and for an owner when to replace it, with New
 * recovery code, which asks first because the old code stops working at once.
 */
function RecoveryCode({ owner, busyWhy }: { owner: boolean; busyWhy: string | null }) {
  const asking = useAccount().askingNewRecoveryCode;
  const section = useRef<HTMLElement>(null);
  // Opened from the notice after a removal, the confirmation may be in the closed disclosure or out
  // of sight: open the disclosure and bring it into view.
  useEffect(() => {
    if (!asking) return;
    const disclosure = section.current?.closest("details");
    if (disclosure) disclosure.open = true;
    section.current?.scrollIntoView?.({ block: "nearest" });
  }, [asking]);
  const setAsking = (next: boolean) => {
    account.askNewRecoveryCode(next);
  };
  return (
    <section ref={section} className={styles.section} data-testid="team-recovery">
      <h3 className={styles.sectionHead}>{DEVICES.recoveryHeading}</h3>
      <p className={styles.hint}>{DEVICES.recoveryWhy}</p>
      {owner ? (
        <div className={styles.row}>
          <SheetButton
            kind="text"
            tooltip="New recovery code"
            hint={`${DEVICES.recoveryWhen} The old code stops working.`}
            whyDisabled={busyWhy}
            testId="team-recovery-new"
            onClick={() => {
              setAsking(true);
            }}
          >
            New recovery code
          </SheetButton>
        </div>
      ) : null}
      {owner && asking ? (
        <div className={styles.confirm} data-testid="team-recovery-confirm">
          <p className={styles.prose}>Make a new recovery code? The old one stops working at once, so print or save the new one now.</p>
          <div className={styles.row}>
            <SheetButton
              tooltip="Make the new code"
              whyDisabled={busyWhy}
              testId="team-recovery-confirm-yes"
              onClick={() => {
                void account.replaceRecoveryCode().then(() => {
                  setAsking(false);
                });
              }}
            >
              Make a new code
            </SheetButton>
            <SheetButton
              kind="primary"
              tooltip="Keep the current code"
              hint="Change nothing."
              onClick={() => {
                setAsking(false);
              }}
            >
              Keep the current code
            </SheetButton>
          </div>
        </div>
      ) : null}
    </section>
  );
}
