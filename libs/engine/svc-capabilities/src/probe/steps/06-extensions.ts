// Step 6, extensions: `GET /api/extensions` lists the management scripts of the enabled plugins
// (`shovel.js`, `federation.js`, `stream.js`, `tracing.js`...). `[]` means LavinMQ or a minimal broker.
import { read } from '../read';
import { ExtensionsSchema } from '../schemas';
import type { ProbeStep } from '../types';

const MAX_EXTENSIONS = 200;
const MAX_NAME = 128;

export const extensionsStep: ProbeStep = {
  id: 'extensions',
  async run(env, facts) {
    const answer = await read(env, '/api/extensions', ExtensionsSchema);
    const names = new Set<string>();
    for (const entry of answer) {
      if (Array.isArray(entry)) continue;
      const scripts =
        typeof entry.javascript === 'string'
          ? [entry.javascript]
          : entry.javascript;
      for (const script of scripts) names.add(script.slice(0, MAX_NAME));
    }
    facts.extensions = [...names].sort().slice(0, MAX_EXTENSIONS);
    return {
      status: 'ok',
      detail: `${String(facts.extensions.length)} script(s)`,
    };
  },
};
