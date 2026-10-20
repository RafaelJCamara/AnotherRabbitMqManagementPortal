// The CF-SETTLE-01 projection against HAND-WRITTEN artefacts, written from the fact sheet (b.1, b.2)
// and never recorded off testing/era-broker.ts: a fake and a projection that share a belief would pass
// whatever RabbitMQ does (OQ-510, OQ-522, OQ-573). The registry is read only to compare with a cell.
import { registryData, type SemanticsCell } from '@app/semantics';
import { describe, expect, it } from 'vitest';

import { sealArtefact, type Json } from '../record/evidence.ts';
import { DIGEST, localProvenance } from '../testing/lab.ts';
import { projectSettle } from './projections-settle.ts';

type Count = number | null;
/** Where `m1` landed, and the x-delivery-count and x-acquired-count the drain shows for it. */
type Shape = readonly ['head' | 'tail' | 'gone', Count, Count];
/** Rounds of a crossing queue: how many were taken, in how many of them the message was `m1`, whether it is gone. */
type Rounds = readonly [total: number, held: number, gone: boolean];
/**
 * `over`: another shape, by queue (`fin-consume`) or for both paths of a limit (`minus1`).
 * `cf`: the id whose scenario the artefact stands for (CF-SETTLE-05 returns by the management get).
 */
interface Extra {
  over?: Record<string, Shape> | undefined;
  fin?: Rounds | undefined;
  unset?: Rounds | undefined;
  cf?: 'CF-SETTLE-01' | 'CF-SETTLE-02' | 'CF-SETTLE-05' | undefined;
}

const head = (dc: Count, ac: Count): Shape => ['head', dc, ac];
const tail = (dc: Count, ac: Count): Shape => ['tail', dc, ac];
const GONE: Shape = ['gone', null, null];
const KEPT: Rounds = [3, 3, false];
/** What a return shows: 3.13 and 4.0-4.2 send one counter, 4.3 both (a nack acquires and leaves the delivery count alone). */
const ONE = head(1, null);
const FOUR_THREE = head(0, 1);
/** What a nack shows in each era. */
const NACK: Record<string, Shape> = { '4.3': FOUR_THREE };

const obs = (q: string, id: string, props: object) => ({
  ...{ name: `${q}-after`, messageId: `${q}-${id}`, survived: true },
  ...{ position: 0, redelivered: false },
  ...{ 'x-delivery-count': null, 'x-acquired-count': null },
  ...props,
});
/** The drain of one queue: `m1` where the shape says, then the tail marker. */
const drain = (q: string, [place, dc, ac]: Shape) => [
  obs(
    q,
    'm1',
    place === 'gone'
      ? { survived: false, position: null }
      : {
          position: Number(place === 'tail'),
          'x-delivery-count': dc,
          'x-acquired-count': ac,
        },
  ),
  obs(q, 't', { position: Number(place === 'head') }),
];
/** A management get answers with a list and no counter headers (they come from the drain). */
const answer = (messageId: string, status = 200): Record<string, Json> => ({
  status,
  messages: status === 200 ? [{ messageId, redelivered: false }] : [],
});

function artefact(
  base: Shape,
  {
    over = {},
    fin = [3, 3, true],
    unset = [21, 21, false],
    cf = 'CF-SETTLE-01',
  }: Extra = {},
) {
  type Rec = Record<string, Json>;
  const http = cf === 'CF-SETTLE-05';
  const steps: { op: string; args: Rec; result: Rec }[] = [];
  const step = (op: string, args: Rec, result: Rec) =>
    steps.push({ op, args, result });
  const observations: ReturnType<typeof drain> = [];
  for (const l of ['unset', 'fin', 'minus1']) {
    for (const path of http
      ? (['http'] as const)
      : (['get', 'consume'] as const)) {
      const q = `${l}-${path}`;
      // A get says `empty: false`; the deliveries of a consume carry no such field.
      const d = {
        messageId: `${q}-m1`,
        'x-delivery-count': null,
        'x-acquired-count': null,
      };
      if (path === 'http') {
        step('mgmtGet', { as: `${q}-d`, queue: q }, answer(`${q}-m1`));
      } else {
        step(
          path,
          { as: `${q}-d`, queue: q },
          path === 'get' ? { ...d, empty: false } : { deliveries: [d] },
        );
      }
      observations.push(...drain(q, over[q] ?? over[l] ?? base));
    }
  }
  for (const [q, limit, [total, held, gone]] of [
    ['unset-rounds', null, unset],
    ['fin-rounds', 2, fin],
  ] as const) {
    const args = limit === null ? {} : { 'x-delivery-limit': limit };
    step('declareQueue', { queue: q, arguments: args }, { ok: true });
    for (let n = 0; n < total; n += 1) {
      const messageId = `${q}-${n < held ? 'm1' : 't'}`;
      const as = `${q}-r${String(n + 1)}`;
      if (http) step('mgmtGet', { as, queue: q }, answer(messageId));
      else step('get', { as, queue: q }, { empty: false, messageId });
    }
    observations.push(...drain(q, gone ? GONE : head(null, null)));
  }
  return sealArtefact({
    schemaVersion: 1,
    cfId: cf,
    title: 'hand-written',
    protocol: http ? 'http' : 'amqp091',
    brokerVersion: '4.3.6',
    imageDigest: DIGEST,
    steps: steps.map((step, index) => ({ index, ...step })),
    observations,
    provenance: localProvenance,
  });
}

type Limit = SemanticsCell['key']['limit'];
const cellOf = (
  era: string,
  limit: Limit,
  cf: `CF-${string}` = 'CF-SETTLE-01',
) => {
  const found = registryData.cells.find(
    (c) =>
      c.conformance.includes(cf) && c.key.era === era && c.key.limit === limit,
  );
  if (found === undefined) throw new Error(`no cell ${era} ${String(limit)}`);
  return found;
};
const project = projectSettle('CF-SETTLE-01');
const seen = (era: string, limit: Limit, base: Shape, extra?: Extra) => {
  const cf = extra?.cf ?? 'CF-SETTLE-01';
  return projectSettle(cf)(artefact(base, extra), cellOf(era, limit, cf));
};

/**
 * Every cell of an id, from the shape each era shows (`ac` is the 4.3 shape, `fin` its finite
 * rounds): what the artefact projects is non-empty and the registry cell holds all of it.
 */
function confirmsEveryCell(
  cf: NonNullable<Extra['cf']>,
  ac: Shape,
  fin: Rounds,
) {
  const cases = [
    ['3.13', 'unset', tail(1, null)],
    ['3.13', 'finite', ONE],
    ['3.13', 'minus1', ONE, { over: { minus1: GONE } }],
    ['4.0-4.2', 'finite', ONE],
    ['4.0-4.2', 'minus1', tail(1, null)],
    ['4.3', 'finite', ac, { fin }],
    ['4.3', 'minus1', ac],
  ] as const;
  for (const [era, limit, base, extra = {}] of cases) {
    const observed = seen(era, limit, base, { ...extra, cf });
    expect(observed, `${cf} ${era} ${limit}`).not.toBeNull();
    // The rounds speak for every cell except one a return that leaves the delivery count alone cannot decide.
    const leftOut =
      cellOf(era, limit, cf).effect?.countsTowardLimit === 'if-dc-gt-limit';
    expect(
      observed !== null && 'countsTowardLimit' in observed,
      `${cf} ${era} ${limit} countsTowardLimit`,
    ).toBe(!leftOut);
    expect(
      cellOf(era, limit, cf).effect,
      `${cf} ${era} ${limit}`,
    ).toMatchObject(observed ?? {});
  }
}

describe('the CF-SETTLE-01 projection', () => {
  it('AC-1 the recorded counters, position and survival of a nack confirm the finite-limit cells of every era', () => {
    const cases = [
      ['3.13', ONE, undefined, { deltaDC: 1, countsTowardLimit: 'yes' }],
      ['4.0-4.2', ONE, undefined, { deltaAC: 1, countsTowardLimit: 'yes' }],
      // `no` and `if-dc-gt-limit` look alike when a return leaves the delivery count alone: left out.
      ['4.3', FOUR_THREE, KEPT, { deltaAC: 1, deltaDC: 0 }],
    ] as const;
    for (const [era, base, fin, fields] of cases) {
      const observed = seen(era, 'finite', base, { fin });
      expect(observed, era).toEqual({
        ...fields,
        position: 'head',
        destructive: false,
      });
      // The registry leg: everything the projection speaks for equals the cell's claim.
      expect(cellOf(era, 'finite').effect, era).toMatchObject(observed ?? {});
    }
    // Another action, protocol, delayed retry, era or id's artefact: nothing is said.
    const run = artefact(FOUR_THREE);
    const cell = cellOf('4.3', 'finite');
    const other = (key: object) =>
      project(run, { ...cell, key: { ...cell.key, ...key } });
    expect([
      other({ action: 'amqp091.reject_requeue' }),
      other({ protocol: 'amqp10' }),
      other({ delayedRetry: 'all' }),
      other({ era: '4.4' }),
      project({ ...run, cfId: 'CF-SETTLE-02' }, cell),
    ]).toEqual([null, null, null, null, null]);
  });

  it('AC-6 a nack on a 3.13 queue with a limit of -1 that left the queue is projected as a drop', () => {
    expect(seen('3.13', 'minus1', ONE, { over: { minus1: GONE } })).toEqual({
      countsTowardLimit: 'yes',
      position: 'dlx-or-drop',
      destructive: true,
    });
    expect(
      seen('4.0-4.2', 'minus1', ONE, { over: { minus1: tail(1, null) } }),
    ).toEqual({
      deltaAC: 1,
      countsTowardLimit: 'no',
      position: 'tail',
      destructive: false,
    });
  });

  it('AC-7 TAIL appears only with no limit on 3.13 and with -1 on 4.0 to 4.2', () => {
    const cases = [
      ['3.13', 'unset', 'tail'],
      ['3.13', 'finite', 'head'],
      ['4.0-4.2', 'minus1', 'tail'],
      ['4.0-4.2', 'finite', 'head'],
      ['4.3', 'minus1', 'head'],
      ['4.3', 'finite', 'head'],
    ] as const;
    for (const [era, limit, position] of cases) {
      const landed = seen(era, limit, [position, 1, null]);
      expect(landed?.position, `${era} ${limit}`).toBe(position);
    }
  });

  it('AC-8 countsTowardLimit comes from the rounds, and an off-by-one or an undecidable case is not projected', () => {
    const counts = (era: string, limit: Limit, extra?: Extra) =>
      seen(era, limit, NACK[era] ?? ONE, extra)?.countsTowardLimit;
    // Gone after the third round, held in all three: it counts toward the limit.
    expect(counts('3.13', 'finite')).toBe('yes');
    expect(counts('4.0-4.2', 'finite')).toBe('yes');
    // Gone after round 2 (round 3 took the marker), too few or too many rounds, or never held: nothing.
    for (const fin of [
      [3, 2, true],
      [2, 2, true],
      [4, 4, true],
      [3, 0, true],
    ] as const) {
      expect(counts('3.13', 'finite', { fin }), fin.join()).toBeUndefined();
    }
    // Still there after round 3: `no`, except on 4.3 where a nack never raises the delivery count.
    expect(counts('4.0-4.2', 'finite', { fin: KEPT })).toBe('no');
    expect(counts('4.3', 'finite', { fin: KEPT })).toBeUndefined();
    // No limit: surviving the default limit plus one returns is `no`; one return fewer says nothing.
    expect(counts('3.13', 'unset')).toBe('no');
    expect(counts('3.13', 'unset', { unset: [20, 20, false] })).toBeUndefined();
    // A limit of -1: surviving the first return is `no`.
    expect(counts('4.0-4.2', 'minus1')).toBe('no');
    expect(counts('4.3', 'minus1')).toBe('no');
  });

  it('AC-9 diverging get and consume paths, and an unreadable management answer, are not averaged away: neither is chosen', () => {
    const speaks = (era: string, limit: Limit, extra?: Extra) =>
      seen(era, limit, ONE, extra) !== null;
    // Where the message landed differs on the fin paths, the counters after the return on the minus1 paths.
    const over = {
      'fin-consume': tail(1, null),
      'minus1-consume': head(2, null),
    };
    expect(speaks('4.0-4.2', 'finite')).toBe(true);
    expect(speaks('4.0-4.2', 'finite', { over })).toBe(false);
    expect(speaks('4.0-4.2', 'minus1', { over })).toBe(false);
    expect(speaks('3.13', 'unset', { over })).toBe(true);

    // CF-SETTLE-05 has the one `http` path: the management answer must be a 200 that took `m1`.
    const cf = 'CF-SETTLE-05';
    const seenHttp = (result?: Record<string, Json>) => {
      const run = artefact(ONE, { cf });
      const steps = run.steps.map((s) =>
        result !== undefined && s.args.as === 'fin-http-d'
          ? { ...s, result }
          : s,
      );
      return projectSettle(cf)({ ...run, steps }, cellOf('3.13', 'finite', cf));
    };
    confirmsEveryCell(cf, head(0, 1), KEPT);
    expect(seenHttp()).toMatchObject({ position: 'head' });
    for (const result of [
      // A failed answer that still lists the message is no return.
      { ...answer('fin-http-m1'), status: 500 },
      answer('fin-http-t'),
      { status: 200, messages: [] },
    ]) {
      expect(seenHttp(result), JSON.stringify(result)).toBeNull();
    }
  });

  it('AC-15 reject and nack are different actions: on 4.3 reject raises the delivery count and nack does not', () => {
    // 4.3, otherwise equal artefacts: the delivery count moves on a reject, not on a nack.
    const cf = 'CF-SETTLE-02';
    const reject = seen('4.3', 'finite', head(1, 1), { cf });
    const nack = seen('4.3', 'finite', head(0, 1), { fin: KEPT });
    expect(reject).toEqual({
      ...{ deltaAC: 1, deltaDC: 1, countsTowardLimit: 'yes' },
      position: 'head',
      destructive: false,
    });
    expect(nack).toMatchObject({ deltaAC: 1, deltaDC: 0 });
    // Each artefact confirms its own cell and contradicts the other action's.
    expect(cellOf('4.3', 'finite', cf).effect).toMatchObject(reject ?? {});
    expect(cellOf('4.3', 'finite').effect).not.toMatchObject(reject ?? {});
    expect(cellOf('4.3', 'finite', cf).effect).not.toMatchObject(nack ?? {});
    // An artefact of the other id is nobody's evidence.
    const nacked = artefact(head(0, 1), { fin: KEPT });
    expect(projectSettle(cf)(nacked, cellOf('4.3', 'finite', cf))).toBeNull();
    confirmsEveryCell(cf, head(1, 1), [3, 3, true]);
    // A reject raises the delivery count, so surviving the limit plus one returns is `no` (a nack leaves it out).
    const survived = seen('4.3', 'finite', head(1, 1), { cf, fin: KEPT });
    expect(survived?.countsTowardLimit).toBe('no');
    expect(cellOf('4.3', 'finite', cf).effect?.countsTowardLimit).not.toBe(
      'no',
    );
  });
});
