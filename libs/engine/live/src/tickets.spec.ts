import { createManualClock } from '@app/kernel';
import { describe, expect, it } from 'vitest';

import { alice, bob } from './testing.ts';
import { createTicketStore, MAX_TICKETS, TICKET_TTL_MS } from './tickets.ts';

describe('live tickets', () => {
  it('AC-1 a ticket is redeemed once, by value, for the principal it was issued to', () => {
    const store = createTicketStore();
    const forAlice = store.issue(alice);
    const forBob = store.issue(bob);
    expect(forAlice).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(forAlice).not.toBe(forBob);
    expect(store.redeem(forBob)).toBe(bob);
    expect(store.redeem(forBob)).toBeUndefined();
    expect(store.redeem(forAlice)).toBe(alice);
    expect(store.redeem('unknown')).toBeUndefined();
    expect(store.redeem('')).toBeUndefined();
  });

  it('AC-1 a ticket is valid for 30 s and not a millisecond longer', () => {
    expect(TICKET_TTL_MS).toBe(30_000);
    const clock = createManualClock();
    const store = createTicketStore({ clock });
    const edge = store.issue(alice);
    const late = store.issue(alice);
    clock.advance(30_000);
    expect(store.redeem(edge)).toBe(alice);
    clock.advance(1);
    expect(store.redeem(late)).toBeUndefined();
  });

  it('AC-1 the store is bounded: when full, the oldest ticket makes room', () => {
    const clock = createManualClock();
    const store = createTicketStore({ clock, max: 3 });
    const first = store.issue(alice);
    store.issue(alice);
    store.issue(alice);
    // Full: the oldest ticket makes room.
    const fourth = store.issue(alice);
    expect(store.redeem(first)).toBeUndefined();
    expect(store.redeem(fourth)).toBe(alice);
    expect(MAX_TICKETS).toBe(1024);
  });
});
