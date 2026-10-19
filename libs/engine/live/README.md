# live

The engine live hub (M0-33, ADR-005, blueprint 3.5): one credit-based session per UI, with the same semantics on the WebSocket (`@app/transport`, `ws/upgrade.ts`) and on the MessagePort (M0-34). The pure state machines (credits, outboxes, gap, resume) are `@app/live-protocol`; this library adds what needs time and I/O: sessions that outlive a transport, the 30 s resume window, topic sources, timers and the single-use ticket store.

Tags: `type:kernel`, `runtime:node`. Imports `@app/contracts`, `@app/kernel`, `@app/live-protocol` and `@app/ports`. It does not know what carries its bytes.

## Public API

| Export                                                                | Notes                                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LiveHub`, `LiveHubOptions`, `LiveHubStats`                           | `attach(transport, principal)` returns a `LiveLink` (`receive(text)`, `closed()`), or undefined after closing the transport when the hub is full. `drain(ms?)` sends `goaway` and closes; `close()` stops every source.        |
| `LiveTransport`, `LiveLink`                                           | The carrier's side: `send(text)`, `close(code, reason)`, `bufferedAmount`. A `ws` socket already fits.                                                                                                                    |
| `createTopicRegistry()`, `TopicRegistry`, `TopicSource`, `TopicSink`  | A service registers `defineTopic(...)` with a source: `snapshot(params, principal)` and `subscribe(params, principal, sink)`. The sink offers items (`publish`, `remove`) and ends the topic (`end`).                      |
| `createTicketStore`, `TicketStore`, `TICKET_TTL_MS`, `MAX_TICKETS`    | Tickets for the WebSocket handshake: 256 random bits, single use, 30 s, bound to the principal that asked, at most 1024 outstanding (OQ-331).                                                                              |
| `DEFAULT_MAX_CONNECTIONS`, `DEFAULT_MAX_CLIENT_FRAME_BYTES`           | 64 connections and 64 KiB per client frame (OQ-334).                                                                                                                                                                      |

`LiveHubOptions` takes `engineVersion`, `topics`, `canSubscribe(principal, permission)` (OQ-330) and optionally a `Clock`, `Timers`, `IdGenerator`, the session `limits`, `maxConnections`, `maxParked`, `resumeWindowMs`, `maxClientFrameBytes` and `validateItems`.

## How a connection runs

1. The carrier authenticates the caller, calls `hub.attach(transport, principal)` and forwards each text frame to `link.receive` and the transport's close to `link.closed`.
2. The first frame must be `hello`. A `hello{resume}` for a parked session of the same principal continues that session (lossless topics from their `lastSeq`, the rest from a snapshot, credits at zero); anything else starts a new one and `welcome` carries its id and the limits.
3. A `sub` is validated against the topic (known, `canSubscribe`, params), accepted by the session (64 per session, credits) and only then is the source started. Items go to the session's outbox, which is bounded by items and bytes.
4. After any frame and after any burst of publications (one microtask later) the session is drained: frames go out as far as credits and `maxHz` allow, and a timer is armed for the next paced slot.
5. When the transport closes the session is parked for 30 s with its sources running, so the outboxes keep what the client misses. When the window ends, or the registry of parked sessions is full, the session is dropped and its sources stop.

A client that breaks the protocol (bad JSON, a frame the schema refuses, a frame before `hello`, a duplicate `sid`, a frame over 64 KiB) is closed with 1008 or 1009 and its session is dropped. A client that does not read (more than `outboxBytes` of unread output) is closed with 1013 and its session is parked.

## Invariants

- **I-6.** Every buffer is bounded: connections, parked sessions, tickets, each outbox (items and bytes), the session total (`outboxBytes`), the bytes a peer may leave unread, and client frames.
- **I-13.** Loss is announced: a client that stops granting credit makes a lossless outbox overflow into `gap` then `snapshot`; a source that ends while its session is parked delivers its `end` frame after the resume `welcome`.
- **Principal binding.** A session is resumed only by the principal that opened it; a ticket opens a socket only for the principal that asked for it.
- No broker I/O, no sockets and no third-party library: the carrier owns the transport.
- Dependencies follow the type:kernel row of blueprint 2.2; `pnpm nx lint live` enforces them.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p live
pnpm nx run transport:it --testNamePattern=live   # the same hub behind a real WebSocket
```

Open questions: OQ-330 to OQ-339 in [docs/open-questions.md](../../../docs/open-questions.md).
