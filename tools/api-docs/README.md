# api-docs

Writes `docs/api/{openapi,asyncapi}.v1.json` from the `@app/contracts` registry, or checks that the committed files are current (M0-10, ADR-003). It is a separate project because `@app/contracts` is isomorphic and may not touch the file system.

```
pnpm nx run contracts:api-docs         # write
pnpm nx run contracts:api-docs-check   # fail on drift (also runs in CI)
```

`register.mjs` lets Node resolve the `@app/contracts` path alias, so the script runs on the TypeScript sources directly (Node type stripping): `node --import ./tools/api-docs/register.mjs tools/api-docs/emit-specs.ts [--check] [--out=<dir>]`.

Proof: `pnpm nx test api-docs` runs the real command against temporary directories and against `docs/api`.
