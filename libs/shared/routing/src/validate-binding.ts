// What the broker refuses when a binding is created (M1-02, R9), for a planner that wants to know
// before it sends one. The checks are the exchange types' `validate_binding/2`:
//  - headers: `x-match`, when present, must be the string `all`, `any`, `all-with-x` or
//    `any-with-x`; another string or another type is refused
//    (RS@v4.3.6:deps/rabbit/src/rabbit_exchange_type_headers.erl L89-104, the same at v3.13.7);
//  - topic: a binding key with more than two whole `#` words is refused, from 4.3.5 only
//    (RS@v4.3.6:deps/rabbit/src/rabbit_exchange_type_topic.erl MAX_HASH_WILDCARDS and
//    validate_binding/2; absent up to v4.3.4).
// The `#` limit is an argument, not a version test (I-3): the caller asks the registry capability
// `topicBindingHashWildcardLimit` and passes the limit, or passes none.
import { parseXMatch } from './headers.ts';
import { countHashWords } from './topic.ts';
import type { TopologyBinding } from './types.ts';

export interface BindingRules {
  /** The most `#` words a topic binding key may have; absent means the broker does not check. */
  readonly topicMaxHashWildcards?: number;
}

export type BindingProblem =
  | { readonly code: 'invalid-x-match-value'; readonly value: string }
  | { readonly code: 'invalid-x-match-type'; readonly valueType: string }
  | {
      readonly code: 'too-many-hash-words';
      readonly count: number;
      readonly max: number;
    };

function valueKind(value: unknown): string {
  if (value === null) return 'void';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'table' : typeof value;
}

export function validateBinding(
  exchangeType: string,
  binding: Pick<TopologyBinding, 'routingKey' | 'arguments'>,
  rules: BindingRules = {},
): readonly BindingProblem[] {
  if (exchangeType === 'headers') {
    const { valid } = parseXMatch(binding.arguments);
    if (valid) return [];
    const value = binding.arguments?.['x-match'];
    return typeof value === 'string'
      ? [{ code: 'invalid-x-match-value', value }]
      : [{ code: 'invalid-x-match-type', valueType: valueKind(value) }];
  }
  if (exchangeType === 'topic' && rules.topicMaxHashWildcards !== undefined) {
    const count = countHashWords(binding.routingKey);
    if (count > rules.topicMaxHashWildcards) {
      return [
        {
          code: 'too-many-hash-words',
          count,
          max: rules.topicMaxHashWildcards,
        },
      ];
    }
  }
  return [];
}
