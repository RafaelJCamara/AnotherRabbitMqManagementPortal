import { describe, expect, it } from 'vitest';

import { EraBroker, type Era } from './era-broker.ts';

/** `[x-delivery-count, x-acquired-count]` on the second delivery after one `basic.nack` with requeue (fact sheet b.1). */
const SHOWN: Readonly<Record<Era, [number, number | null]>> = {
  '3.13': [1, null],
  '4.0-4.2': [1, null],
  '4.3': [0, 1],
};

describe('EraBroker', () => {
  it('AC-5 the era broker sends the counter headers each era sends', async () => {
    for (const era of Object.keys(SHOWN) as Era[]) {
      const broker = new EraBroker(era);
      await broker.declareQueue('q', { arguments: {} });
      await broker.publish('q', { messageId: 'm' });
      const first = await broker.get('c', 'q', false);
      expect(
        [first?.xDeliveryCount, first?.xAcquiredCount],
        `${era} first delivery`,
      ).toEqual([null, null]);
      await broker.settle('c', first?.tag ?? -1, {
        kind: 'nack',
        requeue: true,
      });
      const second = await broker.get('c', 'q', false);
      expect(
        [second?.xDeliveryCount, second?.xAcquiredCount],
        `${era} after one return`,
      ).toEqual(SHOWN[era]);
    }
  });
});
