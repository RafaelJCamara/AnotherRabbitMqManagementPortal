# broker-lab

Reproducible RabbitMQ broker images for 3.13.7, 4.0.9, 4.1.8, 4.2.9 and 4.3.6, with the plugins and ports the conformance matrix needs, TLS and OAuth variants, and a 3-node cluster behind HAProxy with Toxiproxy (M0-14, ADR-025).

Tags: `type:test`, `runtime:node`. Linux and Docker only for the broker itself; the unit tests run anywhere.

## What is here

| File                                      | Purpose                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `versions.json`                           | The supported versions, each with the digest of the official `rabbitmq:<version>-management` image. The single source of truth for the Dockerfile arguments and the evidence. |
| `Dockerfile`                              | `ARG VERSION`, `ARG DIGEST`; `FROM rabbitmq:${VERSION}-management@${DIGEST}`; adds `enabled_plugins` and `rabbitmq.conf`.                                                    |
| `enabled_plugins`                         | management, prometheus, stream (+management), tracing, shovel (+management), federation (+management), consistent-hash exchange, event exchange, oauth2 backend.             |
| `rabbitmq.conf`                           | Listeners 5672, 15672, 5552 and 15692, `guest` allowed from outside the container, small-disk alarm limit. One file for every version.                                       |
| `tls/rabbitmq.tls.conf`                   | The TLS variant: 5671, 15671 and 5551. No key material is committed; a throwaway certificate is generated for every run.                                                    |
| `oauth/rabbitmq.oauth.conf`               | The OAuth variant: oauth2 backend with a lab signing key (generated per run), internal backend as the fallback.                                                              |
| `compose.3node.yaml`, `rabbitmq.cluster.conf`, `haproxy.cfg`, `toxiproxy.json` | Three nodes (classic peer list), HAProxy for 5672, 15672 and 15692, Toxiproxy in front of HAProxy (amqp 25672, management 25673, API 8474). |

Ports are published on the loopback interface only, on random host ports. The exception is the stream port, which must be the one the broker advertises, so the helper picks a free host port first and advertises exactly that.

## Targets

```sh
pnpm nx run broker-lab:build                         # static: validates versions.json, writes dist/testing/broker-lab/images.json (no Docker)
pnpm nx run broker-lab:images                        # docker build, all versions (or --versions=4.3.6)
pnpm nx run broker-lab:verify --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6
pnpm nx run broker-lab:verify --versions=4.3.6 --variants=plain,tls,oauth --nodes=1,3
pnpm nx run broker-lab:test                          # artefact checks (Dockerfile, plugins, compose), no Docker
```

`verify` starts each broker with `startBroker`, then checks that 5672 answers an AMQP 0-9-1 handshake, 5552 answers a stream `PeerProperties`, 15672 and 15692 answer over HTTP, `/api/overview` reports `rabbitmq_version` equal to the tag, `/api/extensions` lists shovel, federation, stream and tracing, the `x-consistent-hash` exchange type is offered and `amq.rabbitmq.event` exists. With `--variants` it also checks TLS (5671 and 15671) and, with `--nodes=3`, that three nodes run behind HAProxy and Toxiproxy answers. It exits non-zero on any failed check. It needs a running Docker daemon.

## Use from a test

```ts
import { startBroker } from '@app/testkit';

const broker = await startBroker({ version: '4.3.6', variant: 'plain', nodes: 1 });
// broker.amqp, broker.http, broker.stream, broker.prometheus, broker.digest, broker.credentials
await broker.stop();
```

`digest` is the pinned base image digest. Lab evidence (amendment A-20) records it.

## Invariants

- Every base image is pinned by digest (`versions.json`, the Dockerfile default, the compose images); there is no floating tag.
- Nothing listens beyond the loopback interface.
- No key material is committed. Lab certificates and keys live in a temporary folder and are removed by `stop()`.
- This project never writes `testing/lab-evidence/**` (human-only, I-14).

## Not in this work item

Alpha images (4.4, 5.0, 4.3.7), the Keycloak variant, and the conformance CI workflows are tracked in [docs/open-questions.md](../../docs/open-questions.md) (OQ-80 to OQ-88) and the work items that own them (M0-42). The lab driver and the evidence recorder (M0-15) live in [apps/conformance](../../apps/conformance/README.md); it reaches only brokers this lab created.
