# routing

Pure broker routing simulation (TOP-02): direct, topic, fanout and headers exchanges, exchange-to-exchange chains, alternate exchanges, the default exchange and CC/BCC. It answers "which queues get a copy of this publish, and by which path?" from a plain description of one vhost. No I/O, no clock, no randomness.

Tags: `type:pure`, `runtime:isomorphic`. Working spec: [docs/specs/M1-02.md](../../../docs/specs/M1-02.md). Models an AMQP 0-9-1 publisher only (OQ-1108).

## Public API

Matchers (one per exchange type, each citing the broker source it reads):

- `routingKeysOf(routingKey, headers)`: the keys `[routingKey, ...CC, ...BCC]` with the source of each; a `CC` or `BCC` header that is not an array is a refusal (`{ok: false, header}`).
- `directRule(binding, keys)`, `fanoutRule()`, `topicRule(binding, keys, maxWords)`, `headersRule(binding, headers)`: the `MatchRule` by which a binding matches, or `null`.
- `topicMatches(pattern, key)`, `topicWordsMatch(words, words)`, `splitTopicKey(key)` (the empty key has zero words), `countHashWords(bindingKey)`.
- `parseXMatch(args)` (`all` | `any` | `all-with-x` | `any-with-x`, and whether the value is one the broker accepts), `headerValuesEqual(a, b)`.
- `routeDefault(keys, queueNames)` and `DEFAULT_EXCHANGE` (`""`); `alternateExchangeOf(exchange)` and `alternateExchangeApplies(ownDestinations, exchange)`.
- `DEFAULT_LIMITS`, `X_MATCH_MODES`, and the input and output types (`RoutingTopology`, `PublishInput`, `RoutingResult`, `RoutePath`, `RouteHop`, `MatchRule`, ...).

## Invariants

- Dependencies follow the type:pure row of blueprint 2.2; `pnpm nx lint routing` enforces them.
- No broker version is compared (I-3): the matching rules are the same on 3.13.7 to 4.3.6 (read from the broker source, tables in the specs); a version-dependent fact is an argument.
- Matching is O(pattern words x key words); no key can make it exponential.
- A missing or non-array `CC`/`BCC` header is a refusal, never silently an empty list.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p routing
```
