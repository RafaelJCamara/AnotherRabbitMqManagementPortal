// CF-DR-02: is a failed return (`basic.reject` with requeue) delayed by `all` and `failed` but not
// by `returned`, and does the delay grow with the delivery count and stop at the maximum?
//
// Per type (and a control with no delayed retry), with minimum 3 s and maximum 6 s:
//   `rej-<type>`   a message `m` with a message `t` behind it, `m` rejected once and read at four
//                  fixed points (0, 1.5 s, 4.5 s, 7.5 s): where it lands and what the counters do.
//   `grow-<type>`  a single message rejected three times; after each reject it is read at the same
//                  four points and the first point at which it is visible is the evidence. Delays of
//                  3 s, 6 s and (capped, uncapped it would be 9 s) 6 s read as points 2, 3 and 3.
// Which point delivers the message is not known when the scenario is written, so the next reject
// settles every point optionally; only the point that delivered it has anything to settle.
import {
  declareQueue,
  defineScenario,
  get,
  publish,
  settle,
  wait,
  type LabStep,
} from '../dsl.ts';

export const DR2_TYPES = ['all', 'failed', 'returned', 'disabled'] as const;
export const MIN_MS = 3000;
export const MAX_MS = 6000;
/** Waits between the four reads of a round, in ms: reads at 0, 1.5 s, 4.5 s and 7.5 s. */
export const WAITS_MS = [1500, 3000, 3000] as const;
export const POINTS = ['p0', 'p1', 'p2', 'p3'] as const;
/** The rejects of a grow queue, each followed by a round of reads. */
export const ROUNDS = 3;

const options = (type: (typeof DR2_TYPES)[number]) => ({
  type: 'quorum' as const,
  arguments: {
    'x-delivery-limit': 20,
    ...(type === 'disabled'
      ? {}
      : {
          'x-delayed-retry-type': type,
          'x-delayed-retry-min': MIN_MS,
          'x-delayed-retry-max': MAX_MS,
        }),
  },
});

/** One round of reads: every queue in `names` at the four points, with the waits between them. */
const round = (names: readonly string[], prefix: string): LabStep[] =>
  POINTS.flatMap((point, n): LabStep[] => [
    ...(n === 0 ? [] : [wait(WAITS_MS[n - 1] ?? 0)]),
    ...names.map((name) => get(`${name}${prefix}${point}`, name)),
  ]);

const rej = DR2_TYPES.map((type) => `rej-${type}`);
const grow = DR2_TYPES.map((type) => `grow-${type}`);

export const cfDr02 = defineScenario({
  cfId: 'CF-DR-02',
  title:
    'Quorum queue: a message rejected with requeue under each x-delayed-retry-type, where it lands and how the delay grows',
  protocol: 'amqp091',
  steps: [
    ...DR2_TYPES.flatMap((type) => [
      declareQueue(`rej-${type}`, options(type)),
      publish(`rej-${type}`, `rej-${type}-m`),
      publish(`rej-${type}`, `rej-${type}-t`),
      declareQueue(`grow-${type}`, options(type)),
      publish(`grow-${type}`, `grow-${type}-m`),
    ]),
    ...[...rej, ...grow].flatMap((name) => [
      get(`${name}-first`, name),
      settle(`${name}-first`, { kind: 'reject', requeue: true }),
    ]),
    // Round 1 reads the probe queues too; later rounds only the grow queues.
    ...round([...rej, ...grow], '-r1-'),
    ...Array.from({ length: ROUNDS - 1 }, (_, n): LabStep[] => [
      ...grow.flatMap((name) =>
        POINTS.map((point) =>
          settle(
            `${name}-r${String(n + 1)}-${point}`,
            { kind: 'reject', requeue: true },
            { optional: true },
          ),
        ),
      ),
      ...round(grow, `-r${String(n + 2)}-`),
    ]).flat(),
  ],
});
