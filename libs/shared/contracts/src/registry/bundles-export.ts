// bundles.export: connection profiles as a document that carries no secret.
import { z } from 'zod';

import { ConnectionIdSchema } from '../brands.ts';
import { defineAction } from '../kit/define-action.ts';
import {
  CONNECTIONS_PER_PRINCIPAL_MAX,
  ConnectionBundleSchema,
} from './connections.ts';

export const BundlesExportInputSchema = z.strictObject({
  /** The profiles to export; every profile the caller can see when it is left out. */
  connectionIds: z
    .array(ConnectionIdSchema)
    .min(1)
    .max(CONNECTIONS_PER_PRINCIPAL_MAX)
    .optional(),
});

export const BundlesExportOutputSchema = z.strictObject({
  bundle: ConnectionBundleSchema,
});

export const bundlesExport = defineAction({
  id: 'bundles.export',
  kind: 'query',
  summary: 'Export connection profiles as a bundle without any secret',
  input: BundlesExportInputSchema,
  output: BundlesExportOutputSchema,
  permission: 'connection.export',
  risk: 'none',
  planning: 'none',
  // It reads stored profiles and writes nothing, but who exported what is worth knowing.
  audit: 'outcome',
  target: () => ({}),
  http: { method: 'POST', path: '/bundles/export' },
  since: '1.0',
});
