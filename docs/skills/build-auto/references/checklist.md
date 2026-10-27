# The auto checklist

Eighteen numbered items plus two lettered ones (1b, 11b). Every one is a mistake that has already been
made, on the date given, most of them while building a BIOBUZZ auto that aimed at three tips. Work them in
order; the verification block only means something if the build block above it was followed. Where an
item needs a robot-specific name (a class, a log key, a test), the robot repository's
`references/robot.md` supplies it.

Where a Zenith check catches the item, its finding code is named. **A check that catches it is a floor,
not proof**: the checks read the field and robot files, and those files can be wrong about the real field
(item 13 is the case that already happened). Where no code is named, only you or the headless run catch it.

## Before building

**1. Freshness.** In a robot repository, `git merge-base --is-ancestor origin/main HEAD` must succeed; if
it does not, merge first and re-open the project.
*Why:* an auto was written against the single-intake robot three days after `main` replaced it with two
mouths, one column and three sensors. It worked on its own branch and broke on contact (2026-09-22).

**1b. Audit before building.** List the project's autos (and, in a robot repository, its sim write-ups)
in full; read anything whose name overlaps the brief; evolve what is there.
*Why:* prior sessions scaffold ahead, and a targeted search only finds the duplicate you already suspected.

**2. Read the robot as it is.** `zenith.project.open` for the registry and footprint; in a robot
repository, what the registry names stand for. Name the archetype in the plan: mouths, where, how wide,
capacity, what "full" means.
*Why:* names change under an auto: a "hopper full" helper became a three-sensor column check, and a
ramp became a feed latch, within one week.

**3. Arithmetic before any pose.** From the season ledger: pieces needed for the goal, pieces available by
source within reach, scores affordable, remainder. Write it in the plan.
*Why:* a pose is an answer to a question the arithmetic asks. Choosing poses first means tuning a routine
that was never going to reach its goal.

**4. Time budget.** 30 s. Estimate every leg from the robot's measured speeds (`references/robot.md`),
total it, and say which score lands late if it runs over. `TIME_BUDGET` checks the file's own estimate afterwards.
*Why:* a plan's third tip landed at about 40 s. That is a fine answer, but it has to be
stated, not discovered by a human in a replay.

## While building

**5. Tangent legs.** Every leg tangent to the path unless a mouth must lead; turns where the robot is
stationary, i.e. during a volley. Partly `HEADING` / `MOUTH_LEADING`.
*Why:* a turn mid-leg costs time twice and points the mouth away from the pieces the leg was meant to take.

**6. Sweeps.** Mouth leading, at most 0.4 of max speed, stopping inside the gap to the next piece. Never
sweep a row sideways with a body wider than the mouth. `SWEEP_SPEED`, `MOUTH_LEADING`.
*Why:* at full speed the stopping distance exceeded the gap to the fifth ball, the bumper shoved it out of
reach, and the auto got two tips instead of three. Capping the sweeps at 0.4 fixed it (2026-09-21).

**7. Nearest source first, among the sources that work.** The ledger says which sources can actually be
collected, and from where.
*Why:* a piece that has sat at a published position since kickoff is both nearer and more certain than
one a score has just thrown somewhere.

**8. Legal approach at the right moment.** Each shoot pose must be legal for the goal state **at that
point in the routine**. `LEGAL_APPROACH` checks the pose; only you track the state change a score causes.
*Why:* a BIOBUZZ tip swaps which cell is up. A shoot pose legal for volley two is on the wrong side of the
hive for volley three.

**9. Robot-clock waits only.** In a robot repository, a wait is a command timed on the robot's clock,
never SolversLib's `WaitCommand`; per-step timeouts come from the previous run's measured
durations. `TIMEOUT_TIGHT`.
*Why:* `WaitCommand` reads the wall clock. Under the sim's fake clock a 250 ms wait lasted 30 simulated
seconds and every later step ran off the end of the match (2026-09-21).

**10. Start heading and labels.** Do not turn while touching a wall with pieces nearby. No literal pose
without a provenance label (`PROVENANCE`); a pose written for one alliance goes through the mirroring the
file declares, never copied by hand. `START_ILLEGAL`.
*Why:* the body sweeps through the pieces it is about to collect; an unlabelled number is
indistinguishable from a measured one six weeks later; a hand-mirrored pose works on one side only.

## Verification, in this order

**11. Zero errors, then the estimate and the picture.** `errors` is `0`; `zenith.estimate` agrees with
item 4 or the disagreement is explained; `zenith.render` is attached.

**11b. The match clock.** Where the robot repository has a headless harness, the test runs the auto the
way the field does: it stops the OpMode at 30 s, zeroes every motor, lets the field finish through the
8 s transition, and counts a score as AUTO only if it completes before TELEOP. Assert the scores counted
as AUTO.
*Why:* on 2026-09-21 the only run was 50 s long and its tips were judged against 30 s by hand; a tip that
started at 39.6 s was reported as part of the result.

**12. Determinism.** The match run twice gives identical decoded logs; the same auto on the other
alliance scores the same.
*Why:* this is the premise of the loop, and a mirroring slip shows up only on the other alliance.

**13. No structure contact.** The harness's structure-contact log reads "none" over the run, except
against a goal you are deliberately pressed against (a flower you are pulling from), and nothing is pressed
against a structure for over a second. `STRUCTURE` is the floor, not the proof.
*Why:* on the realistic field a plan's cross-field leg ran into the hive's west frame bar and pushed
against it for 12.7 s until the buzzer (2026-09-22). The field file then had no frame bars, so
`STRUCTURE` could not have caught it.

**14. Strafe fraction** under 20 % of the driving distance, from the true motion. `STRAFE_FRACTION`
estimates it; a harness's run report measures it.
*Why:* strafing is slower to accelerate and much slower to stop than driving. A routine that strafes a lot
is a routine whose headings are wrong.

**15. The piece ledger closes.** Launched plus held plus loose plus scored equals the pieces on the field,
every tick. `CAPACITY` / `EMPTY_SHOT` catch the plan-level version.
*Why:* it catches a piece collected twice, or a shot fired from an empty robot.

**16. Belief agrees with truth.** The robot's own count of scores equals the sim's; the pose the robot
believes is within a couple of inches of where it is.
*Why:* the robot cannot see a tip. When belief and truth disagree, the turret aims at a cell that is down.

**17. Write it up.** In a robot repository, a short write-up beside its other sim notes: timings,
what was learned, every `SET FROM SIM` pose by name, and what a human should see in AdvantageScope and what
would be wrong.

**18. Human items.** Poses to measure on the real field; assumed geometry to confirm (mouth offsets and
depths are guesses until someone measures them); the replay to open, with a clickable path, proof it
exists, and the command that regenerates it.
