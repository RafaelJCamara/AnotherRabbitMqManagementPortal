# Runbook: new RabbitMQ release (14-day SLA)

- **Trigger:** a new RabbitMQ minor or patch release (or a new Tanzu or managed-provider version) is announced.
- **Owner:** semantics code owners. Each release is tracked as its own issue.

1. Read the release notes. Diff these files against the previous tag:
   - `deps/rabbit/src/rabbit_fifo*.erl`
   - `rabbit_channel.erl`
   - `rabbit_amqp_session.erl`
   - the management dispatcher
   - the deprecated-feature lists
2. Add the version to the broker lab as a digest-pinned image and run the conformance matrix. Evidence is recorded **only by CI** (amendment A-20).
3. Draft or update semantics-registry cells (era rules, counters, hazards, capabilities). Flipping a cell's status needs recorded evidence and code-owner sign-off.
4. Update the `resolveEra` rules if new feature flags or quorum-queue machine versions appear (for example `rabbitmq_4.4.0`, machine version ≥ 9).
5. Until the new version is verified, it runs in "unverified-minor" mode: conservative caps, extra consents, MCP mutations off.
6. Within 14 days, publish the updated compatibility matrix and docs. Promote the version to Tier 1 once it is green.
