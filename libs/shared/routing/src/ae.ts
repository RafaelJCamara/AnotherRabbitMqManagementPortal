// Alternate exchange (M1-02, R2). The broker adds an exchange's `alternate-exchange` to the walk if
// and only if the exchange's OWN destination list is empty. The test is on the raw list before any
// existence check, and a destination that is an exchange counts as non-empty even when that
// exchange then routes nowhere. The AE comes from the exchange argument or a policy; the topology
// carries the resolved name (OQ-1104). The default exchange never has one.
// RS@v4.3.6:deps/rabbit/src/rabbit_exchange.erl process_alternate/2 L434-441 (v3.13.7 L397-404).
import type { TopologyExchange } from './types.ts';

/** The AE name to follow, or null. An empty name is no AE (OQ-1104). */
export function alternateExchangeOf(
  exchange: Pick<TopologyExchange, 'alternateExchange'>,
): string | null {
  const name = exchange.alternateExchange;
  return typeof name === 'string' && name !== '' ? name : null;
}

/** Whether the AE is added: the exchange's own destination list is empty and an AE is set. */
export function alternateExchangeApplies(
  ownDestinations: number,
  exchange: Pick<TopologyExchange, 'alternateExchange'>,
): boolean {
  return ownDestinations === 0 && alternateExchangeOf(exchange) !== null;
}
