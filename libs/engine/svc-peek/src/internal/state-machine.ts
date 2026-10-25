// The states of one peek execution (M1-14, blueprint 5.5). The rescue and guard states of M1-13 and
// M1-15 join this table then; until they do, a hold goes `acquiring` -> `returning` -> `settled`, or
// ends in `incident` from any state that can reach it. Terminal states never move.
export type ExecutorState =
  | 'idle'
  | 'acquiring'
  | 'returning'
  | 'settled'
  | 'incident';

const NEXT: Readonly<Record<ExecutorState, readonly ExecutorState[]>> = {
  idle: ['acquiring', 'incident'],
  acquiring: ['returning', 'incident'],
  returning: ['settled', 'incident'],
  settled: [],
  incident: [],
};

export function canMove(from: ExecutorState, to: ExecutorState): boolean {
  return NEXT[from].includes(to);
}

/** One execution's state. An illegal move is a programming error, so it throws. */
export class StateMachine {
  #state: ExecutorState = 'idle';

  get state(): ExecutorState {
    return this.#state;
  }

  move(to: ExecutorState): void {
    if (!canMove(this.#state, to)) {
      throw new Error(`illegal peek transition ${this.#state} -> ${to}`);
    }
    this.#state = to;
  }
}
