// The default exchange (name `""`), M1-02: it has no bindings and no alternate exchange. It routes
// each routing key of the message (CC and BCC included, deduplicated) to the queue of that name;
// a key that names no queue routes nowhere.
// RS@v4.3.6:deps/rabbit/src/rabbit_exchange.erl route/3 first clause L399-404 (the same in
// RS@v3.13.7 L351).
import type { KeyedKey } from './cc-bcc.ts';

export const DEFAULT_EXCHANGE = '';

export interface DefaultRoute {
  readonly queue: string;
  readonly key: string;
  readonly source: KeyedKey['source'];
}

/** The queues the keys name, one entry per queue (the first key that names it), in key order. */
export function routeDefault(
  keys: readonly KeyedKey[],
  queueNames: ReadonlySet<string>,
): DefaultRoute[] {
  const seen = new Set<string>();
  const routes: DefaultRoute[] = [];
  for (const { key, source } of keys) {
    if (!queueNames.has(key) || seen.has(key)) continue;
    seen.add(key);
    routes.push({ queue: key, key, source });
  }
  return routes;
}
