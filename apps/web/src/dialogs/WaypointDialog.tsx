/**
 * The waypoint questions of issue #134: the name for "Save as waypoint…", the new name for a
 * rename, and Delete or Cancel for a delete. A rename and a delete first say which autos in the
 * project follow the waypoint and what the change does to them (`followersLines`), so no auto is
 * left following a waypoint that is gone without the person being told. `app/waypointDialog.ts`
 * holds the question and `app/waypointEdits.ts` does the edit; this only shows it.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/primitives";
import { closeWaypointQuestion, useWaypointQuestion, type WaypointQuestion } from "../app/waypointDialog";
import {
  addWaypointAt,
  addWaypointFrom,
  deleteWaypointNamed,
  followersLines,
  followersOf,
  renameWaypointTo,
  suggestedNewWaypointName,
  suggestedWaypointName,
  waypointNameProblem,
  type Followers,
} from "../app/waypointEdits";
import { ownerName } from "../app/edits";
import { radToDeg } from "@horizon36596/zenith-core";
import { getState, useEditor } from "../state/store";
import { Modal } from "./Modal";
import styles from "./Dialogs.module.css";
import fields from "../components/fields.module.css";

export function WaypointDialog() {
  const question = useWaypointQuestion();
  if (question === null) return null;
  // Keyed, so a second question starts with its own name and its own list of followers.
  const key =
    question.kind === "add"
      ? `add-${JSON.stringify(question.owner)}`
      : question.kind === "addAt"
        ? `addAt-${JSON.stringify(question.pose)}`
        : `${question.kind}-${question.name}`;
  return <WaypointQuestionDialog key={key} question={question} />;
}

function WaypointQuestionDialog({ question }: { question: WaypointQuestion }) {
  const { project } = useEditor();
  const waypoints = project?.waypoints;
  const adding = question.kind === "add" || question.kind === "addAt";
  const [name, setName] = useState(() =>
    question.kind === "add"
      ? suggestedWaypointName(question.owner)
      : question.kind === "addAt"
        ? suggestedNewWaypointName()
        : question.kind === "rename"
          ? question.name
          : "",
  );
  const nameField = useRef<HTMLInputElement>(null);
  // A suggested name starts selected, so typing replaces it and Enter takes it.
  useEffect(() => {
    if (adding) nameField.current?.select();
  }, [adding]);
  const [followers, setFollowers] = useState<Followers | null>(null);

  useEffect(() => {
    if (question.kind === "add" || question.kind === "addAt") return;
    let live = true;
    void followersOf(question.name, getState()).then((found) => {
      if (live) setFollowers(found);
    });
    return () => {
      live = false;
    };
  }, [question]);

  const trimmed = name.trim();
  const problem =
    question.kind === "delete"
      ? null
      : question.kind === "rename" && trimmed === question.name
        ? null
        : waypointNameProblem(trimmed, waypoints, question.kind === "rename" ? question.name : undefined);
  const unchanged = question.kind === "rename" && trimmed === question.name;
  const waiting = !adding && followers === null;

  const act = (): void => {
    if (problem !== null || waiting || unchanged) return;
    const done =
      question.kind === "add"
        ? addWaypointFrom(question.owner, trimmed)
        : question.kind === "addAt"
          ? addWaypointAt(question.pose, trimmed)
          : question.kind === "rename"
          ? renameWaypointTo(question.name, trimmed)
          : deleteWaypointNamed(question.name);
    if (done) closeWaypointQuestion();
  };

  const title =
    question.kind === "add"
      ? "Save as waypoint"
      : question.kind === "addAt"
        ? "Add waypoint"
        : question.kind === "rename"
        ? `Rename waypoint ${question.name}`
        : `Delete waypoint ${question.name}`;
  const action =
    question.kind === "add" ? "Save waypoint" : question.kind === "addAt" ? "Add waypoint" : question.kind === "rename" ? "Rename" : "Delete";

  return (
    <Modal
      title={title}
      testId="waypoint-dialog"
      width={480}
      onClose={closeWaypointQuestion}
      footer={
        <>
          <Button testId="waypoint-dialog-cancel" onClick={closeWaypointQuestion}>
            Cancel
          </Button>
          {/* A delete has no field, so focus starts on Delete: Del then Enter is the fast path (issue #232). */}
          <Button
            kind="primary"
            testId="waypoint-dialog-confirm"
            whyDisabled={problem ?? (waiting ? "Looking for the autos that follow it first." : unchanged ? "Type a new name first." : null)}
            takeFocus={question.kind === "delete"}
            onClick={act}
          >
            {action}
          </Button>
        </>
      }
    >
      {question.kind === "addAt" ? (
        <p className={styles.prose}>
          A new waypoint at {question.pose.xIn.toFixed(1)}, {question.pose.yIn.toFixed(1)} in, facing{" "}
          {radToDeg(question.pose.headingRad).toFixed(0)}°. No step is added.
        </p>
      ) : question.kind === "add" ? (
        <p className={styles.prose}>
          A new waypoint at the pose {ownerName(question.owner)} stands at. {capitalised(ownerName(question.owner))} then follows
          it.
        </p>
      ) : (
        <div className={styles.lines} data-testid="waypoint-dialog-followers">
          {followers === null ? (
            <p className={styles.prose}>Looking for the autos that follow {question.name}…</p>
          ) : (
            followersLines(question.name, followers, question.kind).map((line) => (
              <p key={line} className={styles.prose}>
                {line}
              </p>
            ))
          )}
        </div>
      )}
      {question.kind === "delete" ? null : (
        <label className={styles.row}>
          <span>{adding ? "Name" : "New name"}</span>
          <input
            className={fields.inputProse}
            data-testid="waypoint-dialog-name"
            ref={nameField}
            value={name}
            autoFocus
            spellCheck={false}
            onChange={(event) => {
              setName(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") act();
            }}
          />
        </label>
      )}
      {problem === null ? null : (
        <p className={styles.hint} data-testid="waypoint-dialog-problem">
          {problem}
        </p>
      )}
    </Modal>
  );
}

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
