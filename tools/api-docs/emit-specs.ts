// Writes docs/api/{openapi,asyncapi}.v1.json from the contract registry, or with --check fails when
// the committed files differ (the drift gate behind `nx run contracts:api-docs-check`).
//   node --import ./tools/api-docs/register.mjs tools/api-docs/emit-specs.ts [--check] [--out=docs/api]
// Lives outside @app/contracts because that library is isomorphic and may not touch `node:fs`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { emitSpecs, registry } from '@app/contracts';

const args = process.argv.slice(2);
const check = args.includes('--check');
const out = resolve(
  args.find((arg) => arg.startsWith('--out='))?.slice('--out='.length) ??
    'docs/api',
);

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

const specs = emitSpecs(registry);

if (check) {
  const drifted = Object.entries(specs)
    .filter(([name, content]) => read(join(out, name)) !== content)
    .map(([name]) => name);
  if (drifted.length > 0) {
    console.error(
      `api-docs-check: ${drifted.join(', ')} in ${out} no longer match the contract registry.\n` +
        'Run `pnpm nx run contracts:api-docs` and commit the result.',
    );
    process.exitCode = 1;
  } else {
    console.log(
      `api-docs-check: ${String(Object.keys(specs).length)} specs are up to date.`,
    );
  }
} else {
  mkdirSync(out, { recursive: true });
  for (const [name, content] of Object.entries(specs)) {
    writeFileSync(join(out, name), content);
    console.log(`api-docs: wrote ${join(out, name)}`);
  }
}
