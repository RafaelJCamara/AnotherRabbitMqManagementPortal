// The projections of the M0-40 lab cells (slice B: CF-CARRY-01 and CF-CARRY-03) say nothing about a
// cell they do not cover, and a contradicting artefact is a field-level mismatch, never a match.
import { registryData, type SemanticsCell } from '@app/semantics';
import { describe, expect, it } from 'vitest';

import type { EvidenceArtefact } from '../record/evidence.ts';
import { cfCarry01 } from '../scenarios/cf-carry-01.ts';
import { cfCarry03 } from '../scenarios/cf-carry-03.ts';
import { cfDr01 } from '../scenarios/cf-dr-01.ts';
import { cfDr02 } from '../scenarios/cf-dr-02.ts';
import { recordOnEra } from '../testing/era-broker.ts';
import { projectCarry01, projectCarry03 } from './projections-carry.ts';
import { projectDr01, projectDr02 } from './projections-dr.ts';

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
