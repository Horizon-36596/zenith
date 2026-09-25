/**
 * The command tree the runtime builds from an auto file (`robot/auto-runtime/AutoBuilder.java`),
 * reduced to what decides timing: SolversLib's `SequentialCommandGroup`, `ParallelCommandGroup`,
 * `ParallelRaceGroup`, `ParallelDeadlineGroup` and `ConditionalCommand`, the runtime's `AutoStep`,
 * `RobotTimeout`, `WaitRobotTime`, `FollowPath` and `PathMarkers`, and Pedro's follower underneath.
 *
 * The life cycle is the scheduler's: `initialize` once, then each tick `execute` and a look at
 * `isFinished`, then `end(interrupted)`. A group initialises its next member in the same pass that
 * ends the one before, so a member starts on the tick its predecessor ends, and every member,
 * however short, is running for at least one tick.
 */
export interface SimCommand {
  initialize(): void;
  execute(): void;
  /** Must give the same answer when asked twice in one pass: groups ask again in `end`. */
  isFinished(): boolean;
  end(interrupted: boolean): void;
}

/** The clock the commands read, in whole ticks so a duration compares exactly. */
export interface SimClock {
  readonly tick: number;
  readonly tickS: number;
}

/** Seconds from `startTick` to now, compared the way `WaitRobotTime` compares nanoseconds. */
export const elapsedAtLeast = (clock: SimClock, startTick: number, seconds: number): boolean =>
  (clock.tick - startTick) * clock.tickS >= seconds - 1e-9;

/** `WaitRobotTime`, and a named command timed by its `estimateS`. Null seconds waits forever. */
export class TimedCommand implements SimCommand {
  private startTick = 0;
  constructor(
    private readonly clock: SimClock,
    private readonly seconds: number | null,
  ) {}
  initialize(): void {
    this.startTick = this.clock.tick;
  }
  execute(): void {}
  isFinished(): boolean {
    return this.seconds !== null && elapsedAtLeast(this.clock, this.startTick, this.seconds);
  }
  end(): void {}
}

/** `InstantCommand`: finishes on its first look. */
export class InstantCommand implements SimCommand {
  initialize(): void {}
  execute(): void {}
  isFinished(): boolean {
    return true;
  }
  end(): void {}
}

/** `SequentialCommandGroup`. */
export class SequenceCommand implements SimCommand {
  private index = 0;
  constructor(private readonly members: readonly SimCommand[]) {}
  initialize(): void {
    this.index = 0;
    this.members[0]?.initialize();
  }
  execute(): void {
    const current = this.members[this.index];
    if (current === undefined) return;
    current.execute();
    if (current.isFinished()) {
      current.end(false);
      this.index += 1;
      this.members[this.index]?.initialize();
    }
  }
  isFinished(): boolean {
    return this.index >= this.members.length;
  }
  end(interrupted: boolean): void {
    if (interrupted) this.members[this.index]?.end(true);
  }
}

/** `ParallelCommandGroup`: ends when every member has. */
export class ParallelAllCommand implements SimCommand {
  private running: boolean[] = [];
  constructor(private readonly members: readonly SimCommand[]) {}
  initialize(): void {
    this.running = this.members.map(() => true);
    for (const member of this.members) member.initialize();
  }
  execute(): void {
    this.members.forEach((member, index) => {
      if (!this.running[index]) return;
      member.execute();
      if (member.isFinished()) {
        member.end(false);
        this.running[index] = false;
      }
    });
  }
  isFinished(): boolean {
    return !this.running.some(Boolean);
  }
  end(interrupted: boolean): void {
    if (!interrupted) return;
    this.members.forEach((member, index) => {
      if (this.running[index]) member.end(true);
    });
  }
}

/** `ParallelRaceGroup`: ends when the first member does; the rest end interrupted. */
export class RaceCommand implements SimCommand {
  private finished = false;
  constructor(readonly members: readonly SimCommand[]) {}
  initialize(): void {
    this.finished = false;
    for (const member of this.members) member.initialize();
  }
  execute(): void {
    for (const member of this.members) {
      member.execute();
      if (member.isFinished()) this.finished = true;
    }
  }
  isFinished(): boolean {
    return this.finished;
  }
  end(): void {
    for (const member of this.members) member.end(!member.isFinished());
  }
}

/** `ParallelDeadlineGroup`: ends when the deadline does; whatever is still running is interrupted. */
export class DeadlineCommand implements SimCommand {
  private running: boolean[] = [];
  private finished = false;
  private readonly members: readonly SimCommand[];
  constructor(deadline: SimCommand, others: readonly SimCommand[]) {
    this.members = [deadline, ...others];
  }
  initialize(): void {
    this.finished = false;
    this.running = this.members.map(() => true);
    for (const member of this.members) member.initialize();
  }
  execute(): void {
    this.members.forEach((member, index) => {
      if (!this.running[index]) return;
      member.execute();
      if (member.isFinished()) {
        member.end(false);
        this.running[index] = false;
        if (index === 0) this.finished = true;
      }
    });
  }
  isFinished(): boolean {
    return this.finished;
  }
  end(): void {
    this.members.forEach((member, index) => {
      if (this.running[index]) member.end(true);
    });
  }
}

/** `ConditionalCommand`: picks a side as it starts and is that side from then on. */
export class ConditionalCommand implements SimCommand {
  private selected: SimCommand;
  constructor(
    private readonly condition: () => boolean,
    private readonly onTrue: SimCommand,
    private readonly onFalse: SimCommand,
  ) {
    this.selected = onTrue;
  }
  initialize(): void {
    this.selected = this.condition() ? this.onTrue : this.onFalse;
    this.selected.initialize();
  }
  execute(): void {
    this.selected.execute();
  }
  isFinished(): boolean {
    return this.selected.isFinished();
  }
  end(interrupted: boolean): void {
    this.selected.end(interrupted);
  }
}
