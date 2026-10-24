import { describe, expect, it } from 'vitest';

import { indexTopology } from './e2e.ts';
import { shareNoteFor, toRoutingNote } from './hash-random-notes.ts';
import { bind, bindX, deepFreeze, exchange, topology } from './testing.ts';

function present<T>(value: T | null): T {
  if (value === null) throw new Error('expected a note');
  return value;
}

describe('hash and random exchanges', () => {
  const t = deepFreeze(
    topology(
      [
        exchange('h', 'x-consistent-hash'),
        exchange('r', 'x-random'),
        exchange('d', 'direct'),
        exchange('other', 'fanout'),
      ],
      ['q3', 'q1', 'q2', 'z'],
      [
        bind('h', 'q3', '10'),
        bind('h', 'q1', '20'),
        bind('h', 'q1', '30'),
        bind('h', 'gone', '5'),
        bindX('h', 'other', ''),
        bind('r', 'q2'),
        bind('d', 'z', 'k'),
      ],
    ),
  );
  const index = indexTopology(t);

  it('M1-03 AC-5 dlx a consistent-hash exchange gives the share note with sorted candidates and no pick', () => {
    const note = shareNoteFor(
      index,
      { name: 'h', type: 'x-consistent-hash' },
      100,
    );
    expect(note).toEqual({
      code: 'non-deterministic-share',
      exchange: 'h',
      candidates: ['q1', 'q3'],
      exchangeDestinations: ['other'],
      truncated: 0,
    });
    expect(toRoutingNote(present(note))).toEqual({
      code: 'non-deterministic-share',
      exchange: 'h',
      detail: '2',
    });
  });

  it('M1-03 AC-5 dlx x-modulus-hash is a hash exchange, x-random and x-local-random are random ones', () => {
    expect(
      shareNoteFor(index, { name: 'h', type: 'x-modulus-hash' }, 10)?.code,
    ).toBe('non-deterministic-share');
    const random = shareNoteFor(index, { name: 'r', type: 'x-random' }, 10);
    expect(random?.code).toBe('random-destination');
    expect(random?.candidates).toEqual(['q2']);
    expect(
      shareNoteFor(index, { name: 'r', type: 'x-local-random' }, 10)?.code,
    ).toBe('random-destination');
  });

  it('M1-03 AC-5 dlx other types give no note', () => {
    for (const type of [
      'direct',
      'fanout',
      'topic',
      'headers',
      'x-delayed-message',
      'x-recent-history',
      'x-whatever',
    ]) {
      expect(shareNoteFor(index, { name: 'd', type }, 10)).toBeNull();
    }
  });

  it('M1-03 AC-5 dlx a candidate that is not in the topology is not listed', () => {
    const note = shareNoteFor(
      index,
      { name: 'h', type: 'x-consistent-hash' },
      10,
    );
    expect(note?.candidates).not.toContain('gone');
  });

  it('M1-03 AC-10 dlx candidates beyond the limit are counted, not dropped silently', () => {
    const note = shareNoteFor(
      index,
      { name: 'h', type: 'x-consistent-hash' },
      1,
    );
    expect(note?.candidates).toEqual(['q1']);
    expect(note?.truncated).toBe(1);
    expect(toRoutingNote(present(note)).detail).toBe('2');
    const none = shareNoteFor(
      index,
      { name: 'h', type: 'x-consistent-hash' },
      0,
    );
    expect(none?.candidates).toEqual([]);
    expect(none?.truncated).toBe(2);
  });

  it('M1-03 AC-5 dlx an exchange with no bindings has no candidates and says so', () => {
    const empty = indexTopology(
      topology([exchange('h', 'x-consistent-hash')], [], []),
    );
    expect(
      shareNoteFor(empty, { name: 'h', type: 'x-consistent-hash' }, 5),
    ).toEqual({
      code: 'non-deterministic-share',
      exchange: 'h',
      candidates: [],
      exchangeDestinations: [],
      truncated: 0,
    });
  });
});
