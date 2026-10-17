# ADR-030: Web-first delivery order

- **Status:** Accepted
- **Date:** 2026-10-16
- **Decided by:** maintainer

## Decision
Deliver in this order:
1. **Single-user Docker web app**: M0 foundations, M1 "Web 1.0".
2. **Windows desktop** (M2).
3. **Linux desktop** (M3).
4. **macOS desktop** (M4).
5. **Free team server** (M5).
6. Then ops intelligence (M6), governed AI/MCP (M7) and platform scale (M8).

Each desktop milestone runs a platform lane (shell, packaging, signing, OS integration) in parallel with a feature lane.

## Rationale
- One Docker artefact runs everywhere Docker runs, needs no signing or OS approvals, and gives the fastest feedback. It is also the base of the later team server.
- Windows has the largest desktop share.
- Shipping macOS last defers the Apple Developer cost.

## Consequences
- **Desktop is deferred, not designed out.** The MessagePort transport (ADR-002), the EngineTransport/PlatformBridge abstractions and the engine mode files exist from M0, with a fake-port transport test. Desktop spikes run at the end of M1.
- **The first release is single-user:** a loopback-only container with token login, and an SSH tunnel for remote use (ADR-016, amendment A-12).
- **Supersedes** the design-phase sequence (all shells in M0, team server in M3).
