// Fanout exchange (M1-02): every binding matches; the routing keys, the headers and the binding
// arguments play no part.
// RS@v4.3.6:deps/rabbit/src/rabbit_exchange_type_fanout.erl L31-33 (the same in v3.13.7).
import type { MatchRule } from './types.ts';

export const FANOUT_RULE: Extract<MatchRule, { kind: 'fanout' }> = {
  kind: 'fanout',
};

export function fanoutRule(): Extract<MatchRule, { kind: 'fanout' }> {
  return FANOUT_RULE;
}
