// CF-STAMP-01 onto registry cells (the registry leg of the three-way assertion). It reads the
// artefact only. Counters and position come from the CONTROL message, never from the message that
// carried a copied `x-delivery-count`, so a client-copied value cannot move a cell's deltas.
//
// A cell is spoken for only when it is a quorum, AMQP 0-9-1 `nack_requeue` cell with no delayed
// retry in play, and its limit is one the scenario configured (`unset`: the `none` queue, `finite`:
// the `fin` queue). Any other cell (`minus1`, a delayed-retry type, another action) gets null.
import type { SemanticsCell } from '@app/semantics';
import type { EvidenceArtefact } from '../record/evidence.ts';
import { counterDeltas, countersOf } from './counters.ts';
import type { Observed, Projection } from './three-way.ts';

const QUEUE_OF_LIMIT: Readonly<Record<string, string | undefined>> = {
  unset: 'none',
  finite: 'fin',
};

export const projectStamp01: Projection = (
  evidence: EvidenceArtefact,
  cell: SemanticsCell,
): Observed | null => {
  const { key } = cell;
  if (
    key.queueType !== 'quorum' ||
    key.protocol !== 'amqp091' ||
    key.action !== 'amqp091.nack_requeue' ||
    (key.delayedRetry !== undefined && key.delayedRetry !== 'disabled')
  ) {
    return null;
  }
  const queue = key.limit === undefined ? undefined : QUEUE_OF_LIMIT[key.limit];
  if (queue === undefined) return null;

  const first = evidence.steps.find(
    (step) => step.op === 'get' && step.args.as === `${queue}-first-control`,
  )?.result;
  const after = evidence.observations.find(
    (item) =>
      item.name === `${queue}-after-return` &&
      item.messageId === `${queue}-control`,
  );
  const tail = evidence.observations.find(
    (item) =>
      item.name === `${queue}-after-return` &&
      item.messageId === `${queue}-tail`,
  );
  if (first === undefined || after === undefined || tail === undefined)
    return null;
  if (first.empty === true) return null;
  if (!after.survived || after.position === null) {
    return { position: 'removed', destructive: true };
  }
  if (!tail.survived || tail.position === null) return null;
  // Which header is which counter depends on the era; a counter the era cannot show is left out.
  const deltas = counterDeltas(key.era, countersOf(first), countersOf(after));
  if (deltas === null) return null;
  return {
    ...deltas,
    position: after.position < tail.position ? 'head' : 'tail',
    destructive: false,
  };
};
