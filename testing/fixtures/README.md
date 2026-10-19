# Golden fixtures

Real answers of real brokers, recorded once and replayed in tests (M0-25, U-13). They are what the management client (`libs/engine/adapter-mgmt-http`) and, later, the Prometheus adapter are proved against, so a field a broker really sends (or leaves out) is a fact in the repository, not an assumption in a schema.

They are **not lab evidence** (I-14): they do not flip a semantics cell and nobody signs them off as evidence. `testing/lab-evidence/**` is never written from here.

## What is recorded

| Directory                                  | Content                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `mgmt/<version>/<mode>/`                   | One file per endpoint of the adapter catalogue, per error probe, and a `manifest.json`.         |
| `prometheus/<version>/<mode>/`             | The Prometheus pages (`/metrics`, `/metrics/detailed?family=...`) and a `manifest.json`.        |
| `seed.json`                                | The topology every recording starts from: vhost, users, exchanges, queues, bindings, policies, messages, one consumer. |

`<version>` is `3.13.7`, `4.0.9`, `4.1.8`, `4.2.9`, `4.3.6` (the broker-lab images, pinned by digest) and `lavinmq-2.10.2` (pinned by digest in `libs/testkit/src/golden/record.ts`). `<mode>` is `stats-on` and `stats-off` for RabbitMQ (`management.disable_stats = true` and `management_agent.disable_metrics_collector = true`), `default` for LavinMQ, which has no statistics switch.

The manifest names the product, the version the broker itself reported, the image and its digest, the statistics mode, the broker configuration added to the lab defaults, the seed (id, SHA-256 of `seed.json`, optional steps the broker refused) and, for every file, the request the client sends (`sent`), who asked (`auth`), the status and whether the answer is the paged envelope. A request is the one the adapter produces for that broker profile (`shapeRequest`), so replaying the manifest through the client asks the broker's question again.

Each answer is stored as the broker sent it, pretty-printed (JSON number spellings such as `0.0` become `0`), in `.json`; text that is not JSON (a plain `404 Not Found`, an empty `401`) is kept as `.txt`, a Prometheus page as `.prom`.

## Recording

```sh
pnpm nx run adapter-mgmt-http:record-golden                          # every version and mode, writes the fixtures
pnpm nx run adapter-mgmt-http:record-golden --versions=4.3.6 --check # compare with the committed fixtures, write nothing
pnpm nx run adapter-mgmt-http:record-golden --versions=lavinmq --modes=default
pnpm nx run adapter-mgmt-http:test-golden                            # replay the committed fixtures; no Docker
```

Recording needs a Docker daemon (the lab images are built from `testing/broker-lab`; LavinMQ is pulled by digest) and takes about a minute per version and mode. Each recording starts a fresh broker, runs `seed.json`, waits until the statistics show the seeded consumer and counts, asks the plan (`libs/testkit/src/golden/plan.ts`) and stops the broker.

`--check` compares **shapes**, not values: which fields exist and their types, the status of every request, the Prometheus families and label names. Uptimes, counters, ports and timestamps differ on every run and are not a difference. The nightly workflow (`.github/workflows/golden-refresh.yml`) runs the check and, on a difference, records again and opens a pull request with the new files.

Changing `seed.json`, a plan entry or a pinned digest changes fixtures: re-record and review the diff.

## Scrubbing

Nothing is hand-edited. The recorder runs every answer through `libs/testkit/src/golden/scrub.ts` before it is written:

- the container id, hostname and container name become `lab-node` / `lab-container` (a node is `rabbit@lab-node`);
- IPv4 and full-form IPv6 addresses (other than loopback and `0.0.0.0`) become documentation-range addresses, in order of first appearance;
- the value of a key that names a secret (`password_hash`, `token`, `secret`, `cookie`, `salt`, ...) becomes `<scrubbed>`;
- JWTs, `Bearer`/`Basic` values, credentials in a URL, PEM blocks and the canary secret become `<scrubbed>`;
- the home directory of a user becomes `/home/user`.

The recorder plants a **canary secret** (`canary-secret-golden-...`) as the password of the seeded users and as the wrong password of the error probes, then refuses to write a file in which a canary, a secret-shaped string or a host name survives. `adapter-mgmt-http:test-golden` scans every committed file again.

## Adding an endpoint

A new endpoint in the adapter catalogue has no fixture until it has a line in `plan.ts` (`plan.spec.ts` and `test-golden` fail until it does). Add the line, re-record, and review.
