---
name: new-ui-feature
description: Scaffold a new Angular feature library (lazy route, Transloco scope, gallery entry, Playwright spec with axe) with the ui-feature generator. Use when adding a screen or feature area to the web UI.
argument-hint: "<name> --route='/c/:cid/<seg>'"
---

# /new-ui-feature

A feature is a lazy-loaded `type:ui-feature` library. It never imports another feature, never computes authorisation, and talks to the engine only through `EngineApi` and the live client. Read `.claude/rules/ui.md` before you start.

## Availability

The `ui-feature` generator ships with **M0-08** (issue #8, "Base Nx generators"). The UI platform, data and design libraries it builds on arrive with the UI work packages (M0-W3). Check first:

```sh
pnpm nx g @app/generators:ui-feature --help
```

If the command is unknown on your base, stop and say so in the PR.

## Documented command form (execution plan 2.5)

```sh
pnpm nx g @app/generators:ui-feature <name> --route='/c/:cid/<seg>'
```

It creates the lazy route, the Transloco scope, a dev-gallery entry and a Playwright spec with axe.

## Steps

1. Confirm the spec names the route segment, the engine actions and live topics it uses, and the gates it must render.
2. Run the generator once. Verify the tags (`type:ui-feature`, `runtime:browser`) and that the feature is reachable only through the lazy route.
3. Build with signals, zoneless, `OnPush`. Render `gates` and `allowedActions` from the engine through `<app-gated>`; show the "why disabled" reason.
4. Add every string as a Transloco key (no raw template text). Honest wording applies: "side-effect-aware peek", never "non-destructive" for queue reads.
5. Bound everything: engine windows for lists, rings and rAF-throttled snapshots for high-frequency data (I-7).
6. Add the gallery states (empty, loading, error, gated) and make axe clean on the route.
7. Check budgets: feature chunk <= 200 kB gzip.
8. Verify: `pnpm nx run-many -t lint typecheck test -p <feature-project>`, then `pnpm nx affected -t lint typecheck test build`; once the e2e project exists, `pnpm nx e2e e2e-web`.
