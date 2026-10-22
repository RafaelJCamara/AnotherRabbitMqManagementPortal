// Test support for the apps that mount the connections feature: its English file with every text replaced by
// `[[connections.<path>]]`, so a spec of the shell can see which key a view asked for without the feature's
// words. Imported as `@app/feature-connections/testing`; never part of the production API.
import type { Translation } from '@jsverse/transloco';

function mark(tree: Translation, path: string): Translation {
  const out: Translation = {};
  for (const [name, value] of Object.entries(tree)) {
    const here = `${path}.${name}`;
    out[name] =
      typeof value === 'string'
        ? `[[${here}]]`
        : mark(value as Translation, here);
  }
  return out;
}

/** The loader to provide as `CONNECTIONS_SCOPE_LOADER` in a spec. */
export function markedConnectionsScope(): Promise<Translation> {
  return import('./i18n/en.json').then((m) => mark(m.default, 'connections'));
}
