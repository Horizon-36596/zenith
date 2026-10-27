/**
 * The toolbar's run group, left to right, kept apart from the action table so the tour can ask
 * whether any of its buttons is drawn without loading every action (`tour/stops.ts`). Host mode
 * leaves out Save and Propose, which its host bar has instead (`TOOLBAR_GROUPS` in `actions.ts`).
 */
export const RUN_GROUP: readonly string[] = ["run.validate", "view.play", "run.simulate", "run.save", "run.propose"];

/** The ids of the run group that host mode does not draw there. */
export const RUN_GROUP_NOT_IN_HOST: readonly string[] = ["run.save", "run.propose"];
