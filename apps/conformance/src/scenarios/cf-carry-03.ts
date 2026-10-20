// CF-CARRY-03: a message dead-lettered for exceeding a delivery limit of L arrives in the
// dead-letter queue with the counters it had. What does its first return there do?
//
// A quorum source (`x-delivery-limit` L) is returned L + 1 times with `basic.reject` (requeue
// true), the return that raises the delivery count on 4.3, so it is dead-lettered into `dlq`: a
// quorum queue with no limit argument (the version default) that itself dead-letters into `dlq2`.
// The message is fetched from `dlq`, returned once with `basic.nack` (requeue true), and both
// queues are drained. Where it is afterwards (still in `dlq`, in `dlq2`, or nowhere) is the evidence.
import {
  awaitReady,
  bindQueue,
  declareExchange,
  declareQueue,
  defineScenario,
  get,
  observe,
  publish,
  ref,
  settle,
  type LabStep,
} from '../dsl.ts';

/** The delivery limit of the source; the message is returned `LIMIT + 1` times. */
export const LIMIT = 20;
export const MESSAGE = 'carry-m';

const returns = Array.from({ length: LIMIT + 1 }, (_, n): LabStep[] => [
  get(`g${String(n + 1)}`, 'src'),
  settle(`g${String(n + 1)}`, { kind: 'reject', requeue: true }),
]).flat();

export const cfCarry03 = defineScenario({
  cfId: 'CF-CARRY-03',
  title:
    'Quorum dead-letter queue: a message dead-lettered at delivery limit + 1 and then returned once',
  protocol: 'amqp091',
  steps: [
    declareExchange('dlx'),
    declareExchange('dlx2'),
    declareQueue('dlq2', { type: 'quorum' }),
    bindQueue('dlq2', 'dlx2', ref('dlq2')),
    declareQueue('dlq', {
      type: 'quorum',
      arguments: {
        'x-dead-letter-exchange': ref('dlx2'),
        'x-dead-letter-routing-key': ref('dlq2'),
      },
    }),
    bindQueue('dlq', 'dlx', ref('dlq')),
    declareQueue('src', {
      type: 'quorum',
      arguments: {
        'x-delivery-limit': LIMIT,
        'x-dead-letter-exchange': ref('dlx'),
        'x-dead-letter-routing-key': ref('dlq'),
      },
    }),
    publish('src', MESSAGE),
    ...returns,
    awaitReady('dlq', { stableFor: 10 }),
    get('dlq-first', 'dlq'),
    settle('dlq-first', { kind: 'nack', requeue: true }),
    awaitReady('dlq2', { stableFor: 10 }),
    observe('dlq-after-return', 'dlq', { from: ['src'] }),
    observe('dlq2-final', 'dlq2', { from: ['src'] }),
  ],
});
