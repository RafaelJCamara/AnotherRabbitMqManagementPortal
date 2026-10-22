# adapter-prometheus

The Prometheus text exposition of a broker node behind `PromScrapePort` (`@app/ports`): an HTTP client over Dialer sockets and a bounded, cooperative parser (MON-01, DC-33).

Tags: `type:adapter`, `runtime:node`.

## Public API

- `createPromScrapeClient({ dialer, targets, requestTimeoutMs? })` returns `{ scrape, close }`. `scrape` is a `PromScrapePort`: one GET of `request.path` with `request.query` (a list value repeats its key, so `family=a&family=b` is expressible), the body as chunks. `close()` aborts every scrape in flight and refuses new ones.
- `PromTargetResolver.resolve({ connectionId, node, endpoint? }, signal)` is how the composition root hands over one listener: host, port, TLS trust, route and a `PromAuth` (`none`, `basic`, `bearer`). The client keeps none of it. `endpoint` is a URL of the BrokerProfile's `prometheus.endpoints`; the resolver refuses a URL the profile does not list (OQ-867).
- `parseExposition(chunks, sink, options?)` reads an exposition body with bounded memory and calls `sink(sample)` for each wanted sample; it resolves with `ParseSummary` (bytes, lines, samples, skipped, malformed, oversized lines, truncation, yields). `options`: `wanted(name)` (a family nobody wants is dropped before its labels are read), `onType`, `maxLineBytes` (64 KiB), `maxBodyBytes` (256 MiB), `maxSamples` (1,000,000), `maxLabels` (64), `yieldEveryBytes` (256 KiB), `yieldEveryLines` (5,000), `yieldNow`, `signal`.
- `PromScrapeError` carries a contract `code`, a `reason`, a safe `detail` and, when the endpoint answered, `broker: { protocol: 'http', code: <status> }`. Mapping it to a Problem is the caller's job (`apps/engine/src/broker/prom.ts`).
- `targetOf(path, query)`, `DIAL_PURPOSE` (`prom-scrape`, registered `active` in `@app/net-dialer`).

## Invariants

- Imports only contracts, pure, port and `net-*` projects (blueprint 2.2); never a service or another adapter.
- Every socket comes from the Dialer (I-9): the agent's `createConnection` calls `Dialer.dial` with the `prom-scrape` purpose, so the egress policy and the TrustStore apply, redirects are refused and an `https` origin is verified before the first byte. `node:net` and `node:tls` are not imported at run time.
- The adapter does not schedule, cache or retry. The BrokerScheduler's `schedulePromScrape` is the only caller (I-8). One request per socket: no pool to invalidate.
- Bounded (I-6): the parser holds the current chunk and one unfinished line (at most `maxLineBytes`); an over-long line is skipped and counted, a body past `maxBodyBytes` fails, a sample count past `maxSamples` ends the read and says so. Nothing keeps the list of samples; the sink does.
- Cooperative (I-5): the parser awaits `yieldNow` (`setImmediate`) every 64 KiB of text and every 2,000 lines, also inside one very large chunk, and reports the most it read between two turns. There is no worker thread (OQ-863).
- No input in an error (I-10): the endpoint's body is never put in an error, credentials exist for one request as the `Authorization` header only, and no URL or header reaches `detail`. Credentials go only to endpoints the resolver decides to log in to (OQ-864).
- Versions and providers are never compared here (I-3): the planner in `svc-metrics` reads the BrokerProfile.

## Golden pages

`src/golden.spec.ts` parses every page of `testing/fixtures/prometheus` (the five lab RabbitMQ versions with statistics on and off, and LavinMQ): each parses to exactly its sample lines with nothing malformed, in one chunk and in 1,000-byte pieces, and the families the engine keeps are present under the product prefix. The fixtures are real broker output, not lab evidence (I-14).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p adapter-prometheus
pnpm nx run net-dialer:outbound-calls-check     # the generated outbound-calls page follows the purpose registry
```
