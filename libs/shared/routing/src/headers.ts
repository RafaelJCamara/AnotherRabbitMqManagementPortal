// Headers exchange matching (M1-02, R2). The binding's `x-match` argument selects the mode:
// `all` (also when absent, unknown or not a string), `any`, `all-with-x`, `any-with-x`. In `all`
// and `any` every binding argument whose name starts with `x-` is skipped; in the `-with-x` modes
// only `x-match` itself is skipped. A void argument (null) matches when the message has that
// header at all; any other value must be strictly equal (Erlang `=:=`, OQ-1101). `all` over no
// compared argument is true, `any` over none is false. The message's own `x-` headers are visible;
// the routing key plays no part.
// RS@v4.3.6:deps/rabbit/src/rabbit_exchange_type_headers.erl route/3 L36-52, match/2 and match_x/2
// L54-66, match_all/3 and match_any/3 L69-87 (identical in RS@v3.13.7).
import type {
  HeaderTable,
  HeaderValue,
  MatchRule,
  TopologyBinding,
  XMatchMode,
} from './types.ts';
import { X_MATCH_MODES } from './types.ts';

export interface ParsedXMatch {
  readonly mode: XMatchMode;
  /** False when `x-match` is present with a value or type the broker rejects when binding. */
  readonly valid: boolean;
}

export function parseXMatch(args: HeaderTable | undefined): ParsedXMatch {
  if (args === undefined || !Object.hasOwn(args, 'x-match')) {
    return { mode: 'all', valid: true };
  }
  const value = args['x-match'];
  if (
    typeof value === 'string' &&
    (X_MATCH_MODES as readonly string[]).includes(value)
  ) {
    return { mode: value as XMatchMode, valid: true };
  }
  // The route function falls through to `all`; the validator refuses such a binding.
  return { mode: 'all', valid: false };
}

/** Strict structural equality; tables compare without regard to the order of their keys. */
export function headerValuesEqual(a: HeaderValue, b: HeaderValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const left = a as readonly HeaderValue[];
    const right = b as readonly HeaderValue[];
    return (
      left.length === right.length &&
      left.every((element, index) =>
        headerValuesEqual(element, right[index] as HeaderValue),
      )
    );
  }
  const left = a as Readonly<Record<string, HeaderValue>>;
  const right = b as Readonly<Record<string, HeaderValue>>;
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        headerValuesEqual(left[key] as HeaderValue, right[key] as HeaderValue),
    )
  );
}

function argumentHolds(
  name: string,
  wanted: HeaderValue,
  headers: HeaderTable,
): boolean {
  if (wanted === null) return Object.hasOwn(headers, name);
  return (
    Object.hasOwn(headers, name) &&
    headerValuesEqual(headers[name] as HeaderValue, wanted)
  );
}

/** The rule by which the binding matches the headers, or null. */
export function headersRule(
  binding: Pick<TopologyBinding, 'arguments'>,
  headers: HeaderTable | undefined,
): Extract<MatchRule, { kind: 'headers' }> | null {
  const args = binding.arguments ?? {};
  const { mode } = parseXMatch(args);
  const withX = mode === 'all-with-x' || mode === 'any-with-x';
  const wantAll = mode === 'all' || mode === 'all-with-x';
  const message = headers ?? {};
  const decided: string[] = [];
  for (const [name, wanted] of Object.entries(args)) {
    const skipped = withX ? name === 'x-match' : name.startsWith('x-');
    if (skipped) continue;
    const holds = argumentHolds(name, wanted, message);
    if (wantAll) {
      if (!holds) return null;
      decided.push(name);
    } else if (holds) {
      return { kind: 'headers', mode, arguments: [name] };
    }
  }
  return wantAll ? { kind: 'headers', mode, arguments: decided } : null;
}
