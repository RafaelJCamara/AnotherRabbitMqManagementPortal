// CF-DR-01 and CF-DR-02 onto registry cells (the registry leg of the three-way assertion). They read
// the artefact only. A cell is spoken for when it is a 4.3 quorum cell of a finite delivery limit
// (the scenarios set `x-delivery-limit` 20) under delayed retry `all`, `failed` or `returned`, for
// an action a scenario exercises: 0-9-1 `nack` and the management API's nack-and-requeue read
// (CF-DR-01), 0-9-1 `reject` (CF-DR-02). Only position and counter deltas are projected; the
// `minus1` cells, AMQP 1.0 cells and the `disabled` control get null (OQ-603, OQ-604).import type { SemanticsCell } from '@app/semantics';
import type { SemanticsCell } from '@app/semantics';
import type { EvidenceArtefact, Json } from '../record/evidence.ts';
import type { Observed, Projection } from './three-way.ts';

type Result = Readonly<Record<string, Json>>;

const getResult = (
  evidence: EvidenceArtefact,
  alias: string,
): Result | undefined =>
  evidence.steps.find((step) => step.op === 'get' && step.args.as === alias)
    ?.result;

const counter = (value: Json | undefined): number =>
  typeof value === 'number' ? value : 0;

/** The message id each `get` alias delivered, or null for an empty read. */
export const deliveredIds = (
  evidence: EvidenceArtefact,
  aliases: readonly string[],
): (string | null)[] =>
  aliases.map((alias) => {
    const id = getResult(evidence, alias)?.messageId;
    return typeof id === 'string' ? id : null;
  });

/** The read (0-based) among the `get` aliases at which `messageId` is first delivered, or -1. */
export const firstVisible = (
  evidence: EvidenceArtefact,
  aliases: readonly string[],
  messageId: string,
): number => deliveredIds(evidence, aliases).indexOf(messageId);

/**
 * Where the returned message `<queue>-m` lands among the reads `<queue>-<slot>` and what its
 * counters did: delivered first is `head`, behind `<queue>-t` with no empty read between is
 * `tail`, after an empty read is `delayed`. The counters are compared with the earlier delivery
 * (none is recorded for the management API's read: zero).
 */
function landing(
  evidence: EvidenceArtefact,
  queue: string,
  slots: readonly string[],
  baselineAlias: string | null,
): Observed | null {
  const reads = slots.map((slot) => getResult(evidence, `${queue}-${slot}`));
  const at = reads.findIndex((read) => read?.messageId === `${queue}-m`);
  const earlier =
    baselineAlias === null ? {} : getResult(evidence, baselineAlias);
  const delivered = reads[at];
  if (
    at < 0 ||
    delivered === undefined ||
    earlier === undefined ||
    earlier.empty === true
  ) {
    return null;
  }
  const position =
    at === 0
      ? 'head'
      : reads.slice(0, at).every((read) => read?.empty === false)
        ? 'tail'
        : 'delayed';
  // The schema types a delta as 0 or 1 (what the registry claims); the evidence is whatever the
  // broker did, so a different delta is kept as it is and shows up as a field-level mismatch.
  return {
    deltaAC: (counter(delivered['x-acquired-count']) -
      counter(earlier['x-acquired-count'])) as 0 | 1,
    deltaDC: (counter(delivered['x-delivery-count']) -
      counter(earlier['x-delivery-count'])) as 0 | 1,
    position,
    destructive: false,
  };
}

const covers = (cell: SemanticsCell, action: string, protocol: string) => {
  const { key } = cell;
  return (
    key.queueType === 'quorum' &&
    key.protocol === protocol &&
    key.action === action &&
    key.limit === 'finite' &&
    (key.delayedRetry === 'all' ||
      key.delayedRetry === 'failed' ||
      key.delayedRetry === 'returned')
  );
};

/** The reads of CF-DR-01: right after the return, after 2.5 s and after about 6 s. */
export const DR01_SLOTS = ['now', 'mid', 'end'] as const;

export const projectDr01: Projection = (evidence, cell) => {
  const { delayedRetry } = cell.key;
  if (delayedRetry === undefined) return null;
  if (covers(cell, 'amqp091.nack_requeue', 'amqp091')) {
    const queue = `nack-${delayedRetry}`;
    return landing(evidence, queue, DR01_SLOTS, `${queue}-first`);
  }
  if (covers(cell, 'http.ack_requeue_true', 'http')) {
    return landing(evidence, `http-${delayedRetry}`, DR01_SLOTS, null);
  }
  return null;
};

/** The four reads of CF-DR-02 after the first reject: 0, 1.5 s, 4.5 s and 7.5 s. */
export const DR02_SLOTS = ['r1-p0', 'r1-p1', 'r1-p2', 'r1-p3'] as const;

export const projectDr02: Projection = (evidence, cell) => {
  const { delayedRetry } = cell.key;
  if (
    delayedRetry === undefined ||
    !covers(cell, 'amqp091.reject_requeue', 'amqp091')
  ) {
    return null;
  }
  const queue = `rej-${delayedRetry}`;
  return landing(evidence, queue, DR02_SLOTS, `${queue}-first`);
};
