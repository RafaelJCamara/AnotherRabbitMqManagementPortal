// The projections of the M0-40 lab cells (slice B: CF-CARRY-01 and CF-CARRY-03) say nothing about a
// cell they do not cover, and a contradicting artefact is a field-level mismatch, never a match.
import { registryData, type SemanticsCell } from '@app/semantics';
import { describe, expect, it } from 'vitest';

import {
  sealArtefact,
  type EvidenceArtefact,
  type EvidenceObservation,
  type EvidenceStep,
} from '../record/evidence.ts';
import { cfCarry01 } from '../scenarios/cf-carry-01.ts';
import { cfCarry03 } from '../scenarios/cf-carry-03.ts';
import { cfDr01 } from '../scenarios/cf-dr-01.ts';
import { cfDr02 } from '../scenarios/cf-dr-02.ts';
import { ERA_VERSION, recordOnEra, type Era } from '../testing/era-broker.ts';
import { DIGEST, localProvenance } from '../testing/lab.ts';
import { projectCarry01, projectCarry03 } from './projections-carry.ts';
import { projectDr01, projectDr02 } from './projections-dr.ts';
import { projectStamp01 } from './projections-stamp.ts';

const cellOf = (id: string): SemanticsCell => {
  const cell = registryData.cells.find((item) => item.id === id);
  if (cell === undefined) throw new Error(`no cell ${id}`);
  return cell;
};
const NO_REQUEUE = cellOf('SEM-4.3-quorum-amqp091-amqp091.no_requeue');
const CARRY03 = cellOf(
  'SEM-4.3-quorum-amqp091-amqp091.nack_requeue-limit-finite-delayed-disabled',
);
const NACK_ALL = cellOf(
  'SEM-4.3-quorum-amqp091-amqp091.nack_requeue-limit-finite-delayed-all',
);
const REJECT_ALL = cellOf(
  'SEM-4.3-quorum-amqp091-amqp091.reject_requeue-limit-finite-delayed-all',
);
const withKey = (
  cell: SemanticsCell,
  key: Partial<SemanticsCell['key']>,
): SemanticsCell => ({ ...cell, key: { ...cell.key, ...key } });

/** The artefact with the named observation of each message id patched. */
const patch = (
  artefact: EvidenceArtefact,
  name: string,
  ids: readonly string[],
  change: Record<string, unknown>,
): EvidenceArtefact => ({
  ...artefact,
  observations: artefact.observations.map((item) =>
    item.name === name && ids.includes(item.messageId)
      ? { ...item, ...change }
      : item,
  ),
});

describe('the projections of the lab cells', () => {
  it('AC-9 a projection says nothing about a cell it does not cover and fails closed on a contradiction', async () => {
    const carry01 = await recordOnEra('4.3', cfCarry01);
    const carry03 = await recordOnEra('4.3', cfCarry03);
    expect(projectCarry01(carry01, NO_REQUEUE)?.deltaAC).toBe(1);
    expect(projectCarry03(carry03, CARRY03)).toEqual({
      countsTowardLimit: 'if-dc-gt-limit',
    });

    // Another action, a classic queue, another protocol, a delayed-retry queue: null, never a default.
    const uncovered01 = [
      { action: 'amqp091.nack_requeue' },
      { queueType: 'classic' },
      { protocol: 'amqp10' },
    ] as const;
    const uncovered03 = [
      { action: 'amqp091.reject_requeue' },
      { limit: 'minus1' },
      { delayedRetry: 'all' },
      { protocol: 'amqp10' },
    ] as const;
    for (const key of uncovered01)
      expect(projectCarry01(carry01, withKey(NO_REQUEUE, key))).toBeNull();
    for (const key of uncovered03)
      expect(projectCarry03(carry03, withKey(CARRY03, key))).toBeNull();
    // The other id's artefact cannot be read as this one.
    expect(projectCarry01(carry03, NO_REQUEUE)).toBeNull();
    expect(projectCarry03(carry01, CARRY03)).toBeNull();

    // CF-CARRY-01: one miscounted source disagrees with the other, so nothing is said; both
    // miscounted show the delta as it is (a mismatch for the cell); a message that stays in both
    // sources is a return, not a dead letter.
    const ids = ['qq-amo-m', 'qq-alo-m'];
    const dlq = (list: string[]) =>
      patch(carry01, 'dlq-final', list, { 'x-acquired-count': 3 });
    expect(projectCarry01(dlq(ids.slice(0, 1)), NO_REQUEUE)).toBeNull();
    expect(projectCarry01(dlq(ids), NO_REQUEUE)?.deltaAC).toBe(2);
    const stays = { survived: true, position: 0 };
    const returned = patch(
      patch(carry01, 'qq-amo-after', ['qq-amo-m'], stays),
      'qq-alo-after',
      ['qq-alo-m'],
      stays,
    );
    expect(projectCarry01(returned, NO_REQUEUE)).toEqual({
      position: 'head',
      destructive: false,
    });

    // CF-CARRY-03: still in `dlq` although it arrived above the limit is `no` (the cell says
    // `if-dc-gt-limit`); an arrival count at the limit says nothing.
    const kept = patch(carry03, 'dlq-after-return', ['carry-m'], stays);
    expect(projectCarry03(kept, CARRY03)).toEqual({ countsTowardLimit: 'no' });
    const atLimit = {
      ...carry03,
      steps: carry03.steps.map((step) =>
        step.args.as === 'dlq-first'
          ? { ...step, result: { ...step.result, 'x-delivery-count': 20 } }
          : step,
      ),
    };
    expect(projectCarry03(atLimit, CARRY03)).toBeNull();

    // CF-DR-01 and CF-DR-02: a cell of another action, protocol, limit or queue type, the `disabled`
    // control and the other id's artefact get null.
    const dr01 = await recordOnEra('4.3', cfDr01);
    const dr02 = await recordOnEra('4.3', cfDr02);
    expect(projectDr01(dr01, NACK_ALL)).toMatchObject({ position: 'delayed' });
    expect(projectDr02(dr02, REJECT_ALL)).toMatchObject({
      position: 'delayed',
    });
    const others = [
      { action: 'amqp091.no_requeue' },
      { limit: 'minus1' },
      { delayedRetry: 'disabled' },
      { protocol: 'amqp10' },
      { queueType: 'classic' },
    ] as const;
    for (const key of others) {
      expect(projectDr01(dr01, withKey(NACK_ALL, key))).toBeNull();
      expect(projectDr02(dr02, withKey(REJECT_ALL, key))).toBeNull();
    }
    expect(projectDr01(dr01, REJECT_ALL)).toBeNull();
    expect(projectDr02(dr02, NACK_ALL)).toBeNull();
    expect(projectDr01(dr02, NACK_ALL)).toBeNull();
    expect(projectDr02(dr01, REJECT_ALL)).toBeNull();

    // A contradiction is shown as it is (visible at once is `head`; back at the second read with no
    // empty read before it is `tail`; a counter that moved by three is kept); a message never seen,
    // or without an earlier delivery to compare with, says nothing.
    const m = { empty: false, messageId: 'nack-all-m' };
    const read = (alias: string, result: Record<string, unknown>) =>
      projectDr01(
        {
          ...dr01,
          steps: dr01.steps.map((step) =>
            step.op === 'get' && step.args.as === alias
              ? { ...step, result: result as typeof step.result }
              : step,
          ),
        },
        NACK_ALL,
      );
    expect(read('nack-all-now', m)?.position).toBe('head');
    expect(read('nack-all-mid', m)?.position).toBe('tail');
    expect(read('nack-all-end', { ...m, 'x-acquired-count': 3 })?.deltaAC).toBe(
      3,
    );
    expect(read('nack-all-end', { empty: true })).toBeNull();
    expect(read('nack-all-first', { empty: true })).toBeNull();
  });
});

// The artefacts below are written by hand from the fact sheet (b.1), never recorded off the era
// broker: the broker and the projections once shared one wrong belief about which header is which
// counter, and the tests passed because both were wrong the same way.
const artefactOf = (
  era: Era,
  cfId: `CF-${string}`,
  steps: EvidenceStep[],
  observations: EvidenceObservation[],
): EvidenceArtefact =>
  sealArtefact({
    schemaVersion: 1,
    cfId,
    title: 'hand-written',
    protocol: 'amqp091',
    brokerVersion: ERA_VERSION[era],
    imageDigest: DIGEST,
    steps,
    observations,
    provenance: localProvenance,
  });
const getStep = (as: string, result: EvidenceStep['result']): EvidenceStep => ({
  index: 0,
  op: 'get',
  args: { as },
  result: { empty: false, ...result },
});
const seen = (
  name: string,
  messageId: string,
  position: number | null,
  dc: number | null,
  ac: number | null,
): EvidenceObservation => ({
  name,
  messageId,
  survived: position !== null,
  position,
  redelivered: null,
  'x-delivery-count': dc,
  'x-acquired-count': ac,
});

type Counters = [dc: number | null, ac: number | null];
/** The headers a returned message shows on its next delivery, per era. */
const SENT: Readonly<Record<Era, Counters>> = {
  '3.13': [1, null],
  '4.0-4.2': [1, null],
  '4.3': [0, 1],
};
/** The deltas that delivery gives: 4.0 to 4.2 show no delivery count, 3.13 no acquired count. */
const DELTAS: Readonly<Record<Era, Record<string, number>>> = {
  '3.13': { deltaDC: 1 },
  '4.0-4.2': { deltaAC: 1 },
  '4.3': { deltaAC: 1, deltaDC: 0 },
};
const ERAS: readonly Era[] = ['3.13', '4.0-4.2', '4.3'];
const cellIn = (
  cfId: `CF-${string}`,
  era: Era,
  action: string,
  limit?: string,
): SemanticsCell => {
  const cell = registryData.cells.find(
    (item) =>
      item.conformance.includes(cfId) &&
      item.key.era === era &&
      item.key.action === action &&
      item.key.limit === limit &&
      (item.key.delayedRetry ?? 'disabled') === 'disabled',
  );
  if (cell === undefined) throw new Error(`no ${cfId} cell for ${era}`);
  return cell;
};

const stampOf = (
  era: Era,
  control: Counters,
  tail: number | null = 1,
): EvidenceArtefact =>
  artefactOf(
    era,
    'CF-STAMP-01',
    [getStep('fin-first-control', { messageId: 'fin-control' })],
    [
      seen('fin-after-return', 'fin-control', 0, ...control),
      seen('fin-after-return', 'fin-tail', tail, null, null),
    ],
  );

/** Two quorum sources: the last delivery from each, and the dead letter that reached `dlq`. */
const carryOf = (era: Era, second: Counters, dead: Counters) =>
  artefactOf(
    era,
    'CF-CARRY-01',
    ['qq-amo', 'qq-alo'].map((source) =>
      getStep(`${source}-second`, {
        messageId: `${source}-m`,
        'x-delivery-count': second[0],
        'x-acquired-count': second[1],
      }),
    ),
    ['qq-amo', 'qq-alo'].flatMap((source) => [
      seen(`${source}-after`, `${source}-m`, null, null, null),
      seen('dlq-final', `${source}-m`, 0, ...dead),
    ]),
  );

/** The earlier delivery of a queue's message and the read that shows it again after a return. */
const returnedOf = (era: Era, queue: string, slot: string) =>
  artefactOf(
    era,
    'CF-DR',
    [
      getStep(`${queue}-first`, { messageId: `${queue}-m` }),
      getStep(`${queue}-${slot}`, {
        messageId: `${queue}-m`,
        'x-delivery-count': SENT[era][0],
        'x-acquired-count': SENT[era][1],
      }),
    ],
    [],
  );

describe('the projections read the counter headers per era', () => {
  it('AC-4 the landed projections read the counter headers per era, not as 4.3 does', () => {
    const dropped = { position: 'dlx-or-drop', destructive: true };
    for (const era of ERAS) {
      // CF-STAMP-01: the 4.2.9 result is AC from x-delivery-count and no deltaDC (the 4.3 reading
      // would give deltaAC 0 and deltaDC 1), the 3.13.7 one is deltaDC and no deltaAC.
      expect(
        projectStamp01(
          stampOf(era, SENT[era]),
          cellIn('CF-STAMP-01', era, 'amqp091.nack_requeue', 'finite'),
        ),
        `${era} CF-STAMP-01`,
      ).toStrictEqual({ ...DELTAS[era], position: 'head', destructive: false });

      // CF-DR-01 and CF-DR-02 have 4.3 cells only: the key's era says how to read the artefact.
      const landed = { ...DELTAS[era], position: 'head', destructive: false };
      expect(
        projectDr01(
          returnedOf(era, 'nack-all', 'now'),
          withKey(NACK_ALL, { era }),
        ),
        `${era} CF-DR-01`,
      ).toStrictEqual(landed);
      expect(
        projectDr02(
          returnedOf(era, 'rej-all', 'r1-p0'),
          withKey(REJECT_ALL, { era }),
        ),
        `${era} CF-DR-02`,
      ).toStrictEqual(landed);

      // CF-CARRY-01: a dead letter that starts afresh says nothing about a delta, on any era.
      expect(
        projectCarry01(
          carryOf(era, SENT[era], [null, null]),
          cellIn('CF-CARRY-01', era, 'amqp091.no_requeue'),
        ),
        `${era} CF-CARRY-01 afresh`,
      ).toStrictEqual(dropped);
    }

    // Across two queues a counter is projected only where both sides send its header. A dead
    // letter that shows only the acquired count has no deltaDC (an absent header read as 0 gave a
    // false deltaDC and a false `fail`: review finding B2).
    const carry = (era: Era, second: Counters, dead: Counters) =>
      projectCarry01(
        carryOf(era, second, dead),
        cellIn('CF-CARRY-01', era, 'amqp091.no_requeue'),
      );
    expect(carry('4.3', [0, 1], [1, 2])).toStrictEqual({
      ...dropped,
      deltaAC: 1,
      deltaDC: 1,
    });
    expect(carry('4.3', [0, 1], [null, 2])).toStrictEqual({
      ...dropped,
      deltaAC: 1,
    });
    // A counter the dead letter does show is still projected on the older eras.
    expect(carry('4.0-4.2', [1, null], [2, null])).toStrictEqual({
      ...dropped,
      deltaAC: 1,
    });
    expect(carry('3.13', [1, null], [2, null])).toStrictEqual({
      ...dropped,
      deltaDC: 1,
    });
  });

  it('AC-4 a control message that left the queue is projected as removed and a lost tail says nothing', () => {
    const cell = cellIn('CF-STAMP-01', '4.3', 'amqp091.nack_requeue', 'finite');
    const lost = artefactOf(
      '4.3',
      'CF-STAMP-01',
      [getStep('fin-first-control', { messageId: 'fin-control' })],
      [
        seen('fin-after-return', 'fin-control', null, null, null),
        seen('fin-after-return', 'fin-tail', 0, null, null),
      ],
    );
    expect(projectStamp01(lost, cell)).toStrictEqual({
      position: 'removed',
      destructive: true,
    });
    // The control message is there but the tail is not: the position cannot be told, so nothing.
    expect(projectStamp01(stampOf('4.3', [0, 1], null), cell)).toBeNull();
  });
});
