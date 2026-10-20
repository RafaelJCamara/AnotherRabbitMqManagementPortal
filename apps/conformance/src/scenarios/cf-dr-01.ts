// CF-DR-01: does a return that is not a failure (`basic.nack` with requeue, or the management API's
// nack-and-requeue read, a side-effect-aware peek) hide the message under `x-delayed-retry-type`
// `all`, `failed` and `returned`, and what do the management stats then show?
//
// Per type, and for a control queue with no delayed retry, on two legs (`nack`, `http`): a quorum
// queue holding a message `m` and, behind it, a message `t` that tells where `m` lands. `m` is
// returned, then every queue is read right away, after 2.5 s and after about 6 s (the minimum is
// 5 s), each read with `basic.get` and with the stats of the queue. The window is bracketed by
// fixed waits, never measured. Only the status of a stats read is recorded: the statistics refresh
// on their own interval, so what they show at a fixed moment is not reproducible (OQ-632, OQ-647;
// freshness of `messages_delayed` and `next_delayed_at`: OQ-519, OQ-558). The evidence is the reads.
import {
  declareQueue,
  defineScenario,
  get,
  mgmtGet,
  mgmtQueue,
  publish,
  settle,
  wait,
  type LabStep,
} from '../dsl.ts';

/** The delayed-retry types; `disabled` is the control (the queue sets no delayed-retry argument). */
export const DR_TYPES = ['all', 'failed', 'returned', 'disabled'] as const;
export const DR_LEGS = ['nack', 'http'] as const;
/** `x-delayed-retry-min`, in ms; the maximum is left unset (it defaults to the minimum). */
export const MIN_MS = 5000;
/** The fixed waits between the three reads, in ms: reads at 0, 2.5 s and about 6 s. */
export const WAITS_MS = [2500, 3500] as const;
export const SLOTS = ['now', 'mid', 'end'] as const;

const queues = DR_LEGS.flatMap((leg) =>
  DR_TYPES.map((type) => ({ leg, type, queue: `${leg}-${type}` })),
);

const reads = (slot: (typeof SLOTS)[number]): LabStep[] =>
  queues.flatMap(({ queue }) => [
    get(`${queue}-${slot}`, queue),
    mgmtQueue(`${queue}-stats-${slot}`, queue),
  ]);

export const cfDr01 = defineScenario({
  cfId: 'CF-DR-01',
  title:
    'Quorum queue: a message returned without failure under each x-delayed-retry-type, read at 0, 2.5 s and about 6 s',
  protocol: 'amqp091',
  steps: [
    ...queues.flatMap(({ type, queue }) => [
      declareQueue(queue, {
        type: 'quorum',
        arguments: {
          'x-delivery-limit': 20,
          ...(type === 'disabled'
            ? {}
            : {
                'x-delayed-retry-type': type,
                'x-delayed-retry-min': MIN_MS,
              }),
        },
      }),
      publish(queue, `${queue}-m`),
      publish(queue, `${queue}-t`),
    ]),
    ...queues.flatMap(({ leg, queue }) =>
      leg === 'nack'
        ? [
            get(`${queue}-first`, queue),
            settle(`${queue}-first`, { kind: 'nack', requeue: true }),
          ]
        : [mgmtGet(`${queue}-read`, queue, { ackmode: 'ack_requeue_true' })],
    ),
    ...reads('now'),
    wait(WAITS_MS[0]),
    ...reads('mid'),
    wait(WAITS_MS[1]),
    ...reads('end'),
  ],
});
