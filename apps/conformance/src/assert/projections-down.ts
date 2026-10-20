// CF-DOWN-01 onto registry cells (the registry leg of the three-way assertion). It reads the artefact
// only; the cell's key (era, limit) says HOW to read it, never what the cell claims. Which header is
// which counter depends on the era (fact sheet b.1), and a field an era cannot show (no DC header on
// 4.0 to 4.2, no AC header on 3.13) is left out, never inferred.
//
// The paths of one limit (get, active consumer, cancel-then-close, and a closed connection) must
// agree on what they left behind; if not, the projection is null (the cell stays `unverified`) and
// `pathDivergence` names what differs: a finding for a human, never averaged away.
import type { SemanticsCell } from '@app/semantics';
import type { EvidenceArtefact, Json } from '../record/evidence.ts';
import type { Observed, Projection } from './three-way.ts';

type Limit = 'unset' | 'finite' | 'minus1';
const PREFIX: Readonly<Record<Limit, string>> = {
  unset: 'unset',
  finite: 'fin',
  minus1: 'minus1',
};
const PATHS = ['get', 'active', 'cancelled'] as const;

type Group = readonly [label: string, queues: readonly string[]];

/** The queues that must agree: one hold-and-close per path, and for `finite` also its crossing rounds. */
const groupsOf = (limit: Limit): Group[] => [
  [
    limit,
    [
      ...PATHS.map((path) => `${PREFIX[limit]}-${path}`),
      ...(limit === 'finite' ? ['fin-conn'] : []),
    ],
  ],
  ...(limit === 'finite'
    ? [['finite crossing', PATHS.map((p) => `fin-${p}-x`)] as const]
    : []),
];
interface After {
  readonly survived: boolean;
  readonly position: number | null;
  readonly survivors: number;
  readonly 'x-delivery-count': number | null;
  readonly 'x-acquired-count': number | null;
}

/** What the drain of `queue` showed of its first message (`<queue>-m1`). */
function after(evidence: EvidenceArtefact, queue: string): After | null {
  const drained = evidence.observations.filter(
    (item) => item.name === `${queue}-after`,
  );
  const first = drained.find((item) => item.messageId === `${queue}-m1`);
  if (first === undefined) return null;
  return {
    survived: first.survived,
    position: first.position,
    survivors: drained.filter((item) => item.survived).length,
    'x-delivery-count': first['x-delivery-count'],
    'x-acquired-count': first['x-acquired-count'],
  };
}

const counter = (value: Json | undefined): number =>
  typeof value === 'number' ? value : 0;

/** The delivery the `get` step `alias` recorded: the message held and the counters it carried. */
function held(
  evidence: EvidenceArtefact,
  alias: string,
): { id: string; dc: number; ac: number } | null {
  const step = evidence.steps.find(
    (item) => item.op === 'get' && item.args.as === alias,
  );
  const id = step?.result.messageId;
  if (step === undefined || typeof id !== 'string') return null;
  return {
    id,
    dc: counter(step.result['x-delivery-count']),
    ac: counter(step.result['x-acquired-count']),
  };
}

function groupDivergence(
  evidence: EvidenceArtefact,
  [label, queues]: Group,
): string[] {
  const readings = queues.map((queue) => ({
    queue,
    reading: after(evidence, queue),
  }));
  const found = readings.flatMap(({ queue, reading }) =>
    reading === null ? [] : [{ queue, reading }],
  );
  const [base, ...others] = found;
  return [
    ...readings
      .filter(({ reading }) => reading === null)
      .map(({ queue }) => `${label}: no reading of m1 in ${queue}`),
    ...others.flatMap(({ queue, reading }) =>
      (Object.keys(reading) as (keyof After)[])
        .filter((field) => reading[field] !== base?.reading[field])
        .map(
          (field) =>
            `${label}: ${queue} differs from ${base?.queue ?? ''} in ${field} (${String(reading[field])} vs ${String(base?.reading[field])})`,
        ),
    ),
  ];
}
/** Findings when the get, consume-active and cancel-then-close paths of one limit case disagree. */
export function pathDivergence(evidence: EvidenceArtefact): string[] {
  return (['unset', 'finite', 'minus1'] as const).flatMap((limit) =>
    groupsOf(limit).flatMap((group) => groupDivergence(evidence, group)),
  );
}

/** `yes` when the return that crosses the limit dropped `m1`; `no` when it was held all three times and survived. */
function crossing(evidence: EvidenceArtefact): 'yes' | 'no' | null {
  const drained = after(evidence, 'fin-get-x');
  const first = 'fin-get-x-m1';
  const holders = [1, 2, 3].map(
    (n) => held(evidence, `fin-get-x-r${String(n)}`)?.id,
  );
  if (drained === null || holders[0] !== first) return null;
  if (!drained.survived) return 'yes';
  return holders.every((id) => id === first) ? 'no' : null;
}

const delta = (now: number | null, before: number): 0 | 1 =>
  ((now ?? 0) - before) as 0 | 1;

/** Which headers carry which counter, by era (fact sheet b.1). A field an era cannot show is left out. */
const COUNTERS: Readonly<
  Record<string, ((header: 0 | 1, acquired: 0 | 1) => Observed) | undefined>
> = {
  '4.3': (header, acquired) => ({ deltaAC: acquired, deltaDC: header }),
  '4.0-4.2': (header) => ({ deltaAC: header }),
  '3.13': (header) => ({ deltaDC: header }),
};

export const projectDown01: Projection = (
  evidence: EvidenceArtefact,
  cell: SemanticsCell,
): Observed | null => {
  const { key } = cell;
  if (
    key.queueType !== 'quorum' ||
    key.protocol !== 'amqp091' ||
    key.action !== 'close_while_holding' ||
    key.limit === undefined ||
    (key.delayedRetry !== undefined && key.delayedRetry !== 'disabled')
  ) {
    return null;
  }
  const { limit } = key;
  const readCounters = COUNTERS[key.era];
  if (readCounters === undefined) return null;
  if (groupsOf(limit).some((g) => groupDivergence(evidence, g).length > 0)) {
    return null;
  }
  const queue = `${PREFIX[limit]}-get`;
  const drained = after(evidence, queue);
  const first = held(evidence, `${queue}-held`);
  if (drained === null || first?.id !== `${queue}-m1`) {
    return null;
  }
  if (!drained.survived || drained.position === null) {
    return {
      position: 'dlx-or-drop',
      destructive: true,
      ...(limit === 'unset' ? {} : { countsTowardLimit: 'yes' as const }),
    };
  }
  const header = delta(drained['x-delivery-count'], first.dc);
  const acquired = delta(drained['x-acquired-count'], first.ac);
  const counters = readCounters(header, acquired);
  let countsTowardLimit: 'yes' | 'no' | null = null;
  if (limit === 'minus1') countsTowardLimit = 'no';
  if (limit === 'finite') {
    countsTowardLimit = crossing(evidence);
    if (countsTowardLimit === null) return null;
  }
  return {
    ...counters,
    ...(countsTowardLimit === null ? {} : { countsTowardLimit }),
    position:
      drained.position === 0
        ? 'head'
        : drained.position === drained.survivors - 1
          ? 'tail'
          : 'original',
    destructive: false,
  };
};
