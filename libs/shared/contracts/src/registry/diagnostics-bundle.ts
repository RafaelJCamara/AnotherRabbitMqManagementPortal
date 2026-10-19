// diagnostics.bundle: Write a redacted local diagnostics bundle to a file the person chose.
// The bundle never crosses the port: the engine writes it to the file behind `fileToken` (the
// opaque token `PlatformBridge.pickSaveTarget` returns, blueprint 3.3), and the answer describes
// what was written, not its content.
import { z } from 'zod';

import { defineAction } from '../kit/define-action.ts';

/** The most recent log lines a bundle may carry. */
export const DIAGNOSTICS_LOG_LINES_MAX = 5000;

/** An opaque save-target token: unguessable text, never a path. */
export const FileTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);

/** What a bundle section holds; one entry of `sections` per section that was written. */
export const DiagnosticsSectionIdSchema = z.enum([
  'versions',
  'logs',
  'profiles',
  'audit',
]);

/** Sections the bundle cannot carry yet; they are named, never left out silently (I-13). */
export const DiagnosticsOmittedIdSchema = z.enum(['receipts', 'incidents']);

export const DiagnosticsBundleInputSchema = z.strictObject({
  fileToken: FileTokenSchema,
  /** At most this many of the newest log lines (default 1000). */
  logLines: z.number().int().min(0).max(DIAGNOSTICS_LOG_LINES_MAX).optional(),
});

export const DiagnosticsBundleOutputSchema = z.strictObject({
  /** Size of the file written. */
  bytes: z.number().int().nonnegative(),
  /** SHA-256 of the file written, lower-case hex. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sections: z
    .array(
      z.strictObject({
        id: DiagnosticsSectionIdSchema,
        /** How many entries the section holds. */
        items: z.number().int().nonnegative(),
        /** True when the section holds fewer entries than the source had (a cap, or a ring that dropped). */
        truncated: z.boolean(),
      }),
    )
    .max(16),
  omitted: z
    .array(
      z.strictObject({
        id: DiagnosticsOmittedIdSchema,
        reason: z.string().max(200),
      }),
    )
    .max(16),
});

export type DiagnosticsBundleOutput = z.infer<
  typeof DiagnosticsBundleOutputSchema
>;

export const diagnosticsBundle = defineAction({
  id: 'diagnostics.bundle',
  // A query, not a command (OQ-402): it changes nothing the engine or a broker keeps, it writes a
  // derived file to a target the person chose, and it is audited like a command. As a command it would
  // be locked by the prod lock with no connection to arm (OQ-380).
  kind: 'query',
  summary:
    'Write a redacted local diagnostics bundle to a file the person chose',
  input: DiagnosticsBundleInputSchema,
  output: DiagnosticsBundleOutputSchema,
  permission: 'diagnostics.export',
  risk: 'low',
  planning: 'none',
  audit: 'attempt+outcome',
  target: () => ({}),
  http: { method: 'POST', path: '/diagnostics/bundle' },
  since: '1.0',
});
