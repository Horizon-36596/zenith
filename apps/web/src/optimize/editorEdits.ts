import { getState, subscribeEditor, type State } from "../state/store";
import type { EditWatch } from "./host";
import type { OptimizeRequest } from "./protocol";

/**
 * Cancel on an edit, for the editor (issue #306): the watch says the document changed once the open
 * auto, or the robot, field or waypoints it is checked against, is no longer the object the run was
 * started with. The store replaces these objects on every edit and keeps them on everything else (a
 * selection, the playhead, a preference), so an identity test is exactly "an edit happened".
 */

const robotOf = (state: State) => state.autoRobot ?? state.project?.robot ?? null;
const fieldOf = (state: State) => state.autoField ?? state.project?.field ?? null;

/**
 * A watch on the editor's store for a run started on `request`, which was built from the open auto.
 * A run on a draft (Add a clear path here) optimizes the open auto with a step added, so it
 * passes the open auto it was built from as `base`, and only a change to that counts.
 */
export function editsSince(request: OptimizeRequest, base: OptimizeRequest["auto"] = request.auto): EditWatch {
  return {
    subscribe: subscribeEditor,
    changed: () => {
      const state = getState();
      if (state.auto !== base) return true;
      const robot = robotOf(state);
      const field = fieldOf(state);
      // An auto opened without a project (a test, or the moment before one loads) has nothing else to compare.
      if (robot !== null && robot !== request.robot) return true;
      if (field !== null && field !== request.field) return true;
      return state.project !== null && state.project.waypoints !== request.waypoints;
    },
  };
}
