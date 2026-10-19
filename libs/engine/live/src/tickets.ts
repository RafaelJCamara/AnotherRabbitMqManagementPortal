// WebSocket tickets (blueprint 7.2), issued and redeemed by the transport (ws/upgrade.ts; the
// store lives here to keep the transport kit under its ADR-004 cap, OQ-331): a browser cannot set headers on a WebSocket, so the page asks
// for a ticket with its normal credentials and presents it in `Sec-WebSocket-Protocol`. A ticket
// is 256 random bits, single use, valid 30 s and bound to the principal that asked. The store is
// bounded (I-6): when it is full the oldest ticket is forgotten.
import { randomBytes } from 'node:crypto';

import { systemClock, type Clock } from '@app/kernel';
import type { Principal } from '@app/ports';

export const TICKET_TTL_MS = 30_000;
export const MAX_TICKETS = 1024;

export interface TicketStore {
  issue(principal: Principal): string;
  /** The principal the ticket was issued to, once; undefined when unknown, used or expired. */
  redeem(ticket: string): Principal | undefined;
}

export function createTicketStore(
  options: { clock?: Clock; ttlMs?: number; max?: number } = {},
): TicketStore {
  const {
    clock = systemClock,
    ttlMs = TICKET_TTL_MS,
    max = MAX_TICKETS,
  } = options;
  /** Insertion order is expiry order: the lifetime is the same for every ticket. */
  const tickets = new Map<string, { principal: Principal; expires: number }>();
  return {
    issue(principal) {
      const now = clock.monotonic();
      // Forget what expired, and the oldest while the store is full.
      for (const [old, entry] of tickets) {
        if (now <= entry.expires && tickets.size < max) break;
        tickets.delete(old);
      }
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(ticket, { principal, expires: now + ttlMs });
      return ticket;
    },
    redeem(ticket) {
      const entry = tickets.get(ticket);
      tickets.delete(ticket);
      return entry !== undefined && clock.monotonic() <= entry.expires
        ? entry.principal
        : undefined;
    },
  };
}
