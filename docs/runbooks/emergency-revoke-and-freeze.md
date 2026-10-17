# Runbook: emergency revoke and maintenance freeze (team server, M5)

**Emergency revoke (ADR-020).** An admin action that revokes every lease the tool holds on a broker, across all users. It:
- stops taps;
- switches the firehose off;
- flushes peeks (nack + qos barrier);
- parks or drains replays.

Use it when the tool itself may be harming a broker.

**Maintenance freeze.** Makes a broker read-only in the tool and pauses pollers. Use it during broker upgrades or incidents.

Both actions are audited and need an admin role. Afterwards, check the broker's connection list to confirm the tool's connections are gone.
