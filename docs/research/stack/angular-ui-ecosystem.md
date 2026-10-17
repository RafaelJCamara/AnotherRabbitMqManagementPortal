# Angular UI ecosystem

> **Pre-verification research (2026-10-16).** Where this conflicts with [`docs/research/fact-sheet.md`](../fact-sheet.md), the fact sheet wins. Content about a specific third-party product was removed under the docs policy ([ADR-034](../../adr/ADR-034-docs-policy.md)).

_Stack research `angular-ui-ecosystem` · 2026-10-16_

## Executive summary

On 16 Oct 2026 Angular is at v22.2.3. v22 shipped on 3 Jun 2026, is in active support until Jun 2027 and in LTS until Jun 2028. Angular has also switched to one major release every 12 months, so Angular 23 is due around June 2027. That gives a greenfield codebase written mostly by agents a long, stable target.

The features an IDE-style UI with live data needs are now stable or the default:
- zoneless change detection (default since v21) and OnPush (default in v22)
- Signal Forms, plus resource()/httpResource(); resource({stream}) handles WebSocket and SSE feeds
- @angular/aria, a first-party set of unstyled accessible patterns: tree, grid, listbox, menu/menubar, tabs, toolbar, combobox
- the esbuild + Vite builder (@angular/build), with Webpack deprecated, and Vitest as the default test runner

One hard constraint: Angular 22 only supports TypeScript 6.0, even though TypeScript 7 shipped in July 2026.

The biggest ecosystem surprise is licensing. From v22 (Jul 2026), PrimeNG is no longer MIT. It now uses the PrimeUI licence, which requires licence keys, has no open-source programme and limits redistribution, so PrimeNG must be avoided. Clarity Core is also unsupported.

Recommended stack:
- **Design system:** built in the repo from Spartan/ui 1.x (MIT, components copied into the repo, Tailwind v4) on top of the Angular CDK and @angular/aria.
- **Large grids:** AG Grid Community 36 (MIT) behind an internal adapter, with Enterprise modules banned. TanStack Table v9 for small tables and as the swap-in fallback.
- **Topology:** Cytoscape.js with ELK layouts run in a worker for 1-5k-node overviews; Foblex Flow for small interactive routing diagrams.
- **Editor:** Monaco loaded directly as ESM in a lazy chunk with our own wrapper. Not the AMD-based ngx-monaco-editor-v2.
- **Charts:** uPlot for live rates; ECharts 6 for dashboards and history.
- **Other building blocks:** NgRx SignalStore 22, Transloco, @lucide/angular icons and xterm.js 6. Shortcuts come from a VS Code-style command/keybinding registry with a Spartan command palette.

In Electron 44, serve the UI from a privileged app:// protocol rather than file://, keep context isolation and the sandbox on, and expose a tiny typed preload bridge. The UI reaches the engine through a transport abstraction: WebSocket in browser and team-server modes, a MessagePort to an Electron utilityProcess on desktop. That way one Angular build serves all three delivery modes.

## Recommendations

### Angular version and core platform features

**Recommendation.** Start on Angular 22.x (currently 22.2.3): standalone components, zoneless (the default), OnPush (default in v22) and signals throughout. Use Signal Forms for all new forms. Use resource/httpResource for reads and resource({stream}) for WebSocket/SSE feeds. Load heavy panels with @defer. Ship client-side rendering only, no SSR. Pin TypeScript 6.0.x and Node 24 LTS across the monorepo. Plan the v23 upgrade for about June 2027.

**Why.** Under the new 12-month cadence, v22 is active until 2027-06 and in LTS until 2028-06, which is the longest stable window Angular has offered. Everything a live-data IDE UI needs (zoneless, Signal Forms, resources, @angular/aria) is stable in v22. The esbuild/Vite application builder is the only non-deprecated build path.

**Alternatives.** Angular 21 (LTS until 2027-06): no reason to pick it for greenfield. Keeping zone.js: unnecessary, since new apps default to zoneless. Using the 22.2 developer-preview features (@boundary, router resources) in core flows: premature.

**Risks.** Angular 22 cannot use TypeScript 7 (peer range >=6.0 <6.1). Third-party libraries that hook NgZone.onStable or onMicrotaskEmpty can break under zoneless. OnPush by default exposes code that mutates state without notifying change detection.

### State management

**Recommendation.** Use signals, computed and linkedSignal for component-local state. Use NgRx SignalStore (@ngrx/signals 22) for shared feature stores: connection catalog, workspace/tabs, live metrics. Use withEntities for large collections, the events plugin for cross-feature workflows, and the new resource extensions. Keep RxJS 7.8 for stream plumbing (socket, then buffer/throttle, then signals). Do not adopt classic @ngrx/store.

**Why.** SignalStore is signal-native and lightweight, and its conventions are easy for AI agents to follow and test. The events plugin has been stable since v21 (Dec 2025). v22 (2026-08-24) added resource extensions and dynamic deep signals.

**Alternatives.** Plain signal services only: fine, but less uniform across features. Classic NgRx Store: Redux-style boilerplate. TanStack Angular Query: still published as angular-query-experimental 5.104, with the stable package only at RC.

**Risks.** Pushing high-frequency streams such as tapped messages through stores can cause excessive recomputation, so keep ring buffers outside the signal graph. NgRx is community-maintained and sponsor-funded.

### Build and test toolchain

**Recommendation.** Use the Angular CLI application builder (@angular/build: esbuild with a Vite 8 dev server). Use Vitest 5, the CLI default, in jsdom for logic. Use Vitest browser mode with the Playwright provider for components that depend on layout, virtualisation or canvas. Use CDK and @angular/aria component harnesses. Use Storybook 10 with @storybook/angular-vite as the design-system workbench. Use Playwright 1.64 for web end-to-end tests, plus its experimental _electron API for desktop smoke tests.

**Why.** These are first-party defaults, need no Webpack, and have the most material for AI agents to learn from. Harnesses and Storybook give each component a testable contract.

**Alternatives.** Karma/Jasmine: still supported but legacy. The classic @storybook/angular: still peer-depends on the deprecated @angular-devkit/build-angular. Analog's Vitest plugin: unnecessary now that the CLI has native Vitest.

**Risks.** Playwright's Electron automation is experimental. The builder does not type-check web-worker code and does not process nested workers.

### Component library and design system (incl. density, dark mode, accessibility)

**Recommendation.** Build an in-repo design system (@app/ui):
- Spartan/ui 1.x: brain primitives plus helm components copied in by the CLI, on Tailwind v4. Covers dialogs, popovers, select, command palette, sonner toasts, resizable panes, sidebar and kbd.
- @angular/aria for tree, grid, listbox, menu/menubar, toolbar and tabs.
- Angular CDK for overlay, drag-drop, virtual scroll, a11y key managers and the context-menu trigger.
- Tokens as CSS custom properties: light, dark and high-contrast themes; compact density (rows about 22-24 px, 12-13 px font); dark mode via color-scheme and light-dark().
- Never use PrimeNG 22 or later.

**Why.** The UI needs IDE-level density and full control over look and keyboard behaviour, which favours unstyled primitives plus styled code we own. Spartan reached 1.0 in June 2026 with semver, signals and zoneless support, Signal Forms demos and an MCP server for agents. @angular/aria is stable, first-party and ships harnesses.

**Alternatives.** Angular Material 22: the best-maintained option, with M3 density from 0 to -5, but a consumer look and no palette, split panes or toast stack. NG-ZORRO 22: virtual table and tree, splitter, compact and dark themes, but an Ant look and Less-based theming. Taiga UI 5: 130+ components, but a distinctive style. PrimeNG 22: commercial PrimeUI licence. Optimus UI (MIT fork of PrimeNG 21): only two months old. Clarity: Core unsupported and a small Angular community. ng-primitives and Zard UI: younger than Spartan. Siemens Element: implements the Siemens brand.

**Risks.** Spartan is a small project (about 3k stars). The copied helm code becomes ours to maintain. Spartan brain overlaps with @angular/aria, so we need a written policy on which to use where. Ties us to Tailwind v4.

### Data grid (100k-row virtualised tables)

**Recommendation.** Use AG Grid Community 36 (MIT) for all large grids (queues, message browser, connections, consumers) behind an internal <app-data-grid> contract: column definitions, row source, selection model, persisted column state, context-menu and keybinding hooks. Ban ag-grid-enterprise with dependency and lint rules. Build the context menu (onCellContextMenu plus CDK/Aria menu), clipboard and column chooser ourselves. Apply live updates with applyTransactionAsync at about 4-10 Hz. Use TanStack Table v9 (via Spartan's data-table) for small tables, and keep it as the swap-in implementation.

**Why.** AG Grid Community already covers row and column virtualisation, sorting, text/number/date/quick filters, row selection, keyboard navigation with ARIA, Angular cell renderers, column state, CSV export and batched high-frequency updates. It supports Angular 20-22 and zoneless. Building the same quality on top of a headless library is a substantial project.

**Alternatives.** TanStack Table v9 + TanStack Virtual + Aria grid: everything free (cell selection, grouping) and fully owned, but keyboard, a11y, resize, pinning and virtualisation wiring must be built. Angular-Slickgrid 10: MIT and very fast, but one maintainer. RevoGrid 4: Stencil web component with an MIT core plus Pro. ngx-datatable: the Siemens fork is active; the swimlane original has 900+ open issues/PRs. CDK/Material table: virtual scroll with fixed-size rows only. PrimeNG Table: licence.

**Risks.** The Enterprise wall covers context menu, column menu, clipboard, cell-range selection, set/multi/advanced filter, row grouping, tree data, master/detail, status bar and Find. AG Grid could move features between tiers in future. Its API surface is large, so it must stay behind the adapter. TanStack's Angular Virtual adapter went through three majors in twelve months.

### Graph / topology visualisation and auto-layout

**Recommendation.** Use Cytoscape.js 3.34 through a thin Angular wrapper for the cluster/vhost topology overview: compound nodes per vhost, the WebGL renderer above about 1k elements, and level-of-detail styling. Use ELK (elkjs 0.12, 'layered' algorithm, run in a Web Worker) as the primary layout, with @dagrejs/dagre 3.x as the lightweight fallback. Use Foblex Flow 19 for small, highly interactive diagrams (exchange fan-out, message-path trace, shovel/federation editors) where nodes are Angular templates. Always provide an accessible tree or table alternative to the canvas view.

**Why.** Canvas/WebGL is needed for 1-5k nodes. Cytoscape is mature (11k stars), MIT, and has compound nodes and ELK/dagre layouts. Its WebGL preview measured 20 to 100+ FPS at 1,200 nodes. Foblex provides Angular-native editing, undo/redo, keyboard a11y, ELK/dagre packages and agent documentation.

**Alternatives.** ngx-vflow 2.7: MIT and signals-based, a good editor alternative to Foblex. @swimlane/ngx-graph 13: depends on the deprecated @angular/animations. Sigma.js 4: WebGL, but a full rewrite released 2026-10-08. Raw D3: the most code to write. maxGraph, AntV X6 and AntV G6.

**Risks.** The WebGL renderer is a provisional preview with restricted edge styles. elkjs is EPL-2.0 (or GPL-3.0+) and about 423 KB gzip, so it needs a licence review and lazy loading. Thousands of labelled nodes need LOD and edge-hiding tuning. DOM-based flow libraries won't scale to the full topology.

### Code / JSON editor

**Recommendation.** Use Monaco 0.57 integrated directly as ESM in a lazily loaded chunk, with an in-house Angular wrapper: signal inputs, Signal Forms/ControlValueAccessor support, model disposal. Enable JSON-Schema diagnostics through the JSON language service, and use the diff editor for comparing messages and definitions. Bundle only the editor and JSON workers (optionally XML/YAML) using one-line `new Worker(new URL(...))` wrapper modules, and add a .ttf loader for codicons; Stratos uses this pattern. Do not use ngx-monaco-editor-v2.

**Why.** Users of a de facto RabbitMQ IDE will expect VS Code-grade editing, schema validation and diffs. Monaco deprecated its AMD build in 0.53 and added tree-shakable ESM entry points in 0.56. Stratos has shown this pattern working in production with Angular's esbuild builder (673 kB lazy chunk over the wire).

**Alternatives.** CodeMirror 6: about 116 KB gzip with no workers, and @codemirror/merge for diffs. But the JSON-schema add-on was last released Apr 2025, the Angular wrapper (@acrodata/code-editor) is small, and development has moved off GitHub. ngx-monaco-editor-v2: uses the deprecated AMD loader. NG-ZORRO's code-editor: tied to that library.

**Risks.** Monaco is heavy (core chunk about 2.4 MB minified; never ship the TypeScript worker) and still 0.x, with breaking changes in 0.55 and 0.56. Workers must be allowed by the CSP and work under the app:// protocol. Mobile and touch support is weak.

### Charts / time series

**Recommendation.** Use uPlot 1.6 for live message-rate charts, sparklines and long time series, through a thin in-house directive that updates via setData inside requestAnimationFrame. Use ECharts 6.1 via ngx-echarts 22, with tree-shaken echarts/core imports, for dashboards, history with dataZoom, heatmaps and breakdowns. Avoid ApexCharts and lightweight-charts.

**Why.** uPlot is about 50 KB minified and built for streaming time series (author's benchmarks: 166k points in 25 ms; 3,600 streamed points at 60 fps for about 10% CPU). ECharts 6 adds dark mode, dynamic theme switching and new composition features under Apache-2.0.

**Alternatives.** Chart.js 4.5 with ng2-charts 11: simple but slower when streaming. AG Charts Community 14: MIT and visually consistent with AG Grid. lightweight-charts 5.2: built for finance and requires TradingView attribution. ApexCharts: free tier limited to small organisations and excludes embedding.

**Risks.** uPlot has no official Angular wrapper and its benchmarks are self-published. A full ECharts build is about 359 KB gzip. Running two chart libraries doubles the theming work, so route both through one ThemeService.

### Keyboard shortcuts and command palette

**Recommendation.** Build a VS Code-style CommandRegistry and KeybindingService with command ids, titles, categories, when-contexts, a user-remappable JSON keymap and a cheat sheet. Use tinykeys 4 for parsing and matching keys. Render the palette with Spartan's command component (or an Aria combobox plus listbox), with engine-side fuzzy search for entities. Generate Electron menu accelerators from the same registry. Define web-safe alternates for chords the browser keeps for itself.

**Why.** A keyboard-first UI needs one source of truth for commands, used by palette, menus, context menus and shortcuts alike. That source is also easy to test as a contract. tinykeys is tiny, stable and MIT.

**Alternatives.** @tanstack/angular-hotkeys 0.14: alpha since Feb 2026; has sequences, a recorder and cheat-sheet helpers; revisit at 1.0. @ngneat/hotkeys 4.1: last release Feb 2025, repo moved. @ngxpert/cmdk 3.0: last release Jun 2024.

**Risks.** In browser mode the browser does not let pages capture Ctrl+W/T/N/Tab and similar chords. Electron accelerators and renderer handlers can both fire unless they are centralised.

### Workspace layout: split panes, tabs, docking, drag-drop

**Recommendation.** Use a fixed IDE shell: activity bar, a resizable side tree, an editor-style tab area and a resizable bottom panel. Build it from Spartan resizable (or angular-split 20), Aria tabs, and CDK drag-drop for reordering tabs. Persist the layout per profile. Adopt dockview-angular (MIT core) only if free-form docking or floating panels become a requirement.

**Why.** A fixed shell covers RabbitMQ workflows with minimal dependencies and keeps keyboard behaviour under our control.

**Alternatives.** dockview-angular 8.5: MIT core, but keyboard docking, spatial keyboard navigation and layout history are commercial Enterprise features. golden-layout 2.6: unmaintained since 2022. NG-ZORRO splitter.

**Risks.** angular-split has not released since Jul 2025, though its peer range (>=19) still covers Angular 22. dockview's open-core direction could move more features behind the paid tier.

### Embedded console

**Recommendation.** Use @xterm/xterm 6 with the fit, search, web-links and webgl addons, wrapped in a thin component and lazy-loaded. Use it for log tails and REPL-style streams that the engine provides. Never expose an OS shell, especially in team-server mode.

**Why.** xterm.js is the de facto web terminal (21k stars, MIT) and is used by Tabby (Angular + Electron). v6 adds ESM support, which works with esbuild.

**Alternatives.** Plain virtualised log list: enough for logs, but loses ANSI rendering and terminal UX.

**Risks.** v6 changed scrolling and some options in breaking ways. A terminal UI encourages feature creep toward shell access, which is a security risk.

### Internationalisation

**Recommendation.** Use Transloco 8 (@jsverse/transloco) with lazy-loaded scopes, the signal API and keys-manager extraction. Ship English first but externalise every string from day one. Keep a single build artefact for all delivery modes.

**Why.** Transloco switches language at runtime and works with one build. Angular's built-in i18n produces one build per locale with no runtime switching, which complicates Electron and Docker distribution.

**Alternatives.** @angular/localize: compile-time only. ngx-translate 18: runtime switching, but a smaller feature set.

**Risks.** 172 open issues/PRs. Transloco 9 is in alpha and may break APIs. Runtime translation adds a small overhead.

### Icons, markdown, toasts and cross-library theming

**Recommendation.** - Icons: @lucide/angular (official, signal-based, zoneless, ISC); optionally @vscode/codicons (CC-BY-4.0, attribution required) for IDE glyphs.
- Built-in docs: ngx-markdown 22 with marked 18, sanitisation on and raw HTML disabled.
- Toasts: Spartan sonner.
- Theming: a central ThemeService that pushes design tokens into AG Grid theme params, Monaco themes, uPlot, ECharts and Cytoscape styles.

**Why.** These keep licences permissive and give one consistent look in light and dark across libraries that draw on canvas and don't read CSS variables.

**Alternatives.** @ng-icons/core 36 (MIT); Material Symbols (Apache-2.0); the legacy lucide-angular package (peer range stops at Angular 21).

**Risks.** CC-BY codicons need attribution. ngx-sonner's last release was Mar 2025. Markdown rendering opens XSS risk unless sanitised.

### Angular inside Electron

**Recommendation.** Use Electron 44+. Serve the Angular build from a privileged custom scheme: registerSchemesAsPrivileged with standard, secure and supportFetchAPI; protocol.handle with path-traversal checks; SPA fallback to index.html; CSP headers on each response. Keep contextIsolation and sandbox on and nodeIntegration off. Expose a minimal, versioned, typed preload API through contextBridge (file dialogs, OS-protected secrets, notifications, window controls, deep links) plus a MessagePort to the engine running in a utilityProcess. Angular depends only on abstract EngineTransport and PlatformBridge tokens, with WebSocket and web implementations for browser and team-server modes. In development, run ng serve and point Electron at it with loadURL; in production use app://. Use a custom title bar and Aria menubar so desktop and web match.

**Why.** Electron's security checklist (#18) recommends custom protocols over file://. MessagePorts let the renderer talk directly to a utility process. Altair uses a custom protocol precisely because of file:// limitations, and Mockoon and Bitwarden show Angular 21/22 running in Electron 43/44. One transport abstraction keeps a single Angular build across all three delivery modes.

**Alternatives.** loadFile (file://) with hash routing, as Mockoon does: simpler, but weaker isolation and no SPA fallback. Loading the engine's loopback HTTP server in Electron: one code path, but needs a token plus Origin and Host checks. Tauri 2 with a Node sidecar: smaller binaries, but splits the runtime.

**Risks.** The combination of custom protocol, module workers (Monaco) and CSP needs a spike. Electron releases every 8 weeks and supports only the latest three majors. Native accelerators and in-app hotkeys can conflict. Playwright's Electron support is experimental.

## Report

# Angular UI ecosystem for an IDE-style, keyboard-first RabbitMQ tool (status 16 Oct 2026)

Versions and dates below come from the npm registry and GitHub API (queried 2026-10-16) unless another source is linked. GitHub "open" counts include PRs.

## 0. Recommended stack at a glance

| Layer | Pick | Latest (date) | Licence |
| --- | --- | --- | --- |
| Framework | Angular 22 (zoneless, OnPush, signals, Signal Forms) | 22.2.3 (2026-10-14) | MIT |
| Accessible patterns, no styling | @angular/aria + @angular/cdk | 22.2.3 | MIT |
| Design system | Spartan/ui (`@spartan-ng/brain` + CLI-copied "helm" components), Tailwind v4, as in-repo `@app/ui` | 1.7.0 (2026-10-14) | MIT |
| Shared state | signals + NgRx SignalStore | @ngrx/signals 22.0.1 (2026-09-10) | MIT |
| Large grids | AG Grid Community behind an internal adapter (Enterprise banned) | 36.2.0 (2026-09-16) | MIT |
| Small tables / fallback grid | TanStack Table v9 + @tanstack/angular-virtual | 9.3.1 / 6.1.6 | MIT |
| Topology overview | Cytoscape.js + ELK (elkjs, in a Web Worker) | 3.34.4 / 0.12.0 | MIT / EPL-2.0 |
| Interactive diagrams | Foblex Flow | 19.3.0 (2026-09-27) | MIT |
| Code/JSON editor | monaco-editor, direct ESM, own wrapper | 0.57.0 (2026-09-24) | MIT |
| Live charts | uPlot (own thin directive) | 1.6.32 | MIT |
| Dashboards / history | ECharts 6 via ngx-echarts | 6.1.0 / 22.0.0 | Apache-2.0 / MIT |
| Shortcuts | own CommandRegistry + tinykeys | 4.0.1 | MIT |
| Terminal | @xterm/xterm | 6.0.0 (2025-12-22) | MIT |
| i18n | @jsverse/transloco | 8.4.0 | MIT |
| Icons / markdown | @lucide/angular / ngx-markdown + marked | 1.58.0 / 22.1.1 + 18.1.1 | ISC / MIT |
| Tests | Vitest 5 (CLI default), Playwright 1.64, Storybook 10 (`@storybook/angular-vite`) | - | MIT / Apache-2.0 |
| Desktop shell | Electron 44 (Chromium 152, Node 24.22) | 44.8.0 (2026-10-15) | MIT |

## 1. Angular platform status

**Releases and support** ([angular.dev/reference/releases](https://angular.dev/reference/releases)):

| Version | Status | Released | Active ends | LTS ends |
| --- | --- | --- | --- | --- |
| 22.x | Active | 2026-06-03 | 2027-06 | 2028-06 |
| 21.x | LTS | 2025-11-19 | 2026-06-03 | 2027-06 |
| 20.x | LTS | 2025-05-28 | 2025-11-19 | 2026-11-28 |

**New cadence.** After v22, Angular moved from two majors a year to one major every 12 months:
- 4-6 minor releases per major.
- Support lasts 24 months: 12 months active plus 12 months LTS.
- Angular 23 targets **June 2027** ([angular.love](https://angular.love/angular-new-release-cycle-release-schedule-change-explained)).

Minors so far: 22.1 shipped 2026-07-29 ([certificates.dev](https://certificates.dev/blog/whats-new-in-angular-221)) and 22.2 around 2026-09-23 ([Ninja Squad](https://blog.ninja-squad.com/2026/09/23/what-is-new-angular-22.2)). 22.3.0-next.2 is in pre-release ([GitHub releases](https://github.com/angular/angular/releases)).

**Status of the platform features that matter here:**
- **Zoneless.** The default since v21 ([angular.dev/guide/zoneless](https://angular.dev/guide/zoneless), [Ninja Squad 21.0](https://blog.ninja-squad.com/2025/11/20/what-is-new-angular-21.0)). Libraries must stop using `NgZone.onStable` and `onMicrotaskEmpty`. `run` and `runOutsideAngular` still work.
- **OnPush is the default in v22.** A migration marks existing components `Eager`. Also new in v22:
  - `strictTemplates` is on by default.
  - HttpClient uses Fetch by default.
  - New `@Service()` decorator and `injectAsync()`.
  - Template improvements: spread syntax, multi-case and exhaustive `@switch`, inline arrow functions.
  - Sources: [Ninja Squad 22.0](https://blog.ninja-squad.com/2026/06/03/what-is-new-angular-22.0), [Angular blog](https://blog.angular.dev/announcing-angular-v22-c52bb83a4664).
- **Stable in v22:**
  - **Signal Forms**, which also work with custom controls built on ControlValueAccessor.
  - **resource / rxResource / httpResource**, plus `chain()`.
  - **@angular/aria** (general availability).
  - `resource({stream})` is documented for WebSocket and SSE sources ([resource guide](https://angular.dev/guide/signals/resource)).
  - httpResource is for reads. Use HttpClient for mutations ([httpResource](https://angular.dev/guide/http/http-resource)).
- **Developer preview in 22.2:** `@boundary` error boundaries and router resources. Don't build on these yet.
- **@angular/aria.** Accessible patterns with no styling, each shipping testing harnesses ([overview](https://angular.dev/guide/aria/overview)):
  - The 13 patterns: Autocomplete, Listbox, Select, Multiselect, Combobox, Menu, Menubar, Toolbar, Accordion, Tabs, Tree, Grid.
  - Grid supports a roving tabindex or `aria-activedescendant` focus, the latter "better for virtual scrolling", plus range selection and editable cells ([grid](https://angular.dev/guide/aria/grid)).
  - Tree supports type-ahead and single, multi or follow-focus selection ([tree](https://angular.dev/guide/aria/tree)).
  - Menu has a context-menu recipe built on the CDK overlay ([menu](https://angular.dev/guide/aria/menu)).
- **Build.** `@angular/build` 22.2.3 bundles Vite 8.3, esbuild 0.28 and rolldown 1.2. `@angular-devkit/build-angular` is deprecated ("Angular's Webpack support is deprecated") ([npm](https://registry.npmjs.org/@angular-devkit/build-angular)).
  - Vite is used only as the dev server.
  - Web-worker code is not type-checked, and nested workers are not processed ([build-system migration](https://angular.dev/tools/cli/build-system-migration)).
  - 22.2 runs type-checking and bundling in parallel.
- **Animations.** `@angular/animations` is deprecated in favour of `animate.enter` / `animate.leave` ([npm](https://registry.npmjs.org/@angular/animations)). Avoid libraries that still require it, such as ngx-graph and ngx-charts.
- **Tests.** New projects default to Vitest with jsdom. Karma is still supported, and browser mode works through Playwright or WebdriverIO ([testing guide](https://angular.dev/guide/testing)). The CLI moved to Vitest 5 in 22.2.
- **Toolchain constraints:**
  - `@angular/build` and `compiler-cli` 22.x (including 22.3-next) require **TypeScript >=6.0 <6.1**. TypeScript 7.0.2, the native port released 2026-07-08, is npm `latest` ([npm](https://registry.npmjs.org/typescript)).
  - Node must be `^22.22.3 || ^24.15.0 || >=26`.
  - Pin TS 6.0 across the monorepo.

**State management.** NgRx v22 shipped 2026-08-24 ([announcement](https://dev.to/ngrx/announcing-ngrx-v22-resource-extensions-dynamic-deep-signals-a-light-theme-and-more-5gci), [CHANGELOG](https://github.com/ngrx/platform/blob/main/CHANGELOG.md)).
- It adds `@ngrx/signals/resource` extensions and dynamic deep signals.
- The events plugin has been stable since v21 ([NgRx 21](https://dev.to/ngrx/announcing-ngrx-21-celebrating-a-10-year-journey-with-a-fresh-new-look-and-ngrxsignalsevents-5ekp)).
- Recommendation: signals for local state, SignalStore (entities, events) for shared feature state, RxJS 7.8 for stream plumbing. Skip classic `@ngrx/store`.

**Tooling for AI agents.** Several of these libraries now ship guidance or servers for coding agents:
- Angular ships agent skills ([angular/skills](https://github.com/angular/skills)) and a stable CLI MCP server (22.2 adds `--root`).
- Spartan ships `@spartan-ng/mcp`.
- Foblex Flow ships `AI.md` and stable `FFxxxx` diagnostics.
- AG Grid 36.1 added an "AI Coding Skill" ([what's new](https://www.ag-grid.com/whats-new/)).

## 2. Component libraries and design systems

| Library | Licence | Latest | Stars / open | IDE-density fit | Notes |
| --- | --- | --- | --- | --- | --- |
| Angular Material + CDK | MIT | 22.2.3 | 25.0k / 1,391 | Medium | M3 tokens (`--mat-sys-*`), `light-dark()` dark mode, density 0 to -5 ([theming guide](https://github.com/angular/components/blob/main/guides/theming.md)). No command palette, split panes or toast stack (snackbar only). The look is consumer-style. |
| **Spartan/ui** | MIT | 1.7.0; 1.0 on 2026-06-24 | 2.95k / 95 | **High** | Unstyled "brain" primitives on the CDK; styled "helm" components are copied into your repo. Tailwind v4. 55+ components: command, context-menu, menubar, resizable, sonner toasts, sidebar, tabs, table (TanStack v9), kbd, scroll-area. Signal Forms demos. MCP server ([repo](https://github.com/spartan-ng/spartan), [1.0 announcement](https://angularindepth.com/article/announcing-spartan-ui-1-0/)). |
| NG-ZORRO | MIT | 22.1.2; 22.0 on 2026-07-21 | 9.2k / 786 | Medium-high | Virtual table and tree (CDK), splitter, Monaco code-editor, compact and dark themes (Less). Ant Design look. |
| Taiga UI 5 | Apache-2.0 | 5.28.0; 5.0 on 2026-04-01 | 4.1k / 135 | Medium | 130+ components. Fully migrated to signals; no `@angular/animations` ([v5 notes](https://github.com/taiga-family/taiga-ui/releases/tag/v5.0.0)). Distinctive style. |
| **PrimeNG 22** | **PrimeUI commercial** | 22.1.2 (2026-09-29) | 12.5k / 1,268 | High (features) | **Not open source from v22.** See below. |
| Optimus UI (OpenNG fork of PrimeNG 21) | MIT | 2.0.2 (2026-08-28) | 748 | High | Community continuation, two months old ([repo](https://github.com/openng-org/optimus-ui)). |
| Clarity Angular | MIT | 18.4.0 | 433 / 82 | Medium | Clarity **Core is "no longer supported"** and archived ([core](https://github.com/vmware-clarity/core)). The Angular package continues ([ng-clarity](https://github.com/vmware-clarity/ng-clarity)). |
| ng-primitives / Zard UI | Apache-2.0 / MIT | 0.131 / 1.0.2 | 607 / 1.2k | High | Younger alternatives to Spartan. |
| Siemens Element | MIT | 51.4.0 | 82 | - | Implements the Siemens brand language. Peer-depends on `@angular/aria` and AG Grid. |

**The PrimeNG licence change is decisive.** The `LICENSE.md` shipped in `primeng@22.1.2` says ([jsDelivr](https://cdn.jsdelivr.net/npm/primeng@22.1.2/LICENSE.md)):
- It is "part of PrimeUI, a family of commercial UI libraries".
- "A valid license key is required".
- It is "distributed as a compiled package".
- Redistribution "so that third parties can develop with it requires a separate OEM License".

The Community licence ([primeui.dev](https://primeui.dev/licenses/community)):
- Covers individuals and organisations with fewer than 5 developers, fewer than 10 employees, under USD 1M revenue and under USD 3M funding.
- Says "PrimeUI does not include a separate open source program".
- States that PrimeNG 21 and earlier remain MIT.

Other facts:
- The commercial price is USD 599 per developer ([ng-news](https://dev.to/playfulprogramming-angular/ng-news-2617-primengs-new-licensing-and-a2ui-for-angular-4eik)).
- npm metadata for 22.1.2 points to a repository that is not public (`primeng-nextchapter`), and v22 depends on `@primeui/license-manager`.
- **Conclusion: unusable for a fully open-source, redistributed tool.**

**Recommendation.** Build an in-repo `@app/ui` design system:
- **Spartan helm** (copied into the repo, so we own it) for dialogs, sheets, popovers, tooltips, select, command palette, sonner toasts, resizable panes and the sidebar.
- **@angular/aria** for tree, grid, listbox, menu/menubar, toolbar and tabs. These are first-party, stable and ship test harnesses.
- **CDK** for overlay, drag-drop, virtual scroll, a11y key managers and clipboard. CDK Menu's `cdkContextMenuTriggerFor` handles right-click menus, including nested ones ([cdk/menu](https://github.com/angular/components/blob/main/src/cdk/menu/menu.md)).
- **Styling:** tokens are CSS custom properties.
  - Themes: light, dark, high-contrast.
  - Density: compact rows of about 22-24 px and a 12-13 px UI font.
  - Tailwind v4 is supported by the CLI (`ng new --style tailwind`).
- Heavy widgets are lazy-loaded with `@defer` so the browser and team-server builds stay small.

## 3. Data grids (100k rows, live updates)

**AG Grid Community 36 vs Enterprise** ([modules](https://www.ag-grid.com/angular-data-grid/modules/), [community vs enterprise](https://www.ag-grid.com/angular-data-grid/community-vs-enterprise/)):

| Free in Community (MIT) | Enterprise only |
| --- | --- |
| Client-side and **infinite** row models ([infinite](https://www.ag-grid.com/angular-data-grid/infinite-scrolling/)) | Server-side row model |
| Row/column virtualisation ([DOM virtualisation](https://www.ag-grid.com/angular-data-grid/dom-virtualisation/)) and row selection | Cell (range) selection, clipboard |
| Text, number, date and quick filters | Set, multi and advanced filter, Find |
| Column resize, move, pin, auto-size; row pinning; cell spanning; auto-height rows | Column menu, tool panels, side bar, status bar |
| Angular cell renderers, CSV export, theming | Row grouping, tree data, master/detail, pivot, Excel export, integrated charts |
| `applyTransactionAsync` batching for high-frequency updates ([docs](https://www.ag-grid.com/angular-data-grid/data-update-high-frequency/)) | Context menu ([docs](https://www.ag-grid.com/angular-data-grid/context-menu/)) |

AG Grid 36 supports Angular 20-22 and is "fully compatible with Zoneless" ([compatibility](https://www.ag-grid.com/angular-data-grid/compatibility/)). Community still lets you build your own context menu with `suppressContextMenu` / `preventDefaultOnContextMenu` and `onCellContextMenu` ([typings](https://cdn.jsdelivr.net/npm/ag-grid-community@36.2.0/dist/types/src/entities/gridOptions.d.ts)).

**TanStack Table v9** went stable on 2026-08-04 ([announcement](https://tanstack.com/blog/announcing-tanstack-table-v9)).
- Features are tree-shakable via `tableFeatures()`.
- New: cell selection with rectangular ranges, cell spanning, faster row models.
- The Angular adapter uses `injectTable` and `FlexRender` and bridges into signals ([quick start](https://github.com/TanStack/table/blob/main/docs/framework/angular/quick-start.md)).
- It has no virtualisation of its own; use `@tanstack/angular-virtual` `injectVirtualizer` ([guide](https://github.com/TanStack/table/blob/main/docs/framework/angular/guide/virtualization.md)).
- Churn risk: the Angular Virtual adapter had three majors in a year (4.0 Aug 2025, 5.0 Apr 2026, 6.0 Jul 2026).

**Others:**
- **Angular-Slickgrid 10.11:** MIT and very fast, but maintained by one person; moved into the [slickgrid-universal](https://github.com/ghiscoding/slickgrid-universal) monorepo.
- **RevoGrid 4.29:** a Stencil web component, MIT core plus a paid Pro tier, claims 1M+ rows ([repo](https://github.com/revolist/revogrid)).
- **ngx-datatable:** the [Siemens fork](https://github.com/siemens/ngx-datatable) is active (27.1.0); the [swimlane original](https://github.com/swimlane/ngx-datatable) has 916 open issues and PRs.
- **CDK/Material table:** has supported wrapping in `cdk-virtual-scroll-viewport` since Dec 2025, but forces `fixedLayout` and doesn't support `when` templates ([table.md](https://github.com/angular/components/blob/main/src/cdk/table/table.md)). Only the fixed-size strategy is production-ready; autosize is "not ready for production use" ([scrolling.md](https://github.com/angular/components/blob/main/src/cdk/scrolling/scrolling.md)).
- **PrimeNG Table:** excluded because of the licence.

**Recommendation:**
- Use AG Grid Community for the queue list, message browser, connections and consumers, behind an `<app-data-grid>` contract: column model, row source, selection, persisted column state, context-menu and keybinding hooks.
- Block `ag-grid-enterprise` with dependency and lint rules.
- Build the context menu (CDK/Aria), clipboard and column chooser ourselves.
- Use TanStack v9 (already behind Spartan's data-table) for small tables, and keep it as the swap-in implementation.
- Live data: the engine batches; the UI applies `applyTransactionAsync` at about 4-10 Hz. Tapped-message buffers live in ring buffers outside the signal graph.

## 4. Graph and topology visualisation (1-5k nodes)

| Library | Rendering | Latest | Stars | Notes |
| --- | --- | --- | --- | --- |
| **Cytoscape.js** | Canvas, plus WebGL preview | 3.34.4 (2026-10-15) | 11.2k | Compound nodes (vhost groups); dagre, ELK, fcose, cola layouts. The WebGL preview (3.31+, `renderer:{name:'canvas', webgl:true}`) took a 1,200-node graph from 20 to 100+ FPS and a 3,200-node graph from 3 to 10 FPS. It supports only straight, haystack and bezier edges with solid colours ([blog](https://blog.js.cytoscape.org/2025/01/13/webgl-preview/)). |
| **Foblex Flow** | DOM/SVG (Angular templates) | 19.3.0 | 539 | Node editor: undo/redo state, keyboard a11y layer, dagre/ELK packages, node virtualisation and workers, AI.md ([repo](https://github.com/Foblex/f-flow)). |
| ngx-vflow | DOM/SVG | 2.7.0 | 487 | Signals, subflows, minimap, virtualisation; Angular 19.2.17+ ([repo](https://github.com/artem-mangilev/ngx-vflow)). |
| @swimlane/ngx-graph | SVG | 13.0.0 | 996 / 111 | Peer-requires the deprecated `@angular/animations`. |
| Sigma.js | WebGL | 4.0.3 | 12.2k | v4 was a **complete rewrite released 2026-10-08** ([releases](https://github.com/jacomyal/sigma.js/releases)). |
| D3 | SVG/Canvas | 7.9.0 (2024-03) | 113.8k | Maximum control, most code. |

**Layout:**
- **elkjs 0.12.0** (2026-07-17) gives layered layouts with ports and orthogonal routing, which suits exchange → queue graphs.
  - It is about 1.4 MB minified, ~423 KB gzip ([bundlephobia](https://bundlephobia.com/api/size?package=elkjs@0.12.0)). Run it in a worker.
  - It is licensed **EPL-2.0 OR GPL-3.0-or-later** ([package.json](https://github.com/kieler/elkjs/blob/master/package.json)).
- **@dagrejs/dagre 3.1.1** (2026-08-08, MIT, ~15 KB gzip) is the maintained dagre. The unscoped `dagre` 0.8.5 has had no release since 2019 ([dagre README](https://github.com/dagrejs/dagre)).

**Recommendation.** Use Cytoscape for the cluster or vhost overview, with a level-of-detail strategy (`min-zoomed-font-size`, haystack edges, WebGL above about 1k elements; [performance doc](https://github.com/cytoscape/cytoscape.js/blob/unstable/documentation/md/performance.md)). Use Foblex Flow for small interactive diagrams: exchange fan-out, message-path trace, shovel/federation editors. Because canvas isn't accessible, always provide a keyboard tree or table alternative.

## 5. Code and JSON editors

|  | Monaco 0.57 | CodeMirror 6 |
| --- | --- | --- |
| UX | VS Code-familiar; JSON language service with schema diagnostics; diff editor | Modular; `@codemirror/merge` for diffs |
| Size | Core chunk about 2.4 MB minified; TypeScript worker about 6.6 MB ([jsDelivr listing](https://data.jsdelivr.com/v1/packages/npm/monaco-editor@0.57.0?structure=flat)) | `codemirror` with basicSetup is about 116 KB gzip ([bundlephobia](https://bundlephobia.com/api/size?package=codemirror@6.0.2)) |
| Workers | Required (editor, json, ...) | None |
| Angular wrappers | ngx-monaco-editor-v2 22.0.5 still uses the **AMD `loader.js`** ([source](https://github.com/miki995/ngx-monaco-editor-v2/blob/master/projects/editor/src/lib/base-editor.ts)). Monaco deprecated AMD in 0.53 and added tree-shakable ESM entry points in 0.56 ([CHANGELOG](https://github.com/microsoft/monaco-editor/blob/main/CHANGELOG.md)). | `@acrodata/code-editor` 0.6.1 (53 stars). `codemirror-json-schema` last released Apr 2025. Development moved to code.haverbeke.berlin and the GitHub repo is archived ([codemirror/dev](https://github.com/codemirror/dev)). |

**A working recipe exists.** Cloud Foundry Stratos (Angular) moved Monaco into the Angular esbuild build in Jul 2026 ([PR #5651](https://github.com/cloudfoundry/stratos/pull/5651)):
- The editor is a hashed lazy chunk (673 kB over the wire), dynamically imported on first use.
- Workers come from one-line wrapper modules using `new Worker(new URL(...))`, because the builder doesn't resolve bare package specifiers there.
- A `.ttf` loader entry is needed for the codicon font.

**Recommendation.** Use Monaco through that ESM pattern with our own wrapper:
- signal inputs and Signal Forms / ControlValueAccessor support
- model disposal on destroy
- JSON plus optional XML/YAML; no TypeScript worker

CodeMirror 6 is the fallback for very light inline editors. In Electron, workers are same-origin under `app://`. The CSP needs `worker-src 'self'`.

## 6. Charts and time series

| Library | Latest | Size (min/gzip) | Fit |
| --- | --- | --- | --- |
| **uPlot** | 1.6.32 (repo active) | 50 / 21 KB | 166k points in 25 ms from a cold start; streaming 3,600 points at 60 fps uses about 10% CPU vs 40% for Chart.js and 70% for ECharts 5 (author's own benchmarks, [README](https://github.com/leeoniya/uPlot)). No Angular wrapper. |
| **ECharts 6** + ngx-echarts 22 | 6.1.0 / 22.0.0 | 1,089 / 359 KB full | Dark mode and dynamic theme switching, matrix coordinates, new chart types ([v6 features](https://echarts.apache.org/handbook/en/basics/release-note/v6-feature)). Tree-shake with `provideEchartsCore` ([ngx-echarts](https://github.com/xieziyu/ngx-echarts)). |
| Chart.js + ng2-charts | 4.5.1 / 11.0.0 | 196 / 67 KB | Simple; slower for streaming. |
| lightweight-charts | 5.2.1 | 190 / 60 KB | Built for finance; requires TradingView attribution and a link ([README](https://github.com/tradingview/lightweight-charts)). |
| ApexCharts | 8.3.1 | - | Dual licence: the free tier is limited to organisations under USD 2M and excludes embedding in products ([LICENSE](https://cdn.jsdelivr.net/npm/apexcharts@8.3.1/LICENSE.md)). **Avoid.** |

**Recommendation:** uPlot for live rates and sparklines; ECharts for dashboards and long history with `dataZoom`.

## 7. Other building blocks

**Shortcuts and command palette**
- Pick: our own CommandRegistry and KeybindingService (VS Code-style, with "when" contexts and a JSON keymap), with **tinykeys 4.0.1** for parsing and matching, and Spartan `command` for the palette.
- Alternatives and risks:
  - `@tanstack/angular-hotkeys` 0.14 is alpha (first release Feb 2026; [repo](https://github.com/TanStack/hotkeys)).
  - `@ngneat/hotkeys` 4.1.0 last released Feb 2025 and its repo moved.
  - `@ngxpert/cmdk` last released Jun 2024.
  - In browser mode, the browser keeps chords such as Ctrl+W/T/N, and `Keyboard.lock()` "cannot capture system or browser shortcuts" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Keyboard/lock)). Ship web-safe alternates.

**Split panes and docking**
- Pick: Spartan resizable (or angular-split 20.0.0, Apache-2.0), Aria tabs, and CDK drag-drop for reordering tabs.
- Alternatives and risks:
  - dockview-angular 8.5.1 has an MIT core, but **keyboard docking, spatial keyboard navigation and layout history are Enterprise** ([licence](https://dockview.dev/docs/overview/licence)).
  - golden-layout has had no release since 2022.

**Embedded terminal**
- Pick: @xterm/xterm 6.0.0 with the fit, search and webgl addons.
- Risks: v6 introduced ESM support and some breaking changes ([release](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0)). Never expose an OS shell in team-server mode.

**i18n**
- Pick: Transloco 8.4.0: runtime switching, lazy scopes, signal API ([repo](https://github.com/jsverse/transloco)).
- Alternatives and risks: `@angular/localize` needs a separate build per locale and can't switch at runtime ([docs](https://angular.dev/guide/i18n/merge)). ngx-translate 18 is the other runtime option.

**Icons**
- Pick: @lucide/angular 1.58: official, signal-based, zoneless ([package](https://github.com/lucide-icons/lucide/tree/main/packages/angular)).
- Alternatives and risks: `@vscode/codicons` is CC-BY-4.0, so it needs attribution.

**Markdown**
- Pick: ngx-markdown 22.1.1 (peer: marked 17/18).
- Risks: sanitise output and disable raw HTML.

**Toasts and dialogs**
- Pick: Spartan sonner (built on ngx-sonner 3.1.0) and CDK Dialog.
- Risks: ngx-sonner's last release was Mar 2025.

**Tests**
- Pick: Vitest 5, CDK/Aria harnesses, `@storybook/angular-vite` 10.6 (uses `@angular/build`), Playwright 1.64.
- Risks: Playwright's Electron support is "experimental" ([docs](https://playwright.dev/docs/api/class-electron)).

## 8. Angular inside Electron

**Electron.** 44.8.0 runs Chromium 152 and Node 24.22 ([releases.json](https://releases.electronjs.org/releases.json)). Majors ship every 8 weeks, and only the latest three are supported ([timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)).

**Patterns:**
1. **Serve the UI from a custom protocol, not `file://`.** This is item 18 of the security checklist ([security](https://www.electronjs.org/docs/latest/tutorial/security)).
   - Use `registerSchemesAsPrivileged` with `standard`, `secure` and `supportFetchAPI`, and `protocol.handle` with path-traversal checks ([protocol](https://www.electronjs.org/docs/latest/api/protocol)).
   - The handler falls back to `index.html`. That lets PathLocationStrategy work: routed apps need the server to return `index.html` for unknown paths ([deployment](https://angular.dev/tools/cli/deployment)).
   - Set CSP per response. Altair does exactly this: "a custom buffer protocol, instead of a file protocol because of restrictions with the file protocol" ([window.ts](https://github.com/altair-graphql/altair/blob/master/packages/altair-electron/src/main/app/window.ts)).
   - `file://` does work with the Angular 22 esbuild output. Mockoon uses `loadFile` with `sandbox:true` ([main-window.ts](https://github.com/mockoon/mockoon/blob/main/packages/app/src/main/libs/main-window.ts)). The cost is a relative base href and hash routing.
2. **Isolation.** Keep `contextIsolation` (default since Electron 12) and `sandbox` (default since Electron 20) on, and `nodeIntegration` off. Expose a minimal typed API with `contextBridge`, never raw `ipcRenderer` ([context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)). Validate IPC senders.
3. **Engine link.** Run the engine in a `utilityProcess` ([docs](https://www.electronjs.org/docs/latest/api/utility-process)) and hand the renderer a MessagePort, giving direct renderer-to-worker messaging without main-process hops ([message ports](https://www.electronjs.org/docs/latest/tutorial/message-ports)). Angular depends only on abstract `EngineTransport` and `PlatformBridge` tokens: WebSocket for browser and team-server modes, MessagePort for desktop. Zoneless removes the old `NgZone.run` workaround for IPC callbacks.
4. **CSP.** `security.autoCsp` hashes inline scripts. Nonces can't be combined with inlined critical CSS ([security](https://angular.dev/best-practices/security)). Add `worker-src` for Monaco.
5. **Dev loop and window chrome.** In development, run `ng serve` and point Electron at `loadURL(http://localhost:4200)`. Use a custom title bar and Aria menubar so desktop and web look the same, and generate native menu accelerators from the command registry.

**Angular + Electron apps in the wild:**

| App | Angular | Electron | Notes |
| --- | --- | --- | --- |
| Bitwarden desktop ([clients](https://github.com/bitwarden/clients)) | 21.2.17 | 43.5.0 | Still on zone.js. |
| Mockoon ([repo](https://github.com/mockoon/mockoon)) | 22.1.6 | 44.4.5 | Uses `@angular/build`. |
| Altair GraphQL ([repo](https://github.com/altair-graphql/altair)) | 20.3 | - | Same app shared across web, desktop and browser extensions. |
| Tabby ([repo](https://github.com/Eugeny/tabby)) | 15 | 43 | Shows how upgrade debt piles up. |

## 9. Guardrails for an agent-written UI

- Third-party UI goes behind adapters: grid, editor, chart and graph wrappers. Feature code imports only `@app/ui` contracts. Lint bans direct imports of `ag-grid-*`, `monaco-editor`, `cytoscape` and `echarts` outside the adapters.
- Have one ThemeService that pushes the CSS tokens into libraries that don't read CSS: AG Grid theme params, Monaco themes, uPlot, ECharts, Cytoscape.
- Ship one build artefact with runtime config for all three delivery modes. No per-mode or per-locale builds.
- Every interactive component gets a harness test. Canvas and virtualised parts get Vitest browser-mode or Playwright checks.

## 10. Watch list

- Angular 23 (June 2027) and when Angular supports TypeScript 7.
- Whether Aria Tree/Grid support virtualisation.
- AG Grid moving features between Community and Enterprise.
- Spartan's long-term maintenance.
- The Optimus UI fork's viability.
- Sigma 4 maturing.
- TanStack Hotkeys reaching 1.0.

## Claims flagged for verification

- **[high]** PrimeNG v22 and later (since July 2026) is no longer MIT. It ships under the commercial 'PrimeUI License': a licence key is required, it is distributed compiled, and there is no separate open-source programme. Redistributing it so others can develop with it requires an OEM licence. PrimeNG 21 and earlier remain MIT.
- **[high]** Angular now ships one major per year. v22 (2026-06-03) is active until 2027-06 and in LTS until 2028-06. Angular 23 targets June 2027.
- **[high]** Angular 22.x, including 22.3.0-next.2, accepts only TypeScript >=6.0 <6.1, even though TypeScript 7.0.2 (the native port, July 2026) is npm 'latest'. The Angular CLI requires Node ^22.22.3, ^24.15.0 or >=26.
- **[high]** In Angular 22, Signal Forms, resource/rxResource/httpResource and @angular/aria are stable, OnPush is the default change-detection strategy, and zoneless has been the default since v21.
- **[high]** AG Grid Community (MIT) does not include the context menu, column menu, clipboard, cell-range selection, set/multi/advanced filter, Find, row grouping, tree data, master/detail, pivot, status bar or Excel export; these are Enterprise. Community does include the client-side and infinite row models, virtualisation, row selection, text/number/date/quick filters, CSV export and async transactions.
- **[high]** AG Grid 36 supports Angular 20-22 and is 'fully compatible with Zoneless Angular applications with no additional configuration'.
- **[high]** Monaco deprecated its AMD build in 0.53 and added tree-shakable ESM entry points in 0.56. ngx-monaco-editor-v2 22.x still loads Monaco through the AMD loader.js. Monaco can be bundled as ESM through Angular's esbuild builder using worker wrapper modules, as Stratos did in July 2026.
- **[high]** In Angular CDK virtual scrolling, only the fixed-size strategy is production-ready; autosize is still experimental. CDK and Material tables have supported virtual scrolling since about Dec 2025, but with fixedLayout forced and no `when` templates.
- **[high]** Cytoscape.js has had a WebGL renderer preview since v3.31 (renderer: {name:'canvas', webgl:true}). Measured gains: a 1,200-node graph from 20 to 100+ FPS and a 3,200-node graph from 3 to 10 FPS. Only straight, haystack and bezier edges with solid colours are supported.
- **[high]** elkjs (0.12.0) is licensed 'EPL-2.0 OR GPL-3.0-or-later'. The maintained dagre is @dagrejs/dagre 3.x (MIT); the unscoped 'dagre' package has not been released since 2019.
- **[high]** Electron's security checklist recommends serving local pages from custom protocols instead of file:// (item 18). Context isolation has been the default since Electron 12 and process sandboxing since Electron 20. Electron 44.8.0 runs Chromium 152 and Node 24.22.
- **[high]** TanStack Table v9 went stable on 2026-08-04. Its Angular adapter uses injectTable and FlexRender, and v9 adds a free cell-selection feature. The @tanstack/angular-virtual adapter went through majors 4, 5 and 6 between Aug 2025 and Jul 2026.
- **[high]** Spartan/ui reached a stable, semver-versioned 1.0 in June 2026 (1.0.0 published 2026-06-24; now 1.7.0). It is MIT with 55+ components, built on Angular CDK and Tailwind v4, and ships an MCP server.
- **[medium]** Clarity Core is 'no longer supported' and its repository is archived; only Clarity Angular (18.4.0) continues. In dockview, keyboard docking and spatial keyboard navigation are commercial Enterprise features.
- **[medium]** In normal browser tabs, pages cannot capture browser-reserved chords such as Ctrl+W, Ctrl+T and Ctrl+N; Keyboard.lock() 'cannot capture system or browser shortcuts'.

## Open questions

- Do the @angular/aria Tree and Grid patterns work with CDK or TanStack virtualisation (aria-activedescendant mode) for trees and grids with 10k+ nodes? Spike before committing to Aria for the vhost/queue tree.
- Do Monaco's ESM build, its module workers, the codicon font and a strict CSP all work under a privileged app:// protocol in a sandboxed Electron 44 renderer, and also in browser mode served by the engine?
- Will Angular support TypeScript 7 in a 22.x minor or only in v23 (June 2027)? Should the Node engine use TS 7 while the UI stays on TS 6.0?
- Is shipping elkjs (EPL-2.0 OR GPL-3.0-or-later) acceptable under the project's chosen licence (Apache-2.0 vs MIT) for desktop binaries and Docker images? If not, use dagre only.
- AG Grid Community vs TanStack v9: validate with a 100k-row message-browser prototype (live inserts at about 1k msg/s, keyboard navigation, custom context menu, persisted column state), measuring memory and FPS in Electron on a low-end Windows laptop.
- For 5k-node topologies with labels: Cytoscape WebGL preview vs Sigma 4 (WebGL, new rewrite). What level-of-detail and clustering strategy, and what accessible alternative view?
- Desktop transport: MessagePort to an Electron utilityProcess vs loading the engine's loopback HTTP/WS server. What threat model applies (DNS rebinding, local-process access, session token), and how much code does each share with local web mode?
- Keymap policy: the default chords for web vs desktop, whether to offer VS Code/DataGrip keymap presets, and whether users can remap and export keymaps.
- Governance of the design system: which primitives come from Spartan brain and which from @angular/aria, and does Spartan plan to adopt @angular/aria internally?
- Is the PrimeNG community fork (OpenNG Optimus UI) worth watching as a fallback component suite, and how sustainable is its maintenance?
- Electron vs Tauri 2 with a Node sidecar (owned by the desktop-packaging workstream) affects the bridge and protocol patterns recommended here.
- Web Search was rate-limited partway through this research; most facts were taken directly from npm, GitHub and official docs. Re-check vendor-only performance numbers (uPlot benchmarks, AG Grid claims) independently.

## Sources

- https://angular.dev/reference/releases
- https://blog.angular.dev/announcing-angular-v22-c52bb83a4664
- https://blog.ninja-squad.com/2026/06/03/what-is-new-angular-22.0
- https://certificates.dev/blog/whats-new-in-angular-221
- https://blog.ninja-squad.com/2026/09/23/what-is-new-angular-22.2
- https://blog.ninja-squad.com/2025/11/20/what-is-new-angular-21.0
- https://www.infoq.com/news/2026/08/angular-v22-released/
- https://angular.love/angular-new-release-cycle-release-schedule-change-explained
- https://angular.dev/guide/zoneless
- https://angular.dev/guide/aria/overview
- https://angular.dev/guide/aria/grid
- https://angular.dev/guide/aria/tree
- https://angular.dev/guide/aria/menu
- https://angular.dev/guide/forms/signals/overview
- https://angular.dev/guide/http/http-resource
- https://angular.dev/guide/signals/resource
- https://angular.dev/guide/testing
- https://angular.dev/tools/cli/build-system-migration
- https://angular.dev/ecosystem/web-workers
- https://angular.dev/best-practices/security
- https://angular.dev/tools/cli/deployment
- https://angular.dev/guide/i18n/merge
- https://github.com/angular/angular/releases
- https://github.com/angular/skills
- https://github.com/angular/components/blob/main/guides/theming.md
- https://github.com/angular/components/blob/main/src/cdk/scrolling/scrolling.md
- https://github.com/angular/components/blob/main/src/cdk/table/table.md
- https://github.com/angular/components/blob/main/src/material/table/table.md
- https://github.com/angular/components/blob/main/src/cdk/menu/menu.md
- https://registry.npmjs.org/@angular/build
- https://registry.npmjs.org/@angular/compiler-cli
- https://registry.npmjs.org/@angular-devkit/build-angular
- https://registry.npmjs.org/@angular/animations
- https://registry.npmjs.org/typescript
- https://registry.npmjs.org/@ngrx/signals
- https://dev.to/ngrx/announcing-ngrx-v22-resource-extensions-dynamic-deep-signals-a-light-theme-and-more-5gci
- https://dev.to/ngrx/announcing-ngrx-21-celebrating-a-10-year-journey-with-a-fresh-new-look-and-ngrxsignalsevents-5ekp
- https://github.com/ngrx/platform/blob/main/CHANGELOG.md
- https://github.com/spartan-ng/spartan
- https://angularindepth.com/article/announcing-spartan-ui-1-0/
- https://registry.npmjs.org/@spartan-ng/brain
- https://github.com/taiga-family/taiga-ui/releases/tag/v5.0.0
- https://github.com/NG-ZORRO/ng-zorro-antd
- https://github.com/vmware-clarity/ng-clarity
- https://github.com/vmware-clarity/core
- https://github.com/primefaces/primeng
- https://cdn.jsdelivr.net/npm/primeng@22.1.2/LICENSE.md
- https://primeui.dev/licenses/community
- https://dev.to/playfulprogramming-angular/ng-news-2617-primengs-new-licensing-and-a2ui-for-angular-4eik
- https://github.com/openng-org/optimus-ui
- https://github.com/ng-primitives/ng-primitives
- https://github.com/zard-ui/zardui
- https://github.com/siemens/element
- https://www.ag-grid.com/angular-data-grid/community-vs-enterprise/
- https://www.ag-grid.com/angular-data-grid/modules/
- https://www.ag-grid.com/angular-data-grid/licensing/
- https://www.ag-grid.com/angular-data-grid/infinite-scrolling/
- https://www.ag-grid.com/angular-data-grid/data-update-high-frequency/
- https://www.ag-grid.com/angular-data-grid/dom-virtualisation/
- https://www.ag-grid.com/angular-data-grid/compatibility/
- https://www.ag-grid.com/angular-data-grid/context-menu/
- https://www.ag-grid.com/angular-data-grid/theming/
- https://www.ag-grid.com/whats-new/
- https://cdn.jsdelivr.net/npm/ag-grid-community@36.2.0/dist/types/src/entities/gridOptions.d.ts
- https://tanstack.com/blog/announcing-tanstack-table-v9
- https://github.com/TanStack/table/blob/main/docs/framework/angular/quick-start.md
- https://github.com/TanStack/table/blob/main/docs/framework/angular/guide/virtualization.md
- https://github.com/TanStack/table/blob/main/docs/framework/angular/guide/cell-selection.md
- https://github.com/TanStack/virtual/tree/main/packages/angular-virtual
- https://registry.npmjs.org/@tanstack/angular-virtual
- https://github.com/siemens/ngx-datatable
- https://github.com/swimlane/ngx-datatable
- https://github.com/ghiscoding/slickgrid-universal
- https://github.com/ghiscoding/Angular-Slickgrid
- https://github.com/revolist/revogrid
- https://github.com/artem-mangilev/ngx-vflow
- https://github.com/Foblex/f-flow
- https://github.com/swimlane/ngx-graph
- https://github.com/cytoscape/cytoscape.js
- https://github.com/cytoscape/cytoscape.js/blob/unstable/documentation/md/performance.md
- https://blog.js.cytoscape.org/2025/01/13/webgl-preview/
- https://js.cytoscape.org/
- https://github.com/jacomyal/sigma.js/releases
- https://github.com/d3/d3
- https://github.com/kieler/elkjs/blob/master/package.json
- https://github.com/dagrejs/dagre
- https://bundlephobia.com/api/size?package=elkjs@0.12.0
- https://bundlephobia.com/api/size?package=codemirror@6.0.2
- https://bundlephobia.com/api/size?package=uplot@1.6.32
- https://github.com/microsoft/monaco-editor/blob/main/CHANGELOG.md
- https://github.com/microsoft/monaco-editor/blob/main/docs/integrate-esm.md
- https://data.jsdelivr.com/v1/packages/npm/monaco-editor@0.57.0?structure=flat
- https://github.com/miki995/ngx-monaco-editor-v2
- https://github.com/miki995/ngx-monaco-editor-v2/blob/master/projects/editor/src/lib/base-editor.ts
- https://github.com/cloudfoundry/stratos/pull/5651
- https://github.com/codemirror/dev
- https://github.com/acrodata/code-editor
- https://github.com/jsonnext/codemirror-json-schema
- https://github.com/leeoniya/uPlot
- https://github.com/xieziyu/ngx-echarts
- https://echarts.apache.org/handbook/en/basics/release-note/v6-feature
- https://github.com/valor-software/ng2-charts
- https://github.com/tradingview/lightweight-charts
- https://cdn.jsdelivr.net/npm/apexcharts@8.3.1/LICENSE.md
- https://github.com/TanStack/hotkeys
- https://github.com/jamiebuilds/tinykeys
- https://registry.npmjs.org/@ngneat/hotkeys
- https://github.com/ngxpert/cmdk
- https://github.com/angular-split/angular-split
- https://github.com/dockview/dockview
- https://dockview.dev/docs/overview/licence
- https://github.com/xtermjs/xterm.js/releases/tag/6.0.0
- https://github.com/jsverse/transloco
- https://github.com/ngx-translate/core
- https://github.com/lucide-icons/lucide/tree/main/packages/angular
- https://github.com/ng-icons/ng-icons
- https://registry.npmjs.org/@vscode/codicons
- https://github.com/jfcere/ngx-markdown
- https://registry.npmjs.org/ngx-sonner
- https://registry.npmjs.org/@storybook/angular-vite
- https://developer.mozilla.org/en-US/docs/Web/API/Keyboard/lock
- https://www.electronjs.org/docs/latest/tutorial/security
- https://www.electronjs.org/docs/latest/api/protocol
- https://www.electronjs.org/docs/latest/tutorial/context-isolation
- https://www.electronjs.org/docs/latest/api/utility-process
- https://www.electronjs.org/docs/latest/tutorial/message-ports
- https://www.electronjs.org/docs/latest/tutorial/electron-timelines
- https://releases.electronjs.org/releases.json
- https://github.com/bitwarden/clients
- https://github.com/mockoon/mockoon
- https://github.com/mockoon/mockoon/blob/main/packages/app/src/main/libs/main-window.ts
- https://github.com/altair-graphql/altair
- https://github.com/altair-graphql/altair/blob/master/packages/altair-electron/src/main/app/window.ts
- https://github.com/Eugeny/tabby
- https://playwright.dev/docs/api/class-electron
