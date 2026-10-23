// The AMQP 1.0 form: the `x-opt-deaths` message annotation, an array of maps with symbol keys,
// the pair that died last first (tap-streams-ops T3, mc_amqp.erl `encode_deaths`). `first-time` and
// `last-time` are timestamps in MILLISECONDS; `ttl` is the per-message TTL in milliseconds
// (optional). A 0-9-1 consumer sees the same record as an `x-death` header.
import type { DeathForm } from './entry.ts';

export const X_OPT_DEATHS: DeathForm = {
  name: 'x-opt-deaths',
  timeUnit: 'ms',
  firstTime: 'first-time',
  lastTime: 'last-time',
  ttl: 'ttl',
};
