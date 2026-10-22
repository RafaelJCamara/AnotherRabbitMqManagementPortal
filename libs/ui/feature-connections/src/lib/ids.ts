import { ConnectionIdSchema, type ConnectionId } from '@app/contracts';

/**
 * A connection id from the address. The contract only asks for a non-empty string (OQ-689), so the page also
 * requires a plain route token (the same rule the shell applies to `/c/:cid`): a letter or digit first, then
 * letters, digits and `. _ ~ -`, at most 128 characters. Anything else is not a connection of this page.
 */
const ROUTE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

export function connectionIdOf(
  raw: string | null | undefined,
): ConnectionId | null {
  if (raw === null || raw === undefined || !ROUTE_SEGMENT.test(raw))
    return null;
  const parsed = ConnectionIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
