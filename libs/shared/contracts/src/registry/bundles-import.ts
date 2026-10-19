// bundles.import: create the profiles of a bundle. A bundle holds no secret, so each imported
// profile has its credentials unset until the person enters them (connections.update).
import { z } from 'zod';

import { ConnectionIdSchema } from '../brands.ts';
import { defineAction } from '../kit/define-action.ts';
import {
  CONNECTIONS_PER_PRINCIPAL_MAX,
  ConnectionBundleSchema,
  ConnectionNameSchema,
} from './connections.ts';

export const BundlesImportInputSchema = z.strictObject({
  bundle: ConnectionBundleSchema,
  /** What to do with a profile whose name the caller already uses: leave it (`skip`) or add ` (2)`. */
  onConflict: z.enum(['skip', 'rename']).optional(),
});

export const BundlesImportOutputSchema = z.strictObject({
  created: z
    .array(
      z.strictObject({ id: ConnectionIdSchema, name: ConnectionNameSchema }),
    )
    .max(CONNECTIONS_PER_PRINCIPAL_MAX),
  skipped: z
    .array(
      z.strictObject({
        name: ConnectionNameSchema,
        reason: z.literal('name-exists'),
      }),
    )
    .max(CONNECTIONS_PER_PRINCIPAL_MAX),
});

export const bundlesImport = defineAction({
  id: 'bundles.import',
  kind: 'command',
  summary:
    'Import the profiles of a bundle; their secrets are entered afterwards',
  input: BundlesImportInputSchema,
  output: BundlesImportOutputSchema,
  permission: 'connection.manage',
  risk: 'low',
  planning: 'none',
  audit: 'attempt+outcome',
  target: () => ({}),
  http: { method: 'POST', path: '/bundles/import' },
  since: '1.0',
});
