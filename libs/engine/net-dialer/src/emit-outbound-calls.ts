// Writes the docs page of outbound calls from the purpose registry, or with --check fails when the
// committed page differs (the drift gate behind `nx run net-dialer:outbound-calls-check`).
//   node libs/engine/net-dialer/src/emit-outbound-calls.ts [--check] [--out=<file>]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { renderOutboundCallsPage } from './outbound-calls-page.ts';
import { PURPOSES } from './purposes.ts';

const DEFAULT_OUT = 'apps/docs/src/content/docs/security/outbound-calls.md';

const args = process.argv.slice(2);
const check = args.includes('--check');
const out = resolve(
  args.find((arg) => arg.startsWith('--out='))?.slice('--out='.length) ??
    DEFAULT_OUT,
);
const page = renderOutboundCallsPage(PURPOSES);

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

if (check) {
  if (read(out) === page) {
    console.log(
      `outbound-calls-check: ${String(PURPOSES.length)} purposes, the page is up to date.`,
    );
  } else {
    console.error(
      `outbound-calls-check: ${out} no longer matches the Dialer purpose registry.\n` +
        'Run `pnpm nx run net-dialer:outbound-calls` and commit the result.',
    );
    process.exitCode = 1;
  }
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, page);
  console.log(`outbound-calls: wrote ${out}`);
}
