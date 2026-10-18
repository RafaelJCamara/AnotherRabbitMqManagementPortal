// Lets Node resolve the `@app/*` path aliases of tsconfig.base.json when it runs TypeScript sources
// directly (Node type stripping, no bundler):
//   node --import ./tools/semantics-audit/register.mjs tools/semantics-audit/audit-cells.ts
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const root = new URL('../../', import.meta.url);
const base = JSON.parse(
  readFileSync(new URL('tsconfig.base.json', root), 'utf8'),
);
const aliases = new Map(
  Object.entries(base.compilerOptions.paths)
    .filter(([alias]) => alias.startsWith('@app/'))
    .map(([alias, [target]]) => [alias, new URL(target, root).href]),
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = aliases.get(specifier);
    return url === undefined
      ? nextResolve(specifier, context)
      : { url, shortCircuit: true };
  },
});
