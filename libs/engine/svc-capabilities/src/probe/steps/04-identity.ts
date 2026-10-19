// Step 4, identity: `GET /api/whoami`. The tags drive every gate, so a login whose tags cannot be
// read has none (the profile then treats it as an ordinary user).
import { read } from '../read';
import { WhoamiSchema } from '../schemas';
import type { ProbeStep } from '../types';

export const identityStep: ProbeStep = {
  id: 'identity',
  async run(env, facts) {
    const who = await read(env, '/api/whoami', WhoamiSchema);
    facts.identity = {
      user: who.name.slice(0, 256),
      tags: who.tags.slice(0, 32),
    };
    return { status: 'ok', detail: `${String(who.tags.length)} tag(s)` };
  },
};
