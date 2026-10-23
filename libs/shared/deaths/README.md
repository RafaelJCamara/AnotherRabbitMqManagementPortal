# deaths

The death-history normaliser (DLQ-02, M1-04): `x-death`, `x-opt-deaths`, `x-first-death-*` and `x-last-death-*` as one bounded, provenance-tagged timeline, with a trust verdict for a client-published `x-death`. Pure: no clock, no I/O, no broker version, no payload (the body is not an input). Working spec: [docs/specs/M1-04.md](../../../docs/specs/M1-04.md).

Tags: `type:pure`, `runtime:isomorphic`.

## Public API

- `normalizeDeaths(message, context)` returns a `DeathHistory`: `entries` newest first in epoch milliseconds (queue, reason, count, exchange, routing keys, first and last time, original TTL, per-record flags), `first` and `last` (the broker's `x-first/last-death-*`), `totalDeaths`, `counters` (`x-delivery-count`, `x-acquired-count`, the 1.0 `delivery-count`, each with the header it came from), `trust` and `trusted`, `flags`, `truncation` (what was cut, counted) and `provenance` (the headers that were read).
- `readDeathEntries(message)`: the records alone.
- `deathContext(capability, profile)` builds the context from the registry (`clientDeathHeaderInterpreted`, I-3); `INTERPRETED_CAPABILITY` is its id. A lookup that throws gives `null`, which fails closed.
- `REPLAY_STAMPS`, `REPUBLISH_MARKERS`: the fixed header names read as evidence of a client copy (names only, never values). `LIMITS`, `DEATH_REASONS` and the types.

The input is `{ protocol: 'amqp091', headers }` or `{ protocol: 'amqp10', messageAnnotations, applicationProperties?, header? }`, plus `clientPublished` when the caller knows. Values may be plain (amqplib), the engine's typed `{ t, v }` form (`Delivery.headers`) or a `Map`.

## Invariants

- Never throws, whatever the input (getters, proxies, cycles, 2^32-long sparse arrays); a read that fails is counted and flagged `read-error`.
- A field that is missing or unusable is `null` with a flag, never guessed, defaulted or taken from another field. The one exact derivation: a 0-9-1 record that died once has a last death equal to its first. `time` of 0-9-1 is the first death in seconds; the broker order is kept (it is by last death); 1.0 is sorted newest first by `last-time` and `reordered` says so.
- Bounded (I-6) and counted (I-13): at most 128 records, 32 routing keys per record, 512 characters per text and 65,536 characters in total; `truncation` and the `truncated` flag say what was cut.
- Trust is evidence-based. Registry says the broker interprets a client `x-death` (up to 3.13): `interpreted`, trusted. Otherwise (4.0+) a hint, a replay stamp, a republishing framework's header or a missing `x-first-death-*` make it `client-supplied`; first/last that disagree with the records make it `inconsistent`; a consistent record with no sign of a copy is `broker-shaped` and trusted, with the reason `provenance-unproven` (OQ-1043). An unknown context is `unknown-broker`, untrusted.
- No broker-version comparison here (I-3); the only broker-version fact is the registry capability.
- Nothing in the output comes from a header outside the death, first/last, counter and marker names, and nothing from the body.
- Dependencies follow the `type:pure` row of blueprint 2.2 (type-only import of `@app/semantics`); `pnpm nx lint deaths` enforces them.

## Not proved

The shapes are the documented ones (DLX docs, release notes 4.0.1, broker source); no broker recorded a real message yet. See OQ-1042 for the lab recordings needed (CF-DEATH-01..04).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p deaths semantics
pnpm nx test deaths --testNamePattern='AC-(1|2|3|4|5|6|7|8|9|10|11|12)'
```
