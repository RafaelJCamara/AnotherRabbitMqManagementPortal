// Direct exchange (M1-02): a binding matches when its key equals one of the message's routing keys
// (CC and BCC included); binding arguments play no part.
// RS@v4.3.6:deps/rabbit/src/rabbit_exchange_type_direct.erl L35-38 (the same in v3.13.7).
import type { KeyedKey } from './cc-bcc.ts';
import type { MatchRule, TopologyBinding } from './types.ts';

/** The rule by which the binding matches, or null. The first matching key is reported. */
export function directRule(
  binding: Pick<TopologyBinding, 'routingKey'>,
  keys: readonly KeyedKey[],
): Extract<MatchRule, { kind: 'direct' }> | null {
  for (const { key, source } of keys) {
    if (key === binding.routingKey) {
      return { kind: 'direct', routingKey: key, keySource: source };
    }
  }
  return null;
}
