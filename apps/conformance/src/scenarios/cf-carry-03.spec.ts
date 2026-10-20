// CF-CARRY-03 against the era broker (testing/era-broker.ts). The era broker encodes the registry's
// own claims, so these tests prove the plumbing (what the scenario records, what the projection
// reads); they say nothing about what RabbitMQ does.
import { registryData } from '@app/semantics';
import { describe, expect, it } from 'vitest';

import { projectCarry03 } from '../assert/projections-carry.ts';
import { recordOnEra, type Era } from '../testing/era-broker.ts';
import { cfCarry03, LIMIT, MESSAGE } from './cf-carry-03.ts';

const CELL =
  'SEM-4.3-quorum-amqp091-amqp091.nack_requeue-limit-finite-delayed-disabled';
/** Per era: the arrival count, then whether the message is in dlq and in dlq2 after its first return, its acquired count, the cells spoken for. */
const EXPECTED: Readonly<
  Record<Era, [number | null, boolean, boolean, number | null, string[]]>
> = {
  '3.13': [null, true, false, null, []],
  '4.0-4.2': [null, true, false, 1, []],
  '4.3': [LIMIT + 1, false, true, null, [CELL]],
};

describe('CF-CARRY-03', () => {
  it('AC-5 a message dead-lettered at L+1 is dropped or re-dead-lettered by its first return on 4.3 and keeps a fresh budget on 4.0-4.2', async () => {
    for (const era of Object.keys(EXPECTED) as Era[]) {
      const [arrival, inDlq, inDlq2, acquired, spokenIds] = EXPECTED[era];
      const artefact = await recordOnEra(era, cfCarry03);
      // L + 1 returns: one fewer would not exceed the limit, and the run would not reach `dlq`.
      expect(
        artefact.steps.filter(
          (step) => step.op === 'settle' && step.args.action === 'reject',
        ),
        era,
      ).toHaveLength(LIMIT + 1);
      const seen = (name: string) =>
        artefact.observations.find(
          (item) => item.name === name && item.messageId === MESSAGE,
        );
      const first = artefact.steps.find((step) => step.args.as === 'dlq-first');
      expect(first?.result['x-delivery-count'], era).toBe(arrival);
      expect(
        [seen('dlq-after-return')?.survived, seen('dlq2-final')?.survived],
        era,
      ).toEqual([inDlq, inDlq2]);
      expect(seen('dlq-after-return')?.['x-acquired-count'], era).toBe(
        acquired,
      );

      // Only the nack_requeue cell of a finite-limit queue without delayed retry is spoken for; the
      // other cells that name the id (partition, delayed retry, AMQP 1.0, HTTP) get nothing.
      const cells = registryData.cells.filter(
        (cell) =>
          cell.conformance.includes('CF-CARRY-03') && cell.key.era === era,
      );
      const spoken = cells.filter((cell) => projectCarry03(artefact, cell));
      expect(
        spoken.map((cell) => cell.id),
        era,
      ).toEqual(spokenIds);
      for (const cell of spoken) {
        const effect = cell.effect as { countsTowardLimit: string };
        expect(projectCarry03(artefact, cell)).toEqual({
          countsTowardLimit: effect.countsTowardLimit,
        });
      }
      expect(cells.length > spoken.length, era).toBe(spokenIds.length > 0);
    }
  });
});
