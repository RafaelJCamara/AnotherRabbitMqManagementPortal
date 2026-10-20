// CF-CARRY-01 against the era broker (testing/era-broker.ts). The era broker encodes the registry's
// own claims, so these tests prove the plumbing (what the scenario records, what the projection
// reads); they say nothing about what RabbitMQ does.
import { registryData } from '@app/semantics';
import { describe, expect, it } from 'vitest';

import { projectCarry01 } from '../assert/projections-carry.ts';
import { recordOnEra, type Era } from '../testing/era-broker.ts';
import { CARRY_SOURCES, cfCarry01 } from './cf-carry-01.ts';

const ERAS: readonly Era[] = ['3.13', '4.0-4.2', '4.3'];
/** The counters (acquired, delivery) a dead letter shows in `dlq` per era: carried on 4.3 only. */
const SHOWN: Readonly<Record<Era, [number | null, number | null]>> = {
  '3.13': [null, null],
  '4.0-4.2': [null, null],
  '4.3': [2, 1],
};

describe('CF-CARRY-01', () => {
  it('AC-4 a rejected message dead-lettered into a quorum queue is recorded with its carried counters per era', async () => {
    for (const era of ERAS) {
      const artefact = await recordOnEra(era, cfCarry01);
      // Every source variant, the classic one included, is recorded: it left its source and arrived.
      for (const source of Object.keys(CARRY_SOURCES)) {
        const find = (name: string) =>
          artefact.observations.find(
            (item) => item.name === name && item.messageId === `${source}-m`,
          );
        expect(find(`${source}-after`)?.survived, `${era} ${source}`).toBe(
          false,
        );
        expect(find('dlq-final'), `${era} ${source}`).toMatchObject({
          survived: true,
          'x-acquired-count': SHOWN[era][0],
          'x-delivery-count': SHOWN[era][1],
        });
      }

      const cells = registryData.cells.filter(
        (cell) =>
          cell.conformance.includes('CF-CARRY-01') && cell.key.era === era,
      );
      expect(
        cells.map((cell) => cell.key.action),
        era,
      ).toEqual(['amqp091.no_requeue']);
      for (const cell of cells) {
        const observed = projectCarry01(artefact, cell);
        const effect = cell.effect as Record<string, unknown>;
        // Position and destructiveness always; the deltas only where the counters were carried.
        expect(observed, cell.id).toEqual({
          position: effect.position,
          destructive: effect.destructive,
          ...(SHOWN[era][0] !== null
            ? { deltaAC: effect.deltaAC, deltaDC: effect.deltaDC }
            : {}),
        });
      }
    }
  });
});
