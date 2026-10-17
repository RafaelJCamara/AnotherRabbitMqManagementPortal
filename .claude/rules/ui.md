---
paths:
  - 'libs/ui/**'
  - 'apps/web/**'
---

# UI rules

Applies to the Angular UI. Source: blueprint section 10 and ADR-021.

- **Angular 22.2 shell:** standalone components, zoneless, `ChangeDetectionStrategy.OnPush`, signals (`linkedSignal` for local derived state). Routes are lazy; a feature never imports another feature (`type:ui-feature` constraint).
- **Talk to the engine only through `EngineApi`, `engineResource` and the `LiveClient`.** No direct `fetch`, `XMLHttpRequest`, `WebSocket` or `EventSource` outside `libs/ui/platform` (`@app/no-direct-fetch`). Never import protocol libraries (I-1).
- **The UI never computes authorisation.** Render the `gates` (with their "why disabled" reason and source) and `allowedActions` the engine sends. Use `<app-gated>` for gated controls.
- **Never materialise an unbounded collection (I-7).** Use engine windows and the grid's infinite model; high-frequency data (tap, tail) lives in rings outside the signal graph, exposed through rAF-throttled snapshot signals.
- **No `innerHTML`**, no `bypassSecurityTrust*`, payloads are rendered as text only (`@app/no-inner-html`).
- **i18n keys only.** No raw text in templates (`@app/ui-no-raw-template-text`); strings live in Transloco scopes. Honest wording applies to every locale: never "non-destructive" or "read-only" for queue reads outside the allow-listed keys (`@app/honest-wording`).
- **Accessibility.** Use `@angular/aria` and CDK patterns; every graph has an accessible table alternative; axe must be clean on every route you touch (Playwright spec with axe per feature).
- **Design system.** Tokens are CSS variables in `ui-design`; support light, dark and high-contrast themes and the compact density. Do not add a component library.
- **Third-party UI libraries** (AG Grid, Cytoscape, Monaco, uPlot, ECharts) are imported only by their owning library (`ui-grid`, `ui-graph`, `ui-editor`, `ui-charts`).
- **Bundle budgets are CI-enforced:** initial <= 350 kB gzip (error at 450), feature chunk <= 200 kB, Monaco <= 1.1 MB on demand, ECharts <= 250 kB.
- Scaffold features with `/new-ui-feature` (lazy route, Transloco scope, gallery entry, Playwright spec with axe). The dev-only gallery route replaces Storybook.
