# svc-topology

Reads one vhost of a connected broker and answers the topology, routing-simulation, dead-letter and effective-config queries (reads only). It is the engine face of two pure libraries, `@app/routing` and `@app/effective-config`: it reads the broker, resolves what each queue and exchange really has, hands the libraries plain data, and returns their answers as explicit contracts. Spec: [docs/specs/M1-20.md](../../../docs/specs/M1-20.md).

Tags: `type:service`, `runtime:node`.

## Actions

All are `kind: 'query'`, permission `broker.read`, risk and planning `none`, no audit row, `POST` with the vhost in the body, MCP read tools.

| Action | Route | Answers |
| --- | --- | --- |
| `topology.graph` | `/connections/{cid}/topology/graphs` | the vhost as nodes and edges, at most 2,000 elements, aggregated (and saying so) past that |
| `topology.subgraph` | `/connections/{cid}/topology/subgraphs` | the neighbourhood of one exchange or queue, depth 0 to 2, same cap |
| `routing.simulate` | `/connections/{cid}/routing/simulations` | which queues a publish reaches and by which path; the alternate-exchange path or "unroutable" |
| `routing.dead-letter` | `/connections/{cid}/routing/dead-letter-paths` | where a message goes when it dies in a queue, and the dead-letter loops that include it |
| `routing.dlx-sources` | `/connections/{cid}/routing/dlx-sources` | every queue that can dead-letter into a queue, with `complete` and `unknownReasons` (A-2) |
| `queues.effective-config` | `/connections/{cid}/effective-config/queries` | per key, the value a queue really has, the rule, and the provenance of every input |

## Public API

- `createTopologyModule(deps)`: returns the module the composition root registers (`id`, `actions`, `stop()`).
- `TopologyModuleDeps` (`src/deps.ts`): `mgmt` (the BrokerScheduler's read wrapper), `profiles`, `connections`, and optional `clock`, `limits`, `yieldNow`. There is no write port and no adapter.
- `DEFAULT_TOPOLOGY_LIMITS`, `TopologyLimits`: the bounds of a snapshot (below).
- `createTopologyFakeDeps()` (`src/testing.ts`): a scripted management API over a plain description of vhosts, a probed profile and the connection store, for specs, the architecture manifest and the HTTP specs.

## How an answer is made

1. `internal/snapshot.ts` reads the vhost once (queues, exchanges, bindings, policies, operator policies, consumers) in the `interactive` lane and keeps it 15 s in a bounded map. Queues, exchanges and bindings fail the read closed; a policy list the principal may not read (403, 404, 405) is a gap, not an error.
2. `internal/settings.ts` resolves, per queue, the dead-letter exchange, limits and delivery limit: argument over policy through the effective-config resolver, the delivery limit from the queue stat. A policy layer that cannot be decided gives `unknown`, never a default.
3. `internal/to-routing.ts` builds the `RoutingTopology` in turns of the event loop and collects the gaps. `internal/graph.ts` builds the graph (pure, also in turns).
4. The action calls the library and `internal/routing-view.ts` maps the result into the contract, field by field.

## Invariants

- Reads only (I-2): every action is a query on `broker.read`; the module is handed a `MgmtReadPort` and nothing that can write. The optional verification publish of the issue is a mutation and is not here (OQ-1403).
- No broker version is compared here (I-3): the version goes to the resolver as data (`profile.versions.min`).
- Bounded (I-6, I-7): the bounds of a snapshot are `DEFAULT_TOPOLOGY_LIMITS` (50,000 queues, 10,000 exchanges, 200,000 bindings, 100,000 consumers, 1,000 policies, pages of 500, 8 snapshots); every list in an answer has a maximum in its contract.
- No silent loss (I-13): every cut is a count next to the list it cut, and a snapshot that was read in part says `truncated` in `gaps`.
- An empty `sources` is "no hazard" only when `complete` is true; the action returns the pair as the library does and adds no verdict of its own.
- An answer built with any gap (`policy-unreadable`, `operator-policy-unreadable`, `stats-fields-missing`, `other-clients-may-declare`, `policy-match-undecided`, `truncated`) is not exact, and a publish is not called unroutable.
- Errors are Problems; a private connection of someone else, a missing profile, vhost, queue or focus are `NOT_FOUND`; the text of an answer is never the broker's.

## What is proved, and what is not

Proved here: the shapes, the gap rules, the bounds and the graph, against the pure libraries and a scripted management API (`pnpm nx test svc-topology`, `pnpm nx test testkit`). Not proved: what a real broker lists. In particular the stat fields (`policy`, `operator_policy`, `delivery_limit`) per version and provider, the exchange alternate-exchange rule, and the `columns` parameter of the queue list are working defaults to be shown by the lab (M1-05, M1-18; OQ-1405, OQ-1408, OQ-1410, OQ-1418). `routing.simulate`, `routing.dead-letter` and `routing.dlx-sources` run the pure library on the event loop: about 6 ms, 30 ms and 26 ms for 20,000 queues on a development machine (measured, not a gate; the loop-delay gate of I-5 is planned, OQ-1420). The graph yields to the event loop and its longest slice was about 3 ms.

## Proof commands

```sh
pnpm nx test svc-topology
pnpm nx run-many -t lint typecheck test -p svc-topology,contracts,testkit,arch-tests,routing,effective-config,engine
pnpm nx run contracts:api-docs-check
```
