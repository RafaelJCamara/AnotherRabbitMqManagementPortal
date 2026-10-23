// The routing keys of one AMQP 0-9-1 publish (M1-02, R2). The broker routes on
// `[RoutingKey | CC ++ BCC]`: `rabbit_basic:header_routes/1` reads the `CC` header, then the `BCC`
// header; an array contributes its string elements (other elements are skipped); a header of any
// other type fails the publish (`unacceptable_type_in_header`, a 406 channel error). The BCC
// header is stripped from the delivered message but still routes.
// RS@v4.3.6:deps/rabbit/src/rabbit_basic.erl L238-253, mc_amqpl.erl L548-565, rabbit_channel.erl L1229.
// The same code is in RS@v3.13.7 (OQ-1108: other protocols are not modelled).
import type { HeaderTable, KeySource, RoutingKeys } from './types.ts';

export interface KeyedKey {
  readonly key: string;
  readonly source: KeySource;
}

export type RoutingKeysOutcome =
  | {
      readonly ok: true;
      readonly keys: readonly KeyedKey[];
      readonly parts: RoutingKeys;
    }
  | { readonly ok: false; readonly header: 'CC' | 'BCC' };

function stringsOf(
  headers: HeaderTable | undefined,
  name: 'CC' | 'BCC',
): readonly string[] | null {
  if (headers === undefined || !Object.hasOwn(headers, name)) return [];
  const value = headers[name];
  if (!Array.isArray(value)) return null;
  return value.filter(
    (element): element is string => typeof element === 'string',
  );
}

/**
 * The routing keys in broker order: the routing key, the CC keys, the BCC keys. A `CC` or `BCC`
 * header that is present and not an array is a refusal, never an empty list (CC is checked first).
 */
export function routingKeysOf(
  routingKey: string,
  headers: HeaderTable | undefined,
): RoutingKeysOutcome {
  const cc = stringsOf(headers, 'CC');
  if (cc === null) return { ok: false, header: 'CC' };
  const bcc = stringsOf(headers, 'BCC');
  if (bcc === null) return { ok: false, header: 'BCC' };
  const keys: KeyedKey[] = [
    { key: routingKey, source: 'routing-key' },
    ...cc.map((key): KeyedKey => ({ key, source: 'cc' })),
    ...bcc.map((key): KeyedKey => ({ key, source: 'bcc' })),
  ];
  return { ok: true, keys, parts: { routingKey, cc, bcc } };
}
