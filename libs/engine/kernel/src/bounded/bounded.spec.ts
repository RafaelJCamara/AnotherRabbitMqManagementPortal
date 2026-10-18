import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BoundedQueue, BoundedRing, type DropEvent } from './index.ts';

const KIB = 1024;
/** An item whose size is its own value, so the model is easy to state. */
const sized = (item: number): number => item;

describe('BoundedRing', () => {
  it('AC-2 a ring of 3 items drops the 2 oldest of 5 arrivals and reports dropped=2', () => {
    const ring = new BoundedRing<string>({ maxItems: 3, maxBytes: KIB });
    const dropsPerCall = ['a', 'b', 'c', 'd', 'e'].map((item) =>
      ring.add(item),
    );

    expect(ring.toArray()).toEqual(['c', 'd', 'e']);
    expect(ring.stats()).toMatchObject({ items: 3, bytes: 3, dropped: 2 });
    expect(ring.dropped).toBe(2);
    expect(dropsPerCall).toEqual([0, 0, 0, 1, 1]);
  });

  it('AC-2 a ring of 1 KiB drops the 2 oldest of 5 arrivals and reports dropped=2', () => {
    const ring = new BoundedRing<string>({ maxItems: 100, maxBytes: KIB });
    const items = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(300));
    for (const item of items) ring.add(item);

    // 3 x 300 = 900 bytes fit in 1024, a fourth would make 1200.
    expect(ring.toArray()).toEqual(items.slice(2));
    expect(ring.stats()).toMatchObject({
      items: 3,
      bytes: 900,
      dropped: 2,
      droppedBytes: 600,
    });
  });

  it('measures strings in UTF-8 bytes, not characters', () => {
    const ring = new BoundedRing<string>({ maxItems: 10, maxBytes: 8 });
    ring.add('€€'); // 2 characters, 6 bytes
    ring.add('€€'); // would be 12 bytes
    expect(ring.stats()).toMatchObject({ items: 1, bytes: 6, dropped: 1 });
  });

  it('measures binary data by its byte length', () => {
    const ring = new BoundedRing<Uint8Array>({ maxItems: 10, maxBytes: 10 });
    ring.add(new Uint8Array(6));
    ring.add(new Uint8Array(6));
    expect(ring.stats()).toMatchObject({ items: 1, bytes: 6, dropped: 1 });
  });

  it('drops an oversized item itself and leaves the contents alone', () => {
    const events: DropEvent[] = [];
    const ring = new BoundedRing<number>({
      maxItems: 3,
      maxBytes: 10,
      sizeOf: sized,
      onDrop: (event) => events.push(event),
    });
    ring.add(4);
    expect(ring.add(11)).toBe(1);
    expect(ring.toArray()).toEqual([4]);
    expect(ring.stats()).toMatchObject({ dropped: 1, droppedBytes: 11 });
    expect(events).toEqual([{ reason: 'oversized', items: 1, bytes: 11 }]);
  });

  it('reports each overflow once per call, with the count and bytes it dropped', () => {
    const events: DropEvent[] = [];
    const ring = new BoundedRing<number>({
      maxItems: 10,
      maxBytes: 10,
      sizeOf: sized,
      onDrop: (event) => events.push(event),
    });
    for (const item of [4, 4, 2]) ring.add(item);
    expect(events).toEqual([]);
    ring.add(9); // evicts 4, 4 and 2 to make room
    expect(events).toEqual([{ reason: 'overflow', items: 3, bytes: 10 }]);
    expect(ring.toArray()).toEqual([9]);
  });

  it('shift, peek and drain read from the oldest end and free the bytes', () => {
    const ring = new BoundedRing<number>({
      maxItems: 5,
      maxBytes: 100,
      sizeOf: sized,
    });
    for (const item of [1, 2, 3, 4]) ring.add(item);
    expect(ring.peek()).toBe(1);
    expect(ring.shift()).toBe(1);
    expect(ring.drain(2)).toEqual([2, 3]);
    expect(ring.bytes).toBe(4);
    expect(ring.drain()).toEqual([4]);
    expect(ring.size).toBe(0);
    expect(ring.bytes).toBe(0);
    expect(ring.shift()).toBeUndefined();
    expect(ring.peek()).toBeUndefined();
    expect(ring.dropped).toBe(0);
  });

  it('counts what clear() discards as dropped', () => {
    const events: DropEvent[] = [];
    const ring = new BoundedRing<number>({
      maxItems: 5,
      maxBytes: 100,
      sizeOf: sized,
      onDrop: (event) => events.push(event),
    });
    ring.add(3);
    ring.add(4);
    ring.clear();
    ring.clear(); // nothing left, nothing to report
    expect(ring.stats()).toMatchObject({ items: 0, bytes: 0, dropped: 2 });
    expect(events).toEqual([{ reason: 'cleared', items: 2, bytes: 7 }]);
  });

  it('is iterable, oldest first, over a snapshot', () => {
    const ring = new BoundedRing<number>({
      maxItems: 3,
      maxBytes: 100,
      sizeOf: sized,
    });
    for (const item of [1, 2, 3, 4]) ring.add(item);
    expect([...ring]).toEqual([2, 3, 4]);
  });

  it('keeps order across growth and wrap-around of the storage', () => {
    const ring = new BoundedRing<number>({
      maxItems: 40,
      maxBytes: 10_000,
      sizeOf: sized,
    });
    const expected: number[] = [];
    for (let i = 1; i <= 100; i += 1) {
      ring.add(i);
      expected.push(i);
      if (expected.length > 40) expected.shift();
      if (i % 3 === 0) {
        expect(ring.shift()).toBe(expected.shift());
      }
    }
    expect(ring.toArray()).toEqual(expected);
  });

  it('refuses a size that is not a non-negative integer', () => {
    const ring = new BoundedRing<number>({
      maxItems: 3,
      maxBytes: 10,
      sizeOf: (item) => item,
    });
    expect(() => ring.add(-1)).toThrow(RangeError);
    expect(() => ring.add(1.5)).toThrow(RangeError);
    expect(() => ring.add(Number.NaN)).toThrow(RangeError);
    expect(ring.size).toBe(0);
  });

  it('needs sizeOf for items that are not strings or binary data', () => {
    const ring = new BoundedRing<{ n: number }>({ maxItems: 3, maxBytes: 10 });
    expect(() => ring.add({ n: 1 })).toThrow(TypeError);
  });

  it('refuses limits that are not positive integers', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(() => new BoundedRing({ maxItems: bad, maxBytes: 10 })).toThrow(
        RangeError,
      );
      expect(() => new BoundedRing({ maxItems: 10, maxBytes: bad })).toThrow(
        RangeError,
      );
    }
  });

  it('matches a naive model for random operation sequences', () => {
    const operation = fc.oneof(
      fc.record({ op: fc.constant('add' as const), size: fc.nat(12) }),
      fc.record({ op: fc.constant('shift' as const) }),
      fc.record({ op: fc.constant('drain' as const), max: fc.nat(4) }),
      fc.record({ op: fc.constant('clear' as const) }),
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 30 }),
        fc.array(operation, { maxLength: 80 }),
        (maxItems, maxBytes, operations) => {
          const events: DropEvent[] = [];
          const ring = new BoundedRing<number>({
            maxItems,
            maxBytes,
            sizeOf: sized,
            onDrop: (event) => events.push(event),
          });
          let model: number[] = [];
          let modelDropped = 0;
          let modelDroppedBytes = 0;
          const drop = (items: number[]) => {
            modelDropped += items.length;
            modelDroppedBytes += items.reduce((a, b) => a + b, 0);
          };
          for (const step of operations) {
            if (step.op === 'add') {
              const before = ring.dropped;
              const returned = ring.add(step.size);
              if (step.size > maxBytes) {
                drop([step.size]);
              } else {
                while (
                  model.length >= maxItems ||
                  model.reduce((a, b) => a + b, 0) + step.size > maxBytes
                ) {
                  drop(model.splice(0, 1));
                }
                model.push(step.size);
              }
              expect(returned).toBe(ring.dropped - before);
            } else if (step.op === 'shift') {
              expect(ring.shift()).toBe(model.shift());
            } else if (step.op === 'drain') {
              expect(ring.drain(step.max)).toEqual(model.splice(0, step.max));
            } else {
              drop(model);
              model = [];
              ring.clear();
            }
            // The invariants of I-6, after every step.
            expect(ring.size).toBeLessThanOrEqual(maxItems);
            expect(ring.bytes).toBeLessThanOrEqual(maxBytes);
            expect(ring.toArray()).toEqual(model);
            expect(ring.bytes).toBe(model.reduce((a, b) => a + b, 0));
            expect(ring.dropped).toBe(modelDropped);
            expect(ring.stats().droppedBytes).toBe(modelDroppedBytes);
          }
          // Nothing is dropped silently (I-13): the events add up to the counter.
          expect(events.reduce((sum, event) => sum + event.items, 0)).toBe(
            modelDropped,
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('BoundedQueue', () => {
  it('refuses what does not fit and counts it as dropped', () => {
    const queue = new BoundedQueue<string>({ maxItems: 3, maxBytes: KIB });
    const accepted = ['a', 'b', 'c', 'd', 'e'].map((item) => queue.offer(item));

    expect(accepted).toEqual([true, true, true, false, false]);
    expect(queue.toArray()).toEqual(['a', 'b', 'c']);
    expect(queue.stats()).toMatchObject({ items: 3, bytes: 3, dropped: 2 });
  });

  it('refuses by bytes as well as by items', () => {
    const events: DropEvent[] = [];
    const queue = new BoundedQueue<string>({
      maxItems: 100,
      maxBytes: KIB,
      onDrop: (event) => events.push(event),
    });
    const items = ['a', 'b', 'c', 'd'].map((c) => c.repeat(300));
    expect(items.map((item) => queue.offer(item))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(events).toEqual([{ reason: 'full', items: 1, bytes: 300 }]);
    expect(queue.bytes).toBe(900);
  });

  it('accepts again once the consumer has made room', () => {
    const queue = new BoundedQueue<number>({
      maxItems: 2,
      maxBytes: 100,
      sizeOf: sized,
    });
    queue.offer(1);
    queue.offer(2);
    expect(queue.offer(3)).toBe(false);
    expect(queue.shift()).toBe(1);
    expect(queue.offer(3)).toBe(true);
    expect(queue.drain()).toEqual([2, 3]);
  });

  it('refuses an oversized item with its own reason', () => {
    const events: DropEvent[] = [];
    const queue = new BoundedQueue<number>({
      maxItems: 2,
      maxBytes: 10,
      sizeOf: sized,
      onDrop: (event) => events.push(event),
    });
    expect(queue.offer(11)).toBe(false);
    expect(events).toEqual([{ reason: 'oversized', items: 1, bytes: 11 }]);
  });

  it('matches a naive model for random operation sequences', () => {
    const operation = fc.oneof(
      fc.record({ op: fc.constant('offer' as const), size: fc.nat(12) }),
      fc.record({ op: fc.constant('shift' as const) }),
      fc.record({ op: fc.constant('clear' as const) }),
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 30 }),
        fc.array(operation, { maxLength: 80 }),
        (maxItems, maxBytes, operations) => {
          const queue = new BoundedQueue<number>({
            maxItems,
            maxBytes,
            sizeOf: sized,
          });
          let model: number[] = [];
          let modelDropped = 0;
          for (const step of operations) {
            if (step.op === 'offer') {
              const total = model.reduce((a, b) => a + b, 0);
              const fits =
                step.size <= maxBytes &&
                model.length < maxItems &&
                total + step.size <= maxBytes;
              expect(queue.offer(step.size)).toBe(fits);
              if (fits) model.push(step.size);
              else modelDropped += 1;
            } else if (step.op === 'shift') {
              expect(queue.shift()).toBe(model.shift());
            } else {
              modelDropped += model.length;
              model = [];
              queue.clear();
            }
            expect(queue.size).toBeLessThanOrEqual(maxItems);
            expect(queue.bytes).toBeLessThanOrEqual(maxBytes);
            expect(queue.toArray()).toEqual(model);
            expect(queue.dropped).toBe(modelDropped);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
