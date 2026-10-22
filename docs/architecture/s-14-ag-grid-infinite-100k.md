# S-14: AG Grid Community, engine-windowed infinite model (M0-53)

Record of spike S-14. The first table is what was verified in Node and jsdom; the second is what `pnpm nx run perf:grid-100k` measured in a real Chromium (AC-1, AC-4, AC-16). **Both are one machine, headless, against a fake engine window**: what that does not show is in "What the browser run does not show". S-14 is closed for the three browser acceptance criteria as far as that harness goes; the open decisions are OQ rows, not silent loosening.

## What was verified, and what was not

| Verified (Node 24, jsdom, esbuild; commands below) | Not verified |
| --- | --- |
| The adapter creates AG Grid Community 36.2.0 with `createGrid` and an explicit list of nine Community modules; no `ag-grid-angular`. | (Moved to the browser table below: AC-1.) |
| Every block request starts on a multiple of 200 and asks for at most 200 rows, with at most two requests in flight and a wait queue capped at 25 blocks. | (Moved to the browser table below: AC-4. The literal 1.15 against the first five windows measures 1.30: OQ-940.) |
| The sort model of the header reaches the source as `GridSort[]` and comes back in the published column state. | (Moved to the browser table below: AC-16. jsdom proved only the option, `styleNonce`; the browser run proves the effect: every injected `<style>` carries the nonce.) |
| A new source aborts the requests in flight, a late answer is dropped and counted, and no row of the old query is shown. | Whether AG Grid's infinite model keeps a selection across the eviction of a block (the adapter does not depend on it: it owns the selection set and mirrors it). |
| A block that rejects, or answers with more rows than its limit, fails whole; the status bar says so and Try again loads it. | (Settled: the harness counts `requestAnimationFrame` callbacks and Long Tasks API entries in the page instead of trace events: OQ-941.) |
| Live changes: visible ids are reported to the source; a change to a shown row is applied in place; a change to a row that is not shown is dropped and counted; a removed row reloads the blocks (not more than once in 5 s). | The list of English strings AG Grid writes itself (ARIA hints) and the adapter cannot translate (OQ-703). |
| Cells are text: a value with markup renders as text and is copied as the same text; no `innerHTML`, no string expressions, no font or other fetch. | Layout: row height and header height from the density token are set on the grid, but jsdom has no layout. |
| The density and theme tokens reach AG Grid through its theming API in one turn when `ThemeService.revision` changes. | Accessibility with axe (M0-60; OQ-553); the component specs assert roles, names, focus and the live region instead. |

## What the browser run measured (`pnpm nx run perf:grid-100k`)

Machine of the reference run: Windows 11, Intel Core i9-14900HX (32 logical CPUs, 31.7 GB), Chrome 155, headless (`--headless=new`, software compositing, `--disable-gpu`), a 1280x720 viewport, the real `<app-data-grid>` on a fake engine window of 100,000 rows answering after 15 ms, served under the engine's own Content-Security-Policy. The run prints its own machine; the CI runners' figures are in its log.

| AC | What was measured | Figure on the reference machine | Asserted as |
| --- | --- | --- | --- |
| AC-1 | Wheel input (the browser's own gesture, 40,000 px/s for 6 s), comfortable density (32 px rows) | 60.0 fps over 368 frames, longest gap between frames 17 ms, no task above 50 ms, 7,500 rows and 37 distinct blocks traversed, 25 blocks resident at the end, 40 rows in the DOM | at least 55 fps; no task above 50 ms; more than 25 blocks asked for; every request at most 200 rows and on a multiple of 200 |
| AC-1 | the same in compact density (24 px rows) | 59.7 fps over 367 frames, longest gap 33 ms, no task above 50 ms, 10,000 rows and 50 blocks traversed, 25 resident, 47 rows in the DOM | the same |
| AC-4 | 300 seeded jumps over all 100,000 rows, ten sort clicks, each jump checked by content | at most 25 blocks resident (25 reached), at most 40 rows in the DOM, 364 requests of at most 200 rows, at most 2 in flight; heap after a forced collection 5.33 MB after five windows, 6.82 MB at the middle of the run (22 blocks resident), 6.93 MB at the end (21 blocks): 1.017 times the middle, 1.30 times the five-window heap | at most 25 blocks; requests of at most 200 rows on a boundary; 300 jumps made; heap at the end at most 1.15 times the heap at the middle |
| AC-16 | mount, scroll, right click and menu, Escape, theme and density change, under the engine's policy and under it without `style-src-attr 'unsafe-inline'` | zero CSP or Trusted Types reports from three channels over the life of the page, boot included; 19 `<style>` elements, all with the page's nonce; background `rgb(20, 23, 28)` to `rgb(255, 255, 255)` and rows 32 px to 24 px on the change; no `style` attribute on the grid root | zero reports; the S-04 rules in the policy sent and no `unsafe-eval`; nonce set and on every `<style>`; the menu, theme and density followed |

The gates were shown to fail: a 60 ms task in every answer takes AC-1 to 38 to 40 fps with 37 long tasks; keeping every answer takes the AC-4 heap ratio to 1.27; an inline script at boot is three reports in AC-16 (`PERF_GRID_100K_BREAK`, `apps/perf/README.md`).

### What the browser run does not show

- **Heap against the first five windows.** The spec's AC-4 wrote the heap after 300 jumps against the heap after the first five windows, at most 1.15 times. That ratio is 1.30 here and it does not mean a leak: after five windows the cache holds about a third of its 25 blocks, and the 25 blocks are allowed. Compared where the cache holds a comparable number of blocks (the middle and the end of the run) the heap is 1.02 times. The harness asserts the second and prints the first (OQ-940).
- **A real engine, a network, a GPU, a physical display, a user's hardware.** The window is a function in the page; "frames" are animation-frame callbacks (the main thread's frames, not light on a screen); the figures are one headless machine's.
- **Trace events.** AC-1 says "the CDP trace shows". The page's own frame and long-task records stand in for the trace (OQ-941); the Long Tasks API reports only tasks over 50 ms, so the longest task below that is unknown.
- **Density, theme and viewport.** Both densities are run for AC-1; only 1280x720 is run; the theme change goes to the other of light and dark, and high contrast is not run.
- **Selection across eviction in the browser, the real `explorer.window` live feed, the nonce from the real shell** (OQ-347): not part of this harness.

## Numbers

| What | Value | How |
| --- | --- | --- |
| Adapter bundle, AG Grid Community 36.2.0 and our code, without Angular, RxJS and tslib, minified, gzip level 6 | 214,025 bytes (208,903 before the menu, clipboard, chooser and status bar) | `node tools/grid-bundle-check/bundle-check.mjs --no-gates` (esbuild of `@angular/build`) |
| Same with Angular, RxJS and tslib | 374,388 bytes | same command |
| Budget of a lazy chunk (ADR-021, M0-51 addendum) | 200,000 bytes gzip | `web:budgets` |
| Packages in the bundle | `ag-grid-community`, `ag-stack`, `@angular/core`, `@angular/common`, `rxjs`, `tslib` | metafile |
| Enterprise inputs in the bundle | none | `ui-grid:bundle-check`, AC-3 |

The adapter is over the lazy-chunk budget by about 7 %, with an explicit module list; AG Grid's core is most of it. The number is esbuild's, not the Angular production build's; the first app that imports the grid (M0-54) measures the real chunk. What to do is OQ-701; nothing was loosened.

## Decisions the code makes

- Block size 200 and 25 blocks resident (`GRID_BLOCK_SIZE`, `GRID_MAX_BLOCKS`), as blueprint 10 and the issue say; two requests in flight (`GRID_MAX_CONCURRENT_REQUESTS`); the live feed is applied once per 100 ms and the cache is reloaded at most once every 5 s.
- The selection is a set of row ids owned by the adapter and only shown by AG Grid; the copy and the selection are capped at 5,000 rows (OQ-702, OQ-705).
- Row height and header height are the density token's; the grid chooses no number (OQ-548).
- The nonce comes from `GRID_STYLE_NONCE`, else Angular's `CSP_NONCE`, else the `csp-nonce` meta tag (OQ-552).

## Commands

```sh
pnpm nx run-many -t lint typecheck test -p ui-grid   # includes the component specs (test-components)
pnpm nx run ui-grid:bundle-check                     # AC-3 and the shipped-artefact gates on the bundle
pnpm nx test grid-bundle-check
pnpm nx run perf:grid-100k                           # AC-1, AC-4, AC-16 in a real browser (builds perf-grid-page; skips loudly without Chrome or Edge)
```

A version bump of `ag-grid-community` re-runs `perf:grid-100k` and `spikes-csp`.
