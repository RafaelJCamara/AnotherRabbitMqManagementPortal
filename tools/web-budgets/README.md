# web-budgets

Bundle budgets for the web app, measured on the gzip size of a production build (M0-51, AC-3; ADR-021). Tags: `type:tooling`, `runtime:node`. Plain Node, no dependencies.

## What it checks

`check-budgets.mjs <browser-dir>` reads `index.html` of the build output and:

- sums the gzip size of every script, modulepreload and stylesheet that `index.html` loads from its own origin (the "initial" bundle) and fails above `INITIAL_LIMIT` (350 000 bytes; 1 kB is 1 000 bytes);
- compares every other script or stylesheet in the output (a lazy chunk) with `LAZY_LIMIT` (200 000 bytes gzip), except a chunk that contains AG Grid's own class name (`ag-root-wrapper`), which has its own ceiling in `LAZY_EXCEPTIONS` (240 000 bytes gzip; ADR-021 addendum, M0-54, OQ-757);
- fails when it sees nothing: no `index.html`, no referenced script, or a reference to a file that is not in the output. A scan that sees nothing proves nothing.

Gzip level is 6 (the zlib default). The Angular raw-size `budgets` in `apps/web/project.json` stay as a coarse backstop. The numbers and the method are working defaults, see OQ-534.

## Proof commands

| Command                       | What it proves                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm nx test web-budgets`    | The measurement: limit edge, lazy chunks, reference parsing, empty and broken outputs.                      |
| `pnpm nx run web:budgets`     | Builds `web` for production, then measures `dist/apps/web/browser` against the limits.                      |
