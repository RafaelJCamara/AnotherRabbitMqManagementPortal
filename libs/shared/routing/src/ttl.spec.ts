import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { deadLetterReasons } from './ttl.ts';
import type { DeadLetterSetting, TopologyQueue } from './types.ts';

const DLX: DeadLetterSetting = { status: 'set', exchange: 'dlx' };
const q = (extra: Partial<TopologyQueue>): TopologyQueue => ({
  name: 'q',
  deadLetter: DLX,
  ...extra,
});

describe('dead-letter reasons of a queue', () => {
  it('M1-03 AC-6 dlx a queue with no dead-letter exchange has no reason that goes anywhere', () => {
    expect(
      deadLetterReasons({
        type: 'quorum',
        messageTtlMs: 1000,
        maxLength: 5,
        rejectable: true,
      }),
    ).toEqual([]);
  });

  it('M1-03 AC-6 dlx a stream dead-letters nothing', () => {
    expect(
      deadLetterReasons(q({ type: 'stream', messageTtlMs: 1, maxLength: 1 })),
    ).toEqual([]);
  });

  it('M1-03 AC-6 dlx expired needs a finite queue TTL (a TTL of 0 counts, a negative or absent one does not)', () => {
    expect(deadLetterReasons(q({ messageTtlMs: 5000 }))).toEqual(['expired']);
    expect(deadLetterReasons(q({ messageTtlMs: 0 }))).toEqual(['expired']);
    expect(deadLetterReasons(q({ messageTtlMs: -1 }))).toEqual([]);
    expect(deadLetterReasons(q({ messageTtlMs: null }))).toEqual([]);
    expect(deadLetterReasons(q({ messageTtlMs: Infinity }))).toEqual([]);
    expect(deadLetterReasons(q({}))).toEqual([]);
  });

  it('M1-03 AC-6 dlx maxlen needs a length limit and an overflow that dead-letters', () => {
    for (const overflow of [null, 'drop-head', 'reject-publish-dlx'] as const) {
      expect(deadLetterReasons(q({ maxLength: 10, overflow }))).toEqual([
        'maxlen',
      ]);
    }
    expect(deadLetterReasons(q({ maxLength: 10 }))).toEqual(['maxlen']);
    expect(
      deadLetterReasons(q({ maxLength: 10, overflow: 'reject-publish' })),
    ).toEqual([]);
    expect(deadLetterReasons(q({ maxLengthBytes: 1024 }))).toEqual(['maxlen']);
    expect(deadLetterReasons(q({ overflow: 'drop-head' }))).toEqual([]);
  });

  it('M1-03 AC-6 dlx delivery_limit is for a quorum queue unless the limit is unlimited; an absent limit counts', () => {
    expect(deadLetterReasons(q({ type: 'quorum' }))).toEqual([
      'delivery_limit',
    ]);
    expect(
      deadLetterReasons(
        q({ type: 'quorum', deliveryLimit: { kind: 'finite', value: 20 } }),
      ),
    ).toEqual(['delivery_limit']);
    expect(
      deadLetterReasons(
        q({ type: 'quorum', deliveryLimit: { kind: 'unknown' } }),
      ),
    ).toEqual(['delivery_limit']);
    expect(
      deadLetterReasons(
        q({ type: 'quorum', deliveryLimit: { kind: 'unlimited' } }),
      ),
    ).toEqual([]);
    expect(
      deadLetterReasons(
        q({ type: 'classic', deliveryLimit: { kind: 'finite', value: 20 } }),
      ),
    ).toEqual([]);
    expect(deadLetterReasons(q({}))).toEqual([]);
  });

  it('M1-03 AC-6 dlx rejected needs rejectable true; absent or false gives none', () => {
    expect(deadLetterReasons(q({ rejectable: true }))).toEqual(['rejected']);
    expect(deadLetterReasons(q({ rejectable: false }))).toEqual([]);
  });

  it('M1-03 AC-6 dlx an unknown dead-letter setting still gives the reasons (it may go somewhere)', () => {
    expect(
      deadLetterReasons({
        deadLetter: { status: 'unknown' },
        type: 'quorum',
        messageTtlMs: 10,
        rejectable: true,
      }),
    ).toEqual(['delivery_limit', 'expired', 'rejected']);
  });

  it('M1-03 AC-6 dlx all reasons together come out sorted', () => {
    expect(
      deadLetterReasons(
        q({
          type: 'quorum',
          messageTtlMs: 1,
          maxLength: 1,
          rejectable: true,
        }),
      ),
    ).toEqual(['delivery_limit', 'expired', 'maxlen', 'rejected']);
  });

  it('M1-03 AC-6 dlx adding a TTL or a length limit never removes a reason, and the answer is sorted', () => {
    const settings = fc.record(
      {
        type: fc.constantFrom('classic', 'quorum', 'stream'),
        messageTtlMs: fc.option(fc.integer({ min: -2, max: 100 }), {
          nil: undefined,
        }),
        maxLength: fc.option(fc.integer({ min: -2, max: 100 }), {
          nil: undefined,
        }),
        overflow: fc.constantFrom(
          undefined,
          null,
          'drop-head',
          'reject-publish',
          'reject-publish-dlx',
        ),
        rejectable: fc.option(fc.boolean(), { nil: undefined }),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(settings, (base) => {
        const queue = q(base as Partial<TopologyQueue>);
        const reasons = deadLetterReasons(queue);
        expect([...reasons].sort()).toEqual([...reasons]);
        const more = deadLetterReasons({
          ...queue,
          messageTtlMs: 5,
          maxLength: 5,
        });
        for (const reason of reasons) {
          if (reason === 'expired' || reason === 'maxlen') {
            expect(more).toContain(reason);
          }
        }
        expect(more).toEqual(expect.arrayContaining(reasons as string[]));
      }),
    );
  });
});
