// probe.run: Probe the broker with management reads and cache its BrokerProfile
import { z } from 'zod';

import { ConnectionIdSchema } from '../brands.ts';
import { defineAction } from '../kit/define-action.ts';

export const ProbeRunInputSchema = z.strictObject({
  cid: ConnectionIdSchema,
});

/** The twelve steps of the probe, in the order they run (fact sheet j.2). */
export const PROBE_STEP_IDS = [
  'tls',
  'host-fingerprint',
  'oauth-discovery',
  'identity',
  'overview',
  'extensions',
  'nodes',
  'feature-flags',
  'vendor-fingerprints',
  'exchanges',
  'prometheus',
  'amqp-handshake',
] as const;

/**
 * How one step went. `ok`: it answered. `unavailable`: the broker or the user's role has no such
 * endpoint (404, 401, 403, a plugin that is not there): a normal answer, the fact stays unknown.
 * `failed`: it should have answered and did not. `skipped`: it did not apply.
 */
export const ProbeStepSchema = z.strictObject({
  id: z.enum(PROBE_STEP_IDS),
  status: z.enum(['ok', 'unavailable', 'failed', 'skipped']),
  /** Safe text: a reason or a count, never the broker's own words, a URL or a credential. */
  detail: z.string().max(200).optional(),
});

export const ProbeRunOutputSchema = z.strictObject({
  /** The BrokerProfile just cached; see `ProfileGetOutputSchema` for why it is `unknown`. */
  profile: z.unknown(),
  /** False when the fingerprint is the one that was cached before. */
  changed: z.boolean(),
  steps: z.array(ProbeStepSchema).max(PROBE_STEP_IDS.length),
});

export const probeRun = defineAction({
  id: 'probe.run',
  kind: 'query',
  summary: 'Probe the broker with management reads and cache its BrokerProfile',
  input: ProbeRunInputSchema,
  output: ProbeRunOutputSchema,
  permission: 'connection.manage',
  risk: 'none',
  planning: 'none',
  // It reads the broker with the stored credential, so the outcome is recorded; it changes nothing
  // the broker keeps, and the cache it refreshes is derived data (OQ-470).
  audit: 'outcome',
  target: (input) => ({ connectionId: input.cid }),
  // POST because it does work and refreshes the cache; the body is empty.
  http: { method: 'POST', path: '/connections/{cid}/probe' },
  since: '1.0',
});
