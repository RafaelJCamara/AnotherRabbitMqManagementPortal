// CF-CARRY-01 and CF-CARRY-03 onto registry cells (the registry leg of the three-way assertion). They
// read the artefact only. The registry has no field for "the target seeds its delivery count"
// (OQ-390, OQ-517), so only the fields the schema has are projected, and only those the artefact shows.
import type { SemanticsCell } from '@app/semantics';
import type { EvidenceArtefact } from '../record/evidence.ts';
import type { Observed, Projection } from './three-way.ts';

const count = (value: unknown): number =>
  typeof value === 'number' ? value : 0;

const stepResult = (evidence: EvidenceArtefact, alias: string) =>
  evidence.steps.find((step) => step.op === 'get' && step.args.as === alias)
    ?.result;
const observation = (
  evidence: EvidenceArtefact,
  name: string,
  messageId: string,
) =>
  evidence.observations.find(
    (item) => item.name === name && item.messageId === messageId,
  );

/** The quorum sources of CF-CARRY-01 whose dead letters the cell `amqp091.no_requeue` speaks for. */
const QUORUM_SOURCES = ['qq-amo', 'qq-alo'] as const;

/**
 * What one quorum source shows. The message left the source, or it did not (then it is a return,
 * not a dead letter). The counter deltas are the counters the dead letter shows in `dlq` less those
 * of its last delivery from the source, and only when it shows any: a dead letter that starts
 * afresh says nothing about a delta.
 */
function carry01Of(
  evidence: EvidenceArtefact,
  source: string,
): Observed | null {
  const id = `${source}-m`;
  const second = stepResult(evidence, `${source}-second`);
  const after = observation(evidence, `${source}-after`, id);
  const dead = observation(evidence, 'dlq-final', id);
  if (
    second === undefined ||
    second.empty === true ||
    after === undefined ||
    dead === undefined
  ) {
    return null;
  }
  if (after.survived) {
    return {
      position: after.position === 0 ? 'head' : 'tail',
      destructive: false,
    };
  }
  const left = { position: 'dlx-or-drop', destructive: true } as const;
  if (
    !dead.survived ||
    (dead['x-delivery-count'] === null && dead['x-acquired-count'] === null)
  ) {
    return left;
  }
  return {
    ...left,
    deltaAC: (count(dead['x-acquired-count']) -
      count(second['x-acquired-count'])) as 0 | 1,
    deltaDC: (count(dead['x-delivery-count']) -
      count(second['x-delivery-count'])) as 0 | 1,
  };
}

/** The quorum sources must show the same thing (the cell is strategy-agnostic, OQ-516), else nothing. */
export const projectCarry01: Projection = (
  evidence: EvidenceArtefact,
  cell: SemanticsCell,
): Observed | null => {
  const { key } = cell;
  if (
    key.queueType !== 'quorum' ||
    key.protocol !== 'amqp091' ||
    key.action !== 'amqp091.no_requeue'
  ) {
    return null;
  }
  const shown = QUORUM_SOURCES.map((source) => carry01Of(evidence, source));
  const [first, second] = shown;
  if (
    first === null ||
    first === undefined ||
    JSON.stringify(first) !== JSON.stringify(second)
  ) {
    return null;
  }
  return first;
};

/**
 * CF-CARRY-03 speaks for the 0-9-1 `nack_requeue` cell of a queue with a finite delivery limit and
 * no delayed retry: the cells for other actions, other protocols and delayed-retry queues name the id
 * too, but the scenario does not exercise them. The rule is read against the source's limit L: a
 * dead letter that arrives with a delivery count above L and is gone after its first return (dropped
 * or dead-lettered again) counts toward the limit `if-dc-gt-limit`; one that is still there does not
 * (`no`). A count at or below L, or none, does not exercise the rule: nothing is said.
 */
export const projectCarry03: Projection = (
  evidence: EvidenceArtefact,
  cell: SemanticsCell,
): Observed | null => {
  const { key } = cell;
  if (
    key.queueType !== 'quorum' ||
    key.protocol !== 'amqp091' ||
    key.action !== 'amqp091.nack_requeue' ||
    key.limit !== 'finite' ||
    (key.delayedRetry !== undefined && key.delayedRetry !== 'disabled')
  ) {
    return null;
  }
  const limit = evidence.steps.find(
    (step) => step.op === 'declareQueue' && step.args.queue === 'src',
  )?.args.arguments;
  const declared =
    typeof limit === 'object' && limit !== null && !Array.isArray(limit)
      ? limit['x-delivery-limit']
      : undefined;
  const arrival = stepResult(evidence, 'dlq-first')?.['x-delivery-count'];
  const after = observation(evidence, 'dlq-after-return', 'carry-m');
  if (
    typeof declared !== 'number' ||
    typeof arrival !== 'number' ||
    arrival <= declared ||
    after === undefined
  ) {
    return null;
  }
  return { countsTowardLimit: after.survived ? 'no' : 'if-dc-gt-limit' };
};
