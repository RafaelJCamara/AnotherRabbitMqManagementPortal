import { describe, expect, it } from 'vitest';
import { isDoomed, type DeliveryLimit } from './doomed.ts';

const finite = (value: number): DeliveryLimit => ({ kind: 'finite', value });
const UNLIMITED: DeliveryLimit = { kind: 'unlimited' };

describe('isDoomed: AC-2', () => {
  it('AC-2 on 4.3 a delivery count of 21 with L=20 is doomed', () => {
    expect(isDoomed('4.3', { deliveryCount: 21 }, finite(20))).toBe(true);
  });

  it('AC-2 on 4.0-4.2 x-delivery-count (the acquired count) 20 with L=20 is doomed', () => {
    expect(isDoomed('4.0-4.2', { deliveryCount: 20 }, finite(20))).toBe(true);
  });

  it('AC-2 an unlimited queue is never doomed, whatever the counters and era', () => {
    for (const era of ['3.13', '4.0-4.2', '4.3', '4.4'] as const) {
      expect(
        isDoomed(
          era,
          { deliveryCount: 1_000_000, acquiredCount: 1_000_000 },
          UNLIMITED,
        ),
      ).toBe(false);
    }
  });
});

describe('isDoomed: the boundary (a > turned into >= must be caught)', () => {
  it('4.3 and later: doomed only above the limit', () => {
    for (const era of ['4.3', '4.4'] as const) {
      expect(isDoomed(era, { deliveryCount: 19 }, finite(20))).toBe(false);
      expect(isDoomed(era, { deliveryCount: 20 }, finite(20))).toBe(false);
      expect(isDoomed(era, { deliveryCount: 21 }, finite(20))).toBe(true);
    }
  });

  it('4.0-4.2: doomed at the limit', () => {
    expect(isDoomed('4.0-4.2', { deliveryCount: 19 }, finite(20))).toBe(false);
    expect(isDoomed('4.0-4.2', { deliveryCount: 20 }, finite(20))).toBe(true);
    expect(isDoomed('4.0-4.2', { deliveryCount: 21 }, finite(20))).toBe(true);
  });

  it('3.13 with a limit: doomed at the limit', () => {
    expect(isDoomed('3.13', { deliveryCount: 19 }, finite(20))).toBe(false);
    expect(isDoomed('3.13', { deliveryCount: 20 }, finite(20))).toBe(true);
  });

  it('the acquired count does not doom a message on 4.3 (it is not counted toward the limit)', () => {
    expect(
      isDoomed('4.3', { deliveryCount: 3, acquiredCount: 50 }, finite(20)),
    ).toBe(false);
  });

  it('before 4.3 either counter at the limit dooms the message', () => {
    expect(isDoomed('4.0-4.2', { acquiredCount: 20 }, finite(20))).toBe(true);
    expect(isDoomed('4.0-4.2', { acquiredCount: 19 }, finite(20))).toBe(false);
  });
});

describe('isDoomed: absent and unverifiable input', () => {
  it('a message with no counter header was never returned', () => {
    expect(isDoomed('4.3', {}, finite(20))).toBe(false);
    expect(isDoomed('4.0-4.2', {}, finite(20))).toBe(false);
  });

  it('a limit of 1 dooms a message that was already returned once on 4.0-4.2 but not on 4.3', () => {
    expect(isDoomed('4.0-4.2', { deliveryCount: 1 }, finite(1))).toBe(true);
    expect(isDoomed('4.3', { deliveryCount: 1 }, finite(1))).toBe(false);
    expect(isDoomed('4.3', { deliveryCount: 2 }, finite(1))).toBe(true);
  });

  it('treats an unknown limit as doomed (fail closed)', () => {
    for (const era of ['3.13', '4.0-4.2', '4.3', '4.4'] as const) {
      expect(isDoomed(era, { deliveryCount: 0 }, { kind: 'unknown' })).toBe(
        true,
      );
    }
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'treats the unreadable counter %s as doomed',
    (count) => {
      expect(isDoomed('4.3', { deliveryCount: count }, finite(20))).toBe(true);
      expect(isDoomed('4.0-4.2', { acquiredCount: count }, finite(20))).toBe(
        true,
      );
    },
  );

  it('treats a limit that is not a number as doomed', () => {
    expect(isDoomed('4.3', { deliveryCount: 0 }, finite(Number.NaN))).toBe(
      true,
    );
  });

  it('does not let an unreadable counter doom an unlimited queue', () => {
    expect(isDoomed('4.3', { deliveryCount: Number.NaN }, UNLIMITED)).toBe(
      false,
    );
  });
});
