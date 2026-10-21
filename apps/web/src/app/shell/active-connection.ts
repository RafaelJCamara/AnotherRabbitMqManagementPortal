// The connection the shell is showing. The shell host sets it from the `:cid` route parameter and
// clears it when it goes away; everything that needs "the active connection" reads it from here
// and so never sees an id that failed validation.
import { Injectable, signal, type Signal } from '@angular/core';
import { ConnectionIdSchema, type ConnectionId } from '@app/contracts';

/**
 * A connection id as a route segment. `ConnectionIdSchema` only asks for a non-empty string
 * (OQ-689), so the UI also requires a plain token: a letter or digit first, then letters, digits
 * and `. _ ~ -`, at most 128 characters. Anything else is treated as no connection.
 */
const ROUTE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

export function parseConnectionParam(
  raw: string | null | undefined,
): ConnectionId | null {
  if (raw === null || raw === undefined || !ROUTE_SEGMENT.test(raw)) {
    return null;
  }
  const parsed = ConnectionIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

@Injectable({ providedIn: 'root' })
export class ActiveConnection {
  readonly #cid = signal<ConnectionId | null>(null);
  readonly cid: Signal<ConnectionId | null> = this.#cid.asReadonly();

  select(cid: ConnectionId | null): void {
    this.#cid.set(cid);
  }
}
