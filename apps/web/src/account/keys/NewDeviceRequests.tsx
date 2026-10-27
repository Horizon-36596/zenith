/**
 * Devices waiting for the team key, for the people who may approve them: owners and admins, the
 * member's own other devices, and any member when the team allows it. Choosing which requests a
 * viewer sees is the caller's job. Each row is compact, with Approve; Approve opens `ApproveWithCode`
 * under the row, in the panel (never a modal), where the approver types the code the device shows.
 */
import { useState } from "react";
import { SheetButton } from "../../cloud/controls";
import { timeAgo } from "../words";
import { ApproveWithCode } from "./ApproveWithCode";
import { requestTitle, type DeviceRequest } from "./logic";
import { DEVICE_REQUESTS } from "./words";
import account from "../account.module.css";

export type { DeviceRequest } from "./logic";

export interface NewDeviceRequestRowProps {
  request: DeviceRequest;
  /** The time "asked 5 minutes ago" is measured from, in epoch milliseconds. */
  nowMs: number;
  /** Approves with the code as typed; rejects as `ApproveWithCode`'s `onApprove` does. */
  onApprove: (deviceId: string, approvalCode: string) => Promise<void>;
  onDecline: (deviceId: string) => void;
  /** True while this request's approval or decline is being written. */
  busy: boolean;
  /** Why the viewer cannot approve this device, or null when they can. */
  whyCannotApprove?: string | null;
}

export function NewDeviceRequestRow({
  request,
  nowMs,
  onApprove,
  onDecline,
  busy,
  whyCannotApprove = null,
}: NewDeviceRequestRowProps) {
  const [open, setOpen] = useState(false);
  const title = requestTitle(request);
  const testId = `device-request-${request.deviceId}`;
  return (
    <li className={account.item} data-testid={testId}>
      <div className={account.itemMain}>
        <span className={account.itemTitle}>{title}</span>
        <span className={account.itemMeta}>
          {request.deviceLabel === null ? null : <span>{request.deviceLabel}</span>}
          <span>{DEVICE_REQUESTS.asked(timeAgo(request.requestedAt, nowMs))}</span>
        </span>
      </div>
      <div className={account.itemActions}>
        <SheetButton
          kind="text"
          tooltip={DEVICE_REQUESTS.approveTooltip(title)}
          hint={DEVICE_REQUESTS.approveHint}
          whyDisabled={whyCannotApprove}
          testId={`${testId}-approve`}
          onClick={() => {
            setOpen(true);
          }}
        >
          {DEVICE_REQUESTS.approve}
        </SheetButton>
      </div>
      {open && whyCannotApprove === null ? (
        <div className={`${account.itemFollowUp} ${account.confirm}`}>
          <ApproveWithCode
            who={request.who}
            deviceLabel={request.deviceLabel}
            kind="device"
            ownDevice={request.isYours}
            busy={busy}
            testId={`${testId}-check`}
            onApprove={(approvalCode) => onApprove(request.deviceId, approvalCode)}
            onDecline={() => {
              setOpen(false);
              onDecline(request.deviceId);
            }}
          />
        </div>
      ) : null}
    </li>
  );
}

export interface NewDeviceRequestListProps {
  /** The requests this viewer may act on, oldest first. The list renders nothing when there are none. */
  requests: readonly DeviceRequest[];
  nowMs: number;
  onApprove: (deviceId: string, approvalCode: string) => Promise<void>;
  onDecline: (deviceId: string) => void;
  /** The device ids whose approval or decline is being written. */
  busyDeviceIds?: ReadonlySet<string>;
  /** Why the viewer cannot approve a given request, or null when they can. */
  whyCannotApprove?: (request: DeviceRequest) => string | null;
}

export function NewDeviceRequestList({
  requests,
  nowMs,
  onApprove,
  onDecline,
  busyDeviceIds,
  whyCannotApprove,
}: NewDeviceRequestListProps) {
  if (requests.length === 0) return null;
  return (
    <section className={account.section} data-testid="device-requests">
      <h3 className={account.sectionHead}>{DEVICE_REQUESTS.heading}</h3>
      <ul className={account.list}>
        {requests.map((request) => (
          <NewDeviceRequestRow
            key={request.deviceId}
            request={request}
            nowMs={nowMs}
            busy={busyDeviceIds?.has(request.deviceId) ?? false}
            whyCannotApprove={whyCannotApprove?.(request) ?? null}
            onApprove={onApprove}
            onDecline={onDecline}
          />
        ))}
      </ul>
    </section>
  );
}
