// CF-STAMP-01: does a delivery counter that a client copied into a message survive, and what does
// a return (`basic.nack` with requeue) do to the counters and the position of a message?
//
// Per queue configuration (no delivery-limit argument, and a finite one): a `control` message, a
// `copy` message that carries a copied `x-delivery-count` of 99, and a `tail` message that is never
// fetched. The control and the copy are fetched (the copied value is recorded on the first
// delivery), both are returned with `nack(requeue=true)`, and the queue is drained (counters, and
// where the control landed relative to `tail`). The projection takes counters and position from the
// control message only, so the copied value cannot distort a cell's deltas.
import {
  declareQueue,
  defineScenario,
  get,
  observe,
  publish,
  settle,
  type LabStep,
} from '../dsl.ts';

/** The value a client copies into `x-delivery-count`; an integer no broker would have counted to. */
export const COPIED_DELIVERY_COUNT = 99;

/** The two queue configurations and their aliases: the projection finds a cell's evidence by these. */
export const STAMP_QUEUES = {
  none: {},
  fin: { 'x-delivery-limit': 20 },
} as const;

const forQueue = (
  name: keyof typeof STAMP_QUEUES,
  args: Record<string, number>,
): LabStep[] => [
  declareQueue(name, { type: 'quorum', arguments: args }),
  publish(name, `${name}-control`),
  publish(name, `${name}-copy`, undefined, {
    headers: { 'x-delivery-count': COPIED_DELIVERY_COUNT },
  }),
  publish(name, `${name}-tail`),
  get(`${name}-first-control`, name),
  get(`${name}-first-copy`, name),
  settle(`${name}-first-control`, { kind: 'nack', requeue: true }),
  settle(`${name}-first-copy`, { kind: 'nack', requeue: true }),
  observe(`${name}-after-return`, name),
];

export const cfStamp01 = defineScenario({
  cfId: 'CF-STAMP-01',
  title:
    'Quorum queue: a copied x-delivery-count on first delivery, then the counters and position after basic.nack with requeue',
  protocol: 'amqp091',
  steps: Object.entries(STAMP_QUEUES).flatMap(([name, args]) =>
    forQueue(name as keyof typeof STAMP_QUEUES, { ...args }),
  ),
});
