// The acceptance criteria of M0-12 (issue #11), asked of the registry this release ships.
import { describe, expect, it } from 'vitest';
import {
  auditCells,
  registryData,
  SemanticsGapError,
  semanticsRegistry,
  SettleActionSchema,
  type SettleAction,
} from './index.ts';

type Era = '3.13' | '4.0-4.2' | '4.3';
const ERAS: readonly Era[] = ['3.13', '4.0-4.2', '4.3'];

/** Fact sheet b.2: the actions of the matrix, and where a row says "n/a". */
const NOT_APPLICABLE = new Set<string>(['3.13|amqp10.detach_unsettled']);

describe('M0-12 acceptance', () => {
  it('AC-1 every b.2 action x era x queue type has a cell with an RS@tag citation and a CF id, and audit-cells passes', () => {
    // b.2 is the quorum queue matrix; every action of the vocabulary is one of its rows.
    expect(SettleActionSchema.options).toHaveLength(13);
    for (const action of SettleActionSchema.options) {
      for (const era of ERAS) {
        const found = registryData.cells.filter(
          (cell) =>
            cell.key.action === action &&
            cell.key.era === era &&
            cell.key.queueType === 'quorum',
        );
        if (NOT_APPLICABLE.has(`${era}|${action}`)) {
          expect(found, `${era} ${action}`).toEqual([]);
          continue;
        }
        expect(found.length, `${era} ${action}`).toBeGreaterThan(0);
        for (const cell of found) {
          expect(
            cell.citations.some(
              (citation) =>
                citation.kind === 'S' &&
                /^RS@v\d+\.\d+\.\d+:/.test(citation.ref),
            ),
            cell.id,
          ).toBe(true);
          expect(cell.conformance.length, cell.id).toBeGreaterThan(0);
        }
      }
    }
    expect(
      auditCells(registryData.cells, {
        require: ['citations', 'conformance', 'effect'],
      }),
    ).toEqual([]);
  });

  it('AC-2 cell(4.0-4.2, quorum, amqp091, nack_requeue, finite) is deltaAC 1, counts, head; cell(3.13, quorum, amqp10, modified_df_false) is destructive', () => {
    const nack = semanticsRegistry.cell({
      era: '4.0-4.2',
      queueType: 'quorum',
      protocol: 'amqp091',
      action: 'amqp091.nack_requeue',
      limit: 'finite',
    });
    expect(nack.effect?.deltaAC).toBe(1);
    expect(nack.effect?.countsTowardLimit).toBe('yes');
    expect(nack.effect?.position).toBe('head');

    const modified = semanticsRegistry.cell({
      era: '3.13',
      queueType: 'quorum',
      protocol: 'amqp10',
      action: 'amqp10.modified_df_false',
    });
    expect(modified.effect?.destructive).toBe(true);
  });

  it('AC-2 a key the fact sheet does not settle is a gap, never a default', () => {
    const settled: SettleAction = 'amqp091.nack_requeue';
    // A limit state the cell does not distinguish, a queue type b.2 does not cover, 4.4.
    for (const key of [
      {
        era: '4.0-4.2',
        queueType: 'quorum',
        protocol: 'amqp091',
        action: settled,
      },
      {
        era: '4.0-4.2',
        queueType: 'quorum',
        protocol: 'amqp091',
        action: settled,
        limit: 'unset',
      },
      {
        era: '4.0-4.2',
        queueType: 'classic',
        protocol: 'amqp091',
        action: settled,
        limit: 'finite',
      },
      {
        era: '4.0-4.2',
        queueType: 'stream',
        protocol: 'amqp091',
        action: settled,
        limit: 'finite',
      },
      {
        era: '4.4',
        queueType: 'quorum',
        protocol: 'amqp091',
        action: settled,
        limit: 'finite',
        delayedRetry: 'disabled',
      },
      {
        era: '3.13',
        queueType: 'quorum',
        protocol: 'amqp10',
        action: 'amqp10.detach_unsettled',
        limit: 'finite',
      },
    ] as const) {
      expect(() => semanticsRegistry.cell(key)).toThrow(SemanticsGapError);
    }
  });
});
