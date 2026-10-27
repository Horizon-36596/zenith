/**
 * The fake cloud's switch-user control (`?cloud=fake` only): every user the in-memory cloud holds a
 * profile for, and the demonstration reviewer of the `#/admin` page, one click away, so a test or a
 * demonstration can play two teams on one page. Switching asks nothing. The real cloud never shows
 * this.
 */
import { FAKE } from "../admin/fakeVerification";
import { SheetButton } from "../cloud/controls";
import { account, signInAsDemoReviewer, useAccount } from "./store";
import styles from "./account.module.css";

export function FakeUsers() {
  const state = useAccount();
  if (!account.isFake()) return null;
  const me = state.user?.uid ?? null;
  // The demonstration reviewer has its own button below, so it is not listed twice.
  const others = account.fakeUsers().filter((user) => user.uid !== me && user.uid !== FAKE.reviewer);
  return (
    <section className={styles.section} data-testid="fake-users">
      <h3 className={styles.sectionHead}>Test users (fake cloud only)</h3>

      <div className={styles.row}>
        {others.map((user) => (
          <SheetButton
            key={user.uid}
            tooltip={`Switch to ${user.displayName}`}
            hint="Signs this page's fake cloud in as them, with their teams and their shares."
            whyDisabled={state.busy ? "Busy with the last request." : null}
            onClick={() => void account.switchFakeUser(user.uid)}
            testId={`fake-switch-${user.uid}`}
          >
            {user.displayName}
          </SheetButton>
        ))}
        <SheetButton
          kind="text"
          tooltip="Sign in as the demonstration reviewer"
          hint="Adds the review page's demonstration teams, requests and disputes, and signs in as their Horizon admin, so #/admin has a queue to work."
          whyDisabled={state.busy ? "Busy with the last request." : null}
          onClick={() => void signInAsDemoReviewer()}
          testId="fake-demo-reviewer"
        >
          Demonstration reviewer
        </SheetButton>
      </div>
      {state.user === null || state.profile === null ? null : <FakeDevices />}
    </section>
  );
}

/**
 * The fake cloud's devices: this page can be another device of the same member, with keys of its
 * own, to try a new laptop waiting for the team key and its approval from the first device.
 */
function FakeDevices() {
  const state = useAccount();
  const device = state.fakeDevice;
  if (device === null) return null;
  const busy = state.busy ? "Busy with the last request." : null;
  return (
    <div className={styles.stack} data-testid="fake-devices">
      <p className={styles.hint} data-testid="fake-device-now">
        This page is fake device {String(device.index + 1)} of {String(device.count)}.
      </p>
      <div className={styles.row}>
        {Array.from({ length: device.count }, (_, index) => index)
          .filter((index) => index !== device.index)
          .map((index) => (
            <SheetButton
              key={index}
              tooltip={`Switch to fake device ${String(index + 1)}`}
              hint="Signs the same user in on that simulated device."
              whyDisabled={busy}
              onClick={() => void account.switchFakeDevice(index)}
              testId={`fake-device-${String(index + 1)}`}
            >
              Device {String(index + 1)}
            </SheetButton>
          ))}
        <SheetButton
          kind="text"
          tooltip="Use another device"
          hint="Signs the same user in on a new simulated device, as a member's new laptop would be."
          whyDisabled={busy}
          onClick={() => void account.switchFakeDevice("new")}
          testId="fake-device-new"
        >
          Another device
        </SheetButton>
      </div>
    </div>
  );
}
