// The AMQP 0-9-1 form: the `x-death` header, an array of tables, one per {queue, reason} pair, the
// pair that died last first (tap-streams-ops T3, mc_amqpl.erl `death_table`). `time` is the FIRST
// death of that pair in SECONDS (a timestamp); there is no last-time. `original-expiration` is a
// string of milliseconds, present when the message had a per-message TTL.
import type { DeathForm } from './entry.ts';

export const X_DEATH: DeathForm = {
  name: 'x-death',
  timeUnit: 'seconds',
  firstTime: 'time',
  lastTime: null,
  ttl: 'original-expiration',
};
