# S-14: AG Grid Community, engine-windowed infinite model (M0-53)

Record of spike S-14 so far. **It is partial: nothing here was measured in a real browser.** The browser numbers (scroll frame rate, heap after 100k rows, the run under the enforced S-04 policy) belong to the `perf:grid-100k` harness, which waits for the `perf` project (`apps/perf` does not exist yet; M0-53 spec Q-4, OQ-544). Until it runs, S-14 is not closed and the claims below stop where the tables say.

## What was verified, and what was not

| Verified (Node 24, jsdom, esbuild; commands below) | Not verified |
| --- | --- |
| The adapter creates AG Grid Community 36.2.0 with `createGrid` and an explicit list of nine Community modules; no `ag-grid-angular`. | AC-1: 55 fps or better and no main-thread task above 50 ms while scrolling 100k rows (needs a browser and a CDP trace). |
| Every block request starts on a multiple of 200 and asks for at most 200 rows, with at most two requests in flight and a wait queue capped at 25 blocks. | AC-4: heap after 300 random jumps at most 1.15 times the heap after the first five windows. |
| The sort model of the header reaches the source as `GridSort[]` and comes back in the published column state. | AC-16: zero CSP and Trusted Types violations under `require-trusted-types-for 'script'` and `style-src 'self' 'nonce-N'`. jsdom does not inject AG Grid's `<style>` elements, so only the option (`styleNonce`) is proved, not the effect. |
| A new source aborts the requests in flight, a late answer is dropped and counted, and no row of the old query is shown. | Whether AG Grid's infinite model keeps a selection across the eviction of a block (the adapter does not depend on it: it owns the selection set and mirrors it). |
| A block that rejects, or answers with more rows than its limit, fails whole; the status bar says so and Try again loads it. | The exact trace events for frame counting and long tasks in headless Chrome and Edge. |
| Live changes: visible ids are reported to the source; a change to a shown row is applied in place; a change to a row that is not shown is dropped and counted; a removed row reloads the blocks (not more than once in 5 s). | The list of English strings AG Grid writes itself (ARIA hints) and the adapter cannot translate (OQ-703). |
| Cells are text: a value with markup renders as text and is copied as the same text; no `innerHTML`, no string expressions, no font or other fetch. | Layout: row height and header height from the density token are set on the grid, but jsdom has no layout. |
| The density and theme tokens reach AG Grid through its theming API in one turn when `ThemeService.revision` changes. | Accessibility with axe (M0-60; OQ-553); the component specs assert roles, names, focus and the live region instead. |

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
```

`pnpm nx run perf:grid-100k` (AC-1, AC-4, AC-16) does not exist yet. A version bump of `ag-grid-community` re-runs it and `spikes-csp`.
