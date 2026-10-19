# ui-design

Design tokens, themes, the ThemeService and the three safety components every feature uses (blueprint 10, M0-50): `<app-gated>`, `<app-env-chrome>` and `<app-verification-banner>`. This library is trust-critical: a safety cue that fails open (a gate that looks enabled, a prod connection that looks like dev, an unverified broker with no banner) is a defect here, not in the feature that uses it.

Tags: `type:ui-design`, `runtime:browser`, `trust:critical`. May import `@app/contracts` and `@app/domain-model` (types only). It imports no other UI library, no Transloco and no engine code.

## Public API

- **`ThemeService`** (`theme.service.ts`): `preference` (`system`, `light`, `dark`, `high-contrast`), `density` (`comfortable`, `compact`), `resolved` (what is shown), `setPreference`, `setDensity` (both throw on an unknown value), `token('--ds-...')` (the current value of a design token, for widgets that cannot read CSS), `revision` (counts applications, so a grid, editor or chart re-reads its tokens). It writes `data-theme` and `data-density` on the root element and nothing else, so it works under the strict CSP. The choice is remembered through `THEME_STORAGE`; `MATCH_MEDIA` is the seam for `prefers-color-scheme`, `prefers-contrast` and `forced-colors`. Also `THEME_PREFERENCES`, `DENSITIES`, `isThemePreference`, `isDensity`, `THEME_STORAGE_KEYS`.
- **`provideDesignSystem()`**: creates the ThemeService in an app initializer, so the stored theme is on the page before the first paint.
- **`<app-gated [gate] [labels] (activated)>`** (`components/gated`): a control whose availability the engine decided. `gate` is the `GateDecision` the engine sent. Only `enabled: true` lets the control work; `null`, `undefined`, a missing or non-boolean `enabled` are a closed gate. Closed means: `aria-disabled` (the button stays focusable), no `activated`, and the click is stopped in the capture phase before any `(click)` listener on `<app-gated>` or an ancestor, so `(activated)` is the only supported hook. The reason (or `labels.noReason`) and the source are always visible text in a polite live region that the button names through `aria-describedby`. A source is a link only when it is an absolute `https:` URL without credentials (`parseSourceLink`); anything else is plain text. The link opens with `target="_blank" rel="noopener noreferrer"` and shows the punycode host. A degraded gate (`mode: 'degraded'`) works and shows its reason.
- **`<app-env-chrome [environment] [labels] [detail]>`** (`components/env-chrome`): the environment class as text and colour. An unset, null or unknown class is shown as `prod` (`normalizeEnv`), the engine's own reading of an unset class. `ENV_CLASSES`, `EnvLabels`.
- **`<app-verification-banner [verification] [labels] [detail]>`** (`components/verification-banner`): nothing for `verified`, a status banner for the other states. An unset or unknown state is an unknown build (`normalizeVerification`), the strongest banner. `VERIFICATION_STATES`, `VerificationLabels`.
- **Style entry points** (not exported from `index.ts`; imported by path from the app stylesheet): `src/tokens.css` (all tokens, three themes, two densities, reduced motion) and `src/tailwind-preset.css` (a Tailwind 4 `@theme inline` mapping onto them; not compiled in this repository yet, see OQ-340).

Components take their words as inputs (`labels`, `detail`) already translated: this library has no Transloco and no copy. Reason, source and detail are engine data and are rendered as text only.

## Tokens

Every token is `--ds-*`. Themes are `data-theme="light|dark|high-contrast"` on the root element; density is `data-density="comfortable|compact"`. `tokens.spec.ts` holds the file to these rules, found by naming convention so a token added later is checked automatically:

- Every theme sets exactly the same colour tokens, as plain hex values.
- Each `--ds-color-text*` reads at 4.5:1 or better on each `--ds-color-surface*`, and each `--ds-color-on-X` on `--ds-color-X`; high contrast reaches 7:1 for all of them.
- `--ds-color-border-strong` and `--ds-color-focus-ring` reach 3:1 on every surface (7:1 in high contrast).
- Comfortable density keeps every `--ds-target-*` size and the row height at 24 px or more; compact (opt-in) keeps rows at 22 to 24 px, type at 12 to 13 px and targets at 24 px.

## Invariants

- Fail closed: a missing or malformed gate, environment or verification never looks safer than the strictest reading (`gated.spec.ts`, `env-chrome.spec.ts`, `verification-banner.spec.ts`).
- The UI never computes authorisation: the gate is rendered as sent; nothing here decides what is allowed.
- No `innerHTML`, no `bypassSecurityTrust*`, no inline style from data: engine text is interpolated as text, and the ThemeService sets only two attributes (ADR-021, the CSP of blueprint 14).
- Dependencies follow the type:ui-design row of blueprint 2.2; `pnpm nx lint ui-design` enforces them.
- Copy lives in i18n files, never in templates (`@app/ui-no-raw-template-text`).

## Not here yet

Spartan brain and helm copies, the `@angular/aria` wrappers, Tailwind itself and Lucide are scoped by M0-50 but need packages that are not in the catalog and allow-list yet (OQ-340). The `@gallery` Playwright spec waits for `apps/e2e-web` (M0-60); until then the gallery is covered by component tests and `web-gallery-check`.

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p ui-design     # test runs test-components first
pnpm nx run web-gallery-check:gallery-absent             # the gallery is not in a production build
```

`test` runs the token, theme and API specs in Vitest (`vitest.config.mts`, which reads the CSS files as text); `test-components` runs the component specs through the Angular builder (`@angular/build:unit-test`), because signal inputs need the AOT compile.
