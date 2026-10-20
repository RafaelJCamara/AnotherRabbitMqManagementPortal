// The CF-SETTLE ids onto registry cells. A projection reads the artefact only (the cell's key says
// how to read it, never its claim), speaks for the fields the scenario measures and returns null
// when it cannot tell. Queues are those of scenarios/settle-return.ts.
import type { SemanticsCell } from '@app/semantics';
import type { EvidenceArtefact, Json } from '../record/evidence.ts';
import {
  counterDeltas,
  countersOf,
  hasCounterReading,
  type CounterHeaders,
} from './counters.ts';
import type { Observed, Projection } from './three-way.ts';

interface Row {
  readonly action: string;
  readonly protocol: string;
  /** The paths the scenario returns on: queues `<limit>-<path>`. */
  readonly paths: readonly string[];
  /**
   * The eras in which a return of this kind leaves the delivery count alone, so that surviving the
   * limit cannot tell `no` from `if-dc-gt-limit` (OQ-565). A reject raises it: survival decides.
   */
  readonly undecided: readonly string[];
}
const BOTH = ['get', 'consume'];
const ROWS: Readonly<Record<string, Row>> = {
  'CF-SETTLE-01': {
    ...{ action: 'amqp091.nack_requeue', protocol: 'amqp091', paths: BOTH },
    undecided: ['4.3'],
  },
  'CF-SETTLE-02': {
    ...{ action: 'amqp091.reject_requeue', protocol: 'amqp091', paths: BOTH },
    undecided: [],
  },
  'CF-SETTLE-05': {
    ...{ action: 'http.ack_requeue_true', protocol: 'http', paths: ['http'] },
    undecided: ['4.3'],
  },
};
const QUEUE_OF_LIMIT = { unset: 'unset', finite: 'fin', minus1: 'minus1' };
const UNSET_ROUNDS = 21; // the default limit (20) plus one

interface Reading {
  readonly place: 'gone' | 'head' | 'tail';
  readonly first: CounterHeaders;
  /** null: the message is gone, so it shows no counters. */
  readonly after: CounterHeaders | null;
}

const survivor = (evidence: EvidenceArtefact, queue: string, id: string) =>
  evidence.observations.find(
    (o) => o.name === `${queue}-after` && o.messageId === `${queue}-${id}`,
  );

/**
 * The message one taking step returned, or undefined when it took none. A management get answers
 * with a list and sends no counter headers (they come from the drain), so only its id is read.
 */
function taken(step: EvidenceArtefact['steps'][number] | undefined) {
  const list = (key: string): Record<string, Json> | undefined =>
    (step?.result[key] as Record<string, Json>[] | undefined)?.[0];
  if (step?.op === 'consume') return list('deliveries');
  if (step?.op === 'mgmtGet') {
    return step.result.status === 200 ? list('messages') : undefined;
  }
  return step?.result;
}

/** What one single-return queue shows, or null when it cannot be told (a missing step or marker). */
function read(evidence: EvidenceArtefact, queue: string): Reading | null {
  const first = taken(evidence.steps.find((s) => s.args.as === `${queue}-d`));
  const [m1, marker] = [
    survivor(evidence, queue, 'm1'),
    survivor(evidence, queue, 't'),
  ];
  if (
    first === undefined ||
    first.empty === true ||
    first.messageId !== `${queue}-m1` ||
    !m1 ||
    !marker
  ) {
    return null;
  }
  if (!m1.survived || m1.position === null) {
    return { place: 'gone', first: countersOf(first), after: null };
  }
  if (!marker.survived || marker.position === null) return null;
  return {
    place: m1.position < marker.position ? 'head' : 'tail',
    first: countersOf(first),
    after: countersOf(m1),
  };
}

/** A crossing queue: the rounds taken, whether `m1` was the message in all of them, whether it is still there. */
function rounds(evidence: EvidenceArtefact, queue: string) {
  const takes = evidence.steps.filter(
    (s) =>
      (s.op === 'get' || s.op === 'mgmtGet') &&
      s.args.queue === queue &&
      /-r\d+$/.test(s.args.as as string),
  );
  const declared = evidence.steps.find(
    (s) => s.op === 'declareQueue' && s.args.queue === queue,
  )?.args.arguments as Record<string, Json> | undefined;
  return {
    count: takes.length,
    limit: declared?.['x-delivery-limit'],
    held: takes.every((s) => taken(s)?.messageId === `${queue}-m1`),
    survived: survivor(evidence, queue, 'm1')?.survived === true,
  };
}

export const projectSettle = (cfId: string): Projection => {
  const row = ROWS[cfId];
  if (row === undefined) throw new Error(`${cfId} has no settle projection`);
  return (evidence: EvidenceArtefact, cell: SemanticsCell): Observed | null => {
    const { key } = cell;
    const limit =
      key.limit === undefined ? undefined : QUEUE_OF_LIMIT[key.limit];
    if (
      evidence.cfId !== cfId ||
      key.queueType !== 'quorum' ||
      key.protocol !== row.protocol ||
      key.action !== row.action ||
      (key.delayedRetry !== undefined && key.delayedRetry !== 'disabled') ||
      limit === undefined ||
      !hasCounterReading(key.era)
    ) {
      return null;
    }
    // The get and consume paths must agree; neither is chosen when they do not.
    const [get, ...others] = row.paths.map((p) =>
      read(evidence, `${limit}-${p}`),
    );
    if (!get || others.some((o) => JSON.stringify(o) !== JSON.stringify(get))) {
      return null;
    }

    const counts = (): Observed['countsTowardLimit'] => {
      if (key.limit === 'minus1') return get.place === 'gone' ? 'yes' : 'no';
      if (key.limit === 'unset') {
        const crossing = rounds(evidence, 'unset-rounds');
        return crossing.count === UNSET_ROUNDS && crossing.survived
          ? 'no'
          : undefined;
      }
      const crossing = rounds(evidence, 'fin-rounds');
      // Held in every round up to limit + 1: gone after the last is `yes`; an off-by-one says nothing.
      if (
        typeof crossing.limit !== 'number' ||
        crossing.count !== crossing.limit + 1 ||
        !crossing.held
      ) {
        return undefined;
      }
      if (!crossing.survived) return 'yes';
      // No number of returns tells `no` from `if-dc-gt-limit` when a return leaves the delivery count alone.
      return row.undecided.includes(key.era) ? undefined : 'no';
    };
    const counted = counts();
    const limited = counted === undefined ? {} : { countsTowardLimit: counted };
    // A message that is gone has no counters to project.
    if (get.after === null)
      return { ...limited, position: 'dlx-or-drop', destructive: true };
    const deltas = counterDeltas(key.era, get.first, get.after);
    const position = get.place === 'tail' ? 'tail' : 'head';
    return deltas && { ...deltas, ...limited, position, destructive: false };
  };
};
