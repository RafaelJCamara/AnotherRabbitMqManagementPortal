// The return scenarios of the settle family (M0-38): a quorum message is taken and given back, and
// the lab records where it lands, which counter moved and whether it survives. Queues (the aliases
// assert/projections-settle.ts reads), each holding `<q>-m1` ahead of `<q>-t`:
//   `<limit>-<path>`  one return; limit `unset`, `fin` (2) or `minus1`; path `get`, or `consume`
//                     (cancelled once the delivery arrived, so it is not handed straight back).
//   `unset-rounds`    taken and returned 21 times (default limit + 1); `fin-rounds`: 3 times.
import {
  awaitReady,
  consume,
  declareQueue,
  defineScenario,
  get,
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

export function settleReturnScenario(options: {
  cfId: string;
  title: string;
  returnWith: { kind: 'amqp091'; action: 'nack' };
}): LabScenario {
  const back = { kind: options.returnWith.action, requeue: true } as const;
  /** Two messages, then `take` and return, then the wait and the drain. */
  const queue = (
    q: string,
    args: Readonly<Record<string, number>>,
    take: LabStep[][],
  ): LabStep[] => [
    declareQueue(q, { type: 'quorum', arguments: { ...args } }),
    publish(q, `${q}-m1`),
    publish(q, `${q}-t`),
    ...take.flat(),
    awaitReady(q),
    observe(`${q}-after`, q),
  ];
  const rounds = (q: string, count: number) =>
    Array.from({ length: count }, (_, n) => {
      const d = `${q}-r${String(n + 1)}`;
      return [get(d, q), settle(d, back)];
    });
  return defineScenario({
    cfId: options.cfId,
    title: options.title,
    protocol: 'amqp091',
    steps: [
      ...Object.entries(LIMITS).flatMap(([l, args]) => [
        ...queue(`${l}-get`, args, [
          [get(`${l}-get-d`, `${l}-get`), settle(`${l}-get-d`, back)],
        ]),
        ...queue(`${l}-consume`, args, [
          [
            consume(`${l}-consume-d`, `${l}-consume`, 1),
            settle(`${l}-consume-d.0`, back),
          ],
        ]),
      ]),
      ...queue(
        'unset-rounds',
        LIMITS.unset,
        rounds('unset-rounds', UNSET_ROUNDS),
      ),
      ...queue('fin-rounds', LIMITS.fin, rounds('fin-rounds', FIN_LIMIT + 1)),
    ],
  });
}
