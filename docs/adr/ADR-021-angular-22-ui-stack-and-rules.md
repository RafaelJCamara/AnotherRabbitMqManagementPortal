# ADR-021: Angular 22 UI stack and rules

- **Status:** Accepted
- **Date:** 2026-10-16
- **Source:** design panel (final blueprint); see [docs/architecture/blueprint.md](../architecture/blueprint.md)

## Decision

The UI is zoneless and OnPush, with signals and SignalStore 22.0.1. Components come from Spartan brain 1.7.0 helm copies, Aria, CDK and Tailwind 4. Other pieces:
- grids: AG Grid Community 36.2 behind an adapter, using the engine-windowed infinite model;
- graphs: Cytoscape with an unmodified ELK worker asset;
- editor: our own Monaco ESM wrapper;
- charts: uPlot and ECharts;
- commands: a tinykeys registry that also drives native menus.
The UI never computes authorisation, innerHTML is banned, rings live outside the signal graph, and a dev gallery replaces Storybook. The engine retains N-1 hashed chunks, and the UI does a controlled reload on ChunkLoadError.

## Rationale

Required by DC-50 to DC-52. The engine-computed gates keep UI logic out of the trust boundary, and skew handling prevents ChunkLoadError loops.

## Alternatives considered

PrimeNG (proprietary since 22); Angular Material; ngx-monaco-editor-v2 (AMD); an engine-link worker from day one.

## Consequences

We own the grid context menu, clipboard and status bar, plus the helm copies.
