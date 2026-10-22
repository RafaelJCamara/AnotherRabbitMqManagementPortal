# ui-commands

The command registry of the web app (M1-41, EXP-04): typed commands with contexts and engine-sent gates, the keymap with the overrides the engine keeps, the command palette, the shortcut cheat sheet and the native menu model. Working spec: [docs/specs/M1-41.md](../../../docs/specs/M1-41.md).

Tags: `type:ui-lib`, `runtime:browser`. Import it as `@app/ui-commands`. A feature registers its own commands with `registerCommands([...])`; it never imports another feature.

## Public API

- `CommandRegistry` (`register`, `registerSource`, `commands`, `conflicts`, `bindings`, `execute`), `registerCommands(defs)` (ties a page's commands to its injection context), `CommandDefinition`, `ListedCommand`, `Keymap`, `COMMAND_ID`, `COMMAND_PLATFORM`.
- `CommandContext` (`get`, `set`, `delete`, `provide`, `bind`): the context keys that `when` reads.
- Availability: `COMMAND_CAPABILITIES` (a signal the app fills from the engine's broker profile), `availabilityOf`, `CapabilitySnapshot`, `DisabledReason`. The UI looks a name up in what the engine sent; it computes no authorisation.
- Chords: `parseChord`, `canonicalChord`, `formatChord`, `displayChord`, `acceleratorOf`, `matchesChord`, `physicalChord`. Reserved chords: `RESERVED_CHORDS`, `reservedReason`, `reservedCollisions`.
- Keymap rules (plain functions): `defaultChords`, `effectiveChords`, `findConflicts`, `bindingTable`, `blockedChords`, `planAssign`, `withUnbound`, `withoutOverride`.
- `rankCommands(query, items, limit)`: the palette's fuzzy ranking with highlight ranges (`toRanges`, `PALETTE_LIMIT`).
- `buildMenuModel(commands, describe)` and `syncNativeMenu(host, model)`: the typed menu model for the desktop shell; the browser never calls the sync.
- `Announcer`: what the system says in the polite live region (a closed command, a failure, a conflict).
- `CommandHost` (`<app-command-host />`, mounted once at the root of the app): the keyboard dispatcher, the live region, the keymap load, and the lazy palette and cheat sheet. `PaletteControl` opens and closes them and remembers where focus goes back to.
- `KeymapStore`: loads the overrides with `keybindings.get`, saves the whole document with `keybindings.put` after `KEYMAP_SAVE_DELAY_MS`, keeps a failed load or save as received (`loadStatus`, `saveStatus`, `loadError`, `saveError`) and offers `assign`, `unbind`, `useDefault`, `resetAll`, `flush`, `retry`.
- Translation: the scope `palette` (`PALETTE_SCOPE`, `providePaletteScope()`, `PALETTE_SCOPE_LOADER`) and `scopedText(scope, key)`, which turns a scope key into the text a command title holds; `describeReason(reason, t)` writes why a command is closed; `COMMAND_TIMER` is the clock a spec replaces.

## Invariants

- Dependencies follow the type:ui-lib row of blueprint 2.2; `pnpm nx lint ui-commands` enforces them.
- Copy lives in i18n files, never in templates (`@app/ui-no-raw-template-text`).
- A closed command never runs; its reason (the engine's, as sent) is announced. Nothing is silent (I-13).
- A chord in conflict, or a reserved chord, is bound to nothing. A default binding on a reserved chord is a defect.
- No dependency was added: the chord parser is our own (OQ-824).

## Proof commands

```sh
pnpm nx run-many -t lint typecheck test -p ui-commands
```
