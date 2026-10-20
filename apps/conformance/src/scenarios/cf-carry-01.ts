// CF-CARRY-01: what counters does a message carry into a quorum dead-letter queue when a consumer
// rejects it with `basic.nack` (requeue false) after one earlier return?
//
// Three sources dead-letter into one quorum queue `dlq` (no delivery-limit argument, so the version
// default): a quorum queue with the at-most-once strategy, a quorum queue with the at-least-once
// strategy (which needs `reject-publish`), and a classic queue. Each message is fetched, returned
// once so its counters are not zero, fetched again and rejected. The dead letters are then read from
// `dlq` (counters, `redelivered`) and each source is drained to see whether the message left it.
// The classic source has no registry cell: it is recorded, and compared with nothing (OQ-516).
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
  wait,
  type LabStep,
} from '../dsl.ts';

/** The sources, by alias, and how each is declared. The projection speaks for the quorum ones. */
export const CARRY_SOURCES = {
  'qq-amo': {
    type: 'quorum',
    args: { 'x-dead-letter-strategy': 'at-most-once' },
  },
  'qq-alo': {
    type: 'quorum',
    args: {
      'x-dead-letter-strategy': 'at-least-once',
      'x-overflow': 'reject-publish',
    },
  },
  cq: { type: 'classic', args: {} },
} as const;

type SourceAlias = keyof typeof CARRY_SOURCES;
const SOURCES = Object.keys(CARRY_SOURCES) as SourceAlias[];

const through = (source: SourceAlias): LabStep[] => [
  declareQueue(source, {
    type: CARRY_SOURCES[source].type,
    arguments: {
      ...CARRY_SOURCES[source].args,
      'x-dead-letter-exchange': ref('dlx'),
      'x-dead-letter-routing-key': ref('dlq'),
    },
  }),
  publish(source, `${source}-m`),
  get(`${source}-first`, source),
  settle(`${source}-first`, { kind: 'nack', requeue: true }),
  get(`${source}-second`, source),
  settle(`${source}-second`, { kind: 'nack', requeue: false }),
];

export const cfCarry01 = defineScenario({
  cfId: 'CF-CARRY-01',
  title:
    'Dead letter into a quorum queue: the counters it carries after basic.nack without requeue, from quorum (at-most-once, at-least-once) and classic sources',
  protocol: 'amqp091',
  steps: [
    declareExchange('dlx'),
    declareQueue('dlq', { type: 'quorum' }),
    bindQueue('dlq', 'dlx', ref('dlq')),
    ...SOURCES.flatMap(through),
    // A dead letter arrives asynchronously (at-least-once most of all): read once the count is steady.
    wait(500),
    awaitReady('dlq', { stableFor: 10 }),
    observe('dlq-final', 'dlq', { from: SOURCES }),
    ...SOURCES.map((source) => observe(`${source}-after`, source)),
  ],
});
