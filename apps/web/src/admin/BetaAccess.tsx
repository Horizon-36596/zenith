/**
 * The admin page's Beta access view (owner rulings 2026-10-02 and 2026-10-03): the beta testers, to
 * remove; a form to add a tester or an admin by the user code the person sent; and the Horizon
 * admins, to add and remove. Nobody can ask for access from the app (issue #99), so there is no list
 * of requests. Nobody removes themselves, so no admin locks themselves out. Adding or removing an
 * admin asks once more first.
 *
 * Listing writes a `beta.list` entry to the admin access log before the read, and every decision
 * writes its own entry in the same write (spec 13 section 13).
 */
import { useEffect, useState } from "react";
import type { BetaAccessLists, CloudBackend } from "@horizon36596/zenith-cloud";
import {
  adminName,
  grantErrorWords,
  isAdmin,
  makeAdminProblem,
  MAX_NAME,
  nameProblem,
  removeAdminProblem,
  testerCountWords,
  userCodeProblem,
} from "./betaAccessModel";
import { ConfirmRow } from "../components/ConfirmRow";
import { ActionButton, TextField } from "./controls";
import { logAdminAccess } from "./store";
import styles from "./admin.module.css";
import { cloudErrorSentence } from "../cloud/errorSentence";

function message(error: unknown): string {
  return cloudErrorSentence(error);
}

/** A change to the admins list, waiting for the admin to confirm it. */
/** The change waiting for its second step: make or remove an admin, or take a tester off the list. */
type Pending = { kind: "add" | "remove" | "removeTester"; uid: string; name: string };

const PENDING_WORDS: Readonly<Record<Pending["kind"], { title: string; verb: string }>> = {
  add: { title: "Make a Horizon admin", verb: "Make admin" },
  remove: { title: "Remove a Horizon admin", verb: "Remove admin" },
  removeTester: { title: "Take someone off the beta", verb: "Remove" },
};

export function BetaAccess({ backend, generation }: { backend: CloudBackend; generation: number }) {
  const [lists, setLists] = useState<BetaAccessLists | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const me = backend.currentUser()?.uid ?? "";

  useEffect(() => {
    let live = true;
    void (async () => {
      setError(null);
      try {
        await logAdminAccess(backend, "beta.list");
        const next = await backend.listBetaAccess();
        if (live) setLists(next);
      } catch (err) {
        if (live) setError(message(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [backend, generation, reload]);

  /**
   * Sends one change, then reads the lists again. `failed` words the error, for the adds another
   * admin may already have made.
   */
  const change = async (
    run: () => Promise<{ sent: Promise<void> }>,
    done: string,
    after?: () => void,
    failed: (error: unknown) => string = message,
  ) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await (await run()).sent;
      setNotice(done);
      after?.();
      setReload((n) => n + 1);
    } catch (err) {
      setError(failed(err));
    } finally {
      setBusy(false);
    }
  };

  const whyBusy = busy ? "A change is on its way." : null;
  const formProblem = userCodeProblem(code) ?? nameProblem(name);

  return (
    <>
      <div className={styles.queue}>
        {lists === null && error === null ? (
          <div className={styles.section}>
            <p className={styles.prose}>Loading the lists…</p>
          </div>
        ) : null}
        {lists === null ? null : (
          <>
            <div className={styles.section}>
              <h3 className={styles.sectionHead}>Beta testers</h3>
              <p className={styles.hint} data-testid="admin-beta-tester-count">{testerCountWords(lists.testers.length)}</p>
              {lists.testers.length === 0 ? null : (
                <ul className={styles.list} data-testid="admin-beta-testers">
                  {lists.testers.map((tester) => (
                    <li key={tester.uid} className={styles.listItem} data-testid={`admin-beta-tester-${tester.uid}`}>
                      <span>{tester.name}</span>
                      <span className={styles.meta}>
                        <span className={styles.mono}>{tester.uid}</span>
                      </span>
                      <div className={styles.row}>
                        <ActionButton
                          tooltip="Remove"
                          hint="Takes this person off the beta list. Their profile and teams stay, but they cannot make a new profile or join a team. Asks once more first."
                          whyDisabled={whyBusy}
                          onClick={() => {
                            setPending({ kind: "removeTester", uid: tester.uid, name: tester.name });
                          }}
                          testId={`admin-beta-remove-${tester.uid}`}
                        >
                          Remove
                        </ActionButton>
                        {isAdmin(lists, tester.uid) ? null : (
                          <ActionButton
                            kind="text"
                            tooltip="Make admin"
                            hint="Makes this person a Horizon admin. Asks once more first."
                            whyDisabled={whyBusy}
                            onClick={() => {
                              setPending({ kind: "add", uid: tester.uid, name: tester.name });
                            }}
                            testId={`admin-beta-tester-make-admin-${tester.uid}`}
                          >
                            Make admin
                          </ActionButton>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className={styles.section}>
              <h3 className={styles.sectionHead}>Horizon admins</h3>
              <p className={styles.prose}>Nobody can remove themselves.</p>
              <ul className={styles.list} data-testid="admin-beta-admins">
                {lists.admins.map((admin) => (
                  <li key={admin.uid} className={styles.listItem} data-testid={`admin-beta-admin-${admin.uid}`}>
                    <span>{admin.uid === me ? `${adminName(admin)} (you)` : adminName(admin)}</span>
                    <span className={styles.meta}>
                      <span className={styles.mono}>{admin.uid}</span>
                    </span>
                    <div className={styles.row}>
                      <ActionButton
                        tooltip="Remove admin"
                        hint="Takes away this person's Horizon admin access. Asks once more first."
                        whyDisabled={whyBusy ?? removeAdminProblem(admin.uid, me)}
                        onClick={() => {
                          setPending({ kind: "remove", uid: admin.uid, name: adminName(admin) });
                        }}
                        testId={`admin-beta-remove-admin-${admin.uid}`}
                      >
                        Remove admin
                      </ActionButton>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
      <div className={styles.detail}>
        {error === null ? null : <p className={styles.error} data-testid="admin-error">{error}</p>}
        {notice === null ? null : <p className={styles.prose} data-testid="admin-notice">{notice}</p>}
        {pending === null ? null : (
          <div className={styles.section}>
            <h3 className={styles.sectionHead}>{PENDING_WORDS[pending.kind].title}</h3>
            <ConfirmRow
              testId="admin-beta-confirm"
              confirmTestId="admin-beta-confirm-yes"
              cancelTestId="admin-beta-confirm-no"
              sentence={
                pending.kind === "add"
                  ? `${pending.name} will read every review, share and bug report, decide them, and change these lists.`
                  : pending.kind === "remove"
                    ? `${pending.name} will no longer open this page. Their account and teams stay.`
                    : `Take ${pending.name} off the beta list? Their profile and teams stay, but they cannot make a new profile or join a team.`
              }
              verb={PENDING_WORDS[pending.kind].verb}
              verbHint="Sends the change, with an entry in the admin access log."
              whyDisabled={whyBusy ?? (pending.kind === "add" && lists !== null ? makeAdminProblem(lists, pending.uid) : null)}
              onConfirm={() => {
                const { kind, uid, name: who } = pending;
                if (kind === "removeTester") {
                  void change(() => backend.removeBetaTester(uid), `Took ${who} off the beta list.`, () => {
                    setPending(null);
                  });
                  return;
                }
                void change(
                  () => (kind === "add" ? backend.addHorizonAdmin({ uid, name: who.slice(0, MAX_NAME) }) : backend.removeHorizonAdmin(uid)),
                  kind === "add" ? `${who} is now a Horizon admin.` : `${who} is no longer a Horizon admin.`,
                  () => {
                    setPending(null);
                    if (kind === "add" && uid === code.trim()) {
                      setCode("");
                      setName("");
                    }
                  },
                  kind === "add" ? grantErrorWords : message,
                );
              }}
              onCancel={() => {
                setPending(null);
              }}
            />
          </div>
        )}
        <form
          className={styles.section}
          data-testid="admin-beta-add"
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <h3 className={styles.sectionHead}>Add by user code</h3>

          <TextField
            label="User code"
            tooltip="The code the person copied from the private-beta screen after they signed in."
            value={code}
            onChange={setCode}
            mono
            testId="admin-beta-add-code"
          />
          <TextField label="Name" tooltip="Who they are, for this list. Up to 80 characters." value={name} onChange={setName} testId="admin-beta-add-name" />
          {(code.trim() !== "" || name.trim() !== "") && formProblem !== null ? <p className={styles.hint}>{formProblem}</p> : null}
          <div className={styles.row}>
            <ActionButton
              kind="primary"
              tooltip="Add tester"
              hint="Adds this person to the beta list."
              whyDisabled={whyBusy ?? formProblem}
              onClick={() => {
                const uid = code.trim();
                const who = name.trim();
                void change(
                  () => backend.addBetaTester({ uid, name: who }),
                  `Added ${who} to the beta list.`,
                  () => {
                    setCode("");
                    setName("");
                  },
                  grantErrorWords,
                );
              }}
              testId="admin-beta-add-tester"
            >
              Add tester
            </ActionButton>
            <ActionButton
              tooltip="Add admin"
              hint="Makes this person a Horizon admin. Asks once more first."
              whyDisabled={whyBusy ?? formProblem ?? (lists === null ? null : makeAdminProblem(lists, code.trim()))}
              onClick={() => {
                setPending({ kind: "add", uid: code.trim(), name: name.trim() });
              }}
              testId="admin-beta-add-admin"
            >
              Add admin
            </ActionButton>
          </div>
        </form>
      </div>
    </>
  );
}
