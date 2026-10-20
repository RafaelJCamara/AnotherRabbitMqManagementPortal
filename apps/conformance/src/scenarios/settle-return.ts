// The return scenarios of the settle family (M0-38): a quorum message is taken and given back, and
// the lab records where it lands, which counter moved and whether it survives. Queues (the aliases
// assert/projections-settle.ts reads), each holding `<q>-m1` ahead of `<q>-t`:
//   `<limit>-<path>`  one return; limit `unset`, `fin` (2) or `minus1`; path `get`, or `consume`
//                     (cancelled once the delivery arrived, so it is not handed straight back).
//                     The management return has the one path `http` (POST .../get, ack_requeue_true).
//   `unset-rounds`    taken and returned 21 times (default limit + 1); `fin-rounds`: 3 times.
import {
  awaitReady,
  consume,
  declareQueue,
  defineScenario,
  get,
  mgmtGet,
  observe,
  publish,
  settle,
  type LabScenario,
  type LabStep,
} from '../dsl.ts';

export const FIN_LIMIT = 2;
export const UNSET_ROUNDS = 21;

const LIMITS = {
  unset: {},
  fin: { 'x-delivery-limit': FIN_LIMIT },
  minus1: { 'x-delivery-limit': -1 },
};

/** How the message is given back: a 0-9-1 settle with requeue, or the management `/get` that requeues it. */
export type ReturnWith =
  | { readonly kind: 'amqp091'; readonly action: 'nack' | 'reject' }
  | { readonly kind: 'http' };

export function settleReturnScenario(options: {
  cfId: string;
  title: string;
  returnWith: ReturnWith;
}): LabScenario {
  const { returnWith } = options;
  const back = (d: string): LabStep[] =>
    returnWith.kind === 'http'
      ? []
      : [settle(d, { kind: returnWith.action, requeue: true })];
  /** Take one message and give it back. The management get takes and returns in one call. */
  const takeAndReturn = (d: string, q: string): LabStep[] =>
    returnWith.kind === 'http'
      ? [mgmtGet(d, q, { ackmode: 'ack_requeue_true' })]
      : [get(d, q), ...back(d)];
  /** Two messages, then `take` and return, then the wait and the drain. */
  const queue = (
    q: string,
    args: Readonly<Record<string, number>>,
    take: LabStep[],
  ): LabStep[] => [
    declareQueue(q, { type: 'quorum', arguments: { ...args } }),
    publish(q, `${q}-m1`),
    publish(q, `${q}-t`),
    ...take,
    awaitReady(q),
    observe(`${q}-after`, q),
  ];
  const rounds = (q: string, count: number) =>
    Array.from({ length: count }, (_, n) =>
      takeAndReturn(`${q}-r${String(n + 1)}`, q),
    ).flat();
  const single = (l: string, args: Readonly<Record<string, number>>) =>
    returnWith.kind === 'http'
      ? queue(`${l}-http`, args, takeAndReturn(`${l}-http-d`, `${l}-http`))
      : [
          ...queue(`${l}-get`, args, takeAndReturn(`${l}-get-d`, `${l}-get`)),
          ...queue(`${l}-consume`, args, [
            consume(`${l}-consume-d`, `${l}-consume`, 1),
            ...back(`${l}-consume-d.0`),
          ]),
        ];
  return defineScenario({
    cfId: options.cfId,
    title: options.title,
    protocol: returnWith.kind,
    steps: [
      ...Object.entries(LIMITS).flatMap(([l, args]) => single(l, args)),
      ...queue(
        'unset-rounds',
        LIMITS.unset,
        rounds('unset-rounds', UNSET_ROUNDS),
      ),
      ...queue('fin-rounds', LIMITS.fin, rounds('fin-rounds', FIN_LIMIT + 1)),
    ],
  });
}
