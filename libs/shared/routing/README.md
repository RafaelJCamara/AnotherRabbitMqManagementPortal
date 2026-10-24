# routing

Pure broker routing simulation (TOP-02): direct, topic, fanout and headers exchanges, exchange-to-exchange chains, alternate exchanges, the default exchange and CC/BCC. It answers "which queues get a copy of this publish, and by which path?" from a plain description of one vhost, and (M1-03) "where does a message that dies in this queue go, which dead-letter rings drop messages, and which queues feed this one?". No I/O, no clock, no randomness.

Tags: `type:pure`, `runtime:isomorphic`. Working specs: [docs/specs/M1-02.md](../../../docs/specs/M1-02.md) (the walk) and [docs/specs/M1-03.md](../../../docs/specs/M1-03.md) (the dead-letter half). Models an AMQP 0-9-1 publisher only (OQ-1108).

## Public API

The simulator:

- `simulate(topology, publish, limits?)`: the queues that receive a copy of the publish, the path to each (one hop per exchange: the binding and the `MatchRule` that matched, or the alternate-exchange or default-exchange step), `usedAE`, the `outcome` (`routed`, `unroutable`, `indeterminate`, `refused`) and the broker's `fate` for it (delivered, returned with `basic.return` when mandatory, dropped, refused with 404/403/406), the exchanges it cannot model (`unknownExchanges`, never guessed), the loops among exchanges, `exact` (false: the queues are a lower bound), `truncation` (what each limit cut, counted) and `notes` (codes, not prose). `topology` may be the result of `indexTopology` to reuse the index.
- `indexTopology(topology)` and `findLoops(edges)` (iterative strongly connected components).

Matchers (one per exchange type, each citing the broker source it reads):

- `routingKeysOf(routingKey, headers)`: the keys `[routingKey, ...CC, ...BCC]` with the source of each; a `CC` or `BCC` header that is not an array is a refusal (`{ok: false, header}`).
- `directRule(binding, keys)`, `fanoutRule()`, `topicRule(binding, keys, maxWords)`, `headersRule(binding, headers)`: the `MatchRule` by which a binding matches, or `null`.
- `topicMatches(pattern, key)`, `topicWordsMatch(words, words)`, `splitTopicKey(key)` (the empty key has zero words), `countHashWords(bindingKey)`.
- `parseXMatch(args)` (`all` | `any` | `all-with-x` | `any-with-x`, and whether the value is one the broker accepts), `headerValuesEqual(a, b)`.
- `routeDefault(keys, queueNames)` and `DEFAULT_EXCHANGE` (`""`); `alternateExchangeOf(exchange)` and `alternateExchangeFor(ownDestinations, exchange)`.
- `validateBinding(exchangeType, binding, rules?)`: what the broker refuses when a binding is created (headers `x-match`; topic keys with more `#` words than `rules.topicMaxHashWildcards`, the limit coming from the registry capability `topicBindingHashWildcardLimit`).
- `DEFAULT_LIMITS`, `X_MATCH_MODES`, and the input and output types (`RoutingTopology`, `PublishInput`, `RoutingResult`, `RoutePath`, `RouteHop`, `MatchRule`, ...).

The dead-letter half (M1-03; the queue settings are optional fields of `TopologyQueue`, already resolved by the caller: argument over policy, M1-01):

- `deadLetterPath(topology, queue, options?)`: where a message that dies in `queue` goes, and on through queues that dead-letter again. One `DeadLetterPath` per end of a chain: its steps (the dying queue, the reasons, the dead-letter exchange, the keys, the delivered `targets` with `definite` or `possible` certainty, the targets the broker's cycle rule `dropped`) and its `end` (`terminal`, `dropped-cycle`, `dropped-unroutable`, `dropped-missing-exchange`, `dropped-no-dead-letter`, `indeterminate`, `truncated`). `options.reason` picks the first death, `options.keys` gives the message's routing keys (publish key, CC and BCC); a fixed `x-dead-letter-routing-key` is exact, open keys are a may-reach over-approximation.
- `findDlxLoops(topology, limits?)`: the dead-letter rings. `drop-loop`: no queue in it can be rejected from, so the broker drops what comes back to a queue it already died in (a queue that dead-letters into itself is dropped on the first lap). `retry-ring`: a queue in it is `rejectable`, so a message rejected somewhere in the ring keeps going. `unresolved` lists queues that dead-letter into the default exchange with open keys.
- `dlxSources(topology, queue, context?)`: every queue that can dead-letter into `queue`, with its own delivery limit (an absent one is `unknown`, never `unlimited`), `certainty`, the exchange route and its reasons, plus `complete` and `unknownReasons` (amendment A-2). **An empty `sources` is "no hazard" only when `complete` is true.** `context.gaps` carries what the caller could not read (`policy-unreadable`, `operator-policy-unreadable`, `stats-fields-missing`, `other-clients-may-declare`). A queue whose `rejectable` is not `false` is assumed to be possibly rejected from.
- `deadLetterReasons(queue)` (`rejected`, `expired`, `maxlen`, `delivery_limit`, from the queue's settings), `shareNoteFor` and `toRoutingNote` (the `non-deterministic-share` note of `x-consistent-hash`, `random-destination` of `x-random`, with the bound queues as candidates and never a pick), `routeDeadLetter` and `indexDeadLetters` (one step, and the shared index), `DEFAULT_DLX_LIMITS`.

## Invariants

- Dependencies follow the type:pure row of blueprint 2.2; `pnpm nx lint routing` enforces them.
- No broker version is compared (I-3): the matching rules are the same on 3.13.7 to 4.3.6 (read from the broker source, tables in the specs); a version-dependent fact is an argument.
- Matching is O(pattern words x key words); no key can make it exponential.
- The walk is the broker's (`rabbit_exchange:route1`): each exchange once, the alternate exchange only when the exchange's own destination list is empty, every message key (CC and BCC included) at every hop. It is bounded (depth, exchanges, binding evaluations, queues, paths, loops, notes); a cut is counted and makes the answer a lower bound (I-6, I-13).
- A missing or non-array `CC`/`BCC` header is a refusal, never silently an empty list.
- The dead-letter walk keeps the broker's cycle rule (read at v3.13.7 and v4.3.6): a rejection is never a cycle; otherwise a target that died on the current run of non-rejected deaths is dropped. Its state is (queue, queues of that run). Every cut is counted in `DlxTruncation` and makes the answer inexact or incomplete; nothing reads as "no hazard" by omission (I-13).
- No broker version is compared in the dead-letter half either; the delivery limit is data the caller reads (the `delivery_limit` stat) and the registry interprets.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p routing
```
