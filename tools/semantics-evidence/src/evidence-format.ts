// How the check reads an evidence artefact (`testing/lab-evidence/<broker-version>/<CF-id>.json`).
//
// This is a second, independent reader of the format the recorder writes
// (apps/conformance/src/record/evidence.ts). It is not imported from there on purpose: an
// application cannot be imported by a library (Nx boundaries), and a check that shares the
// recorder's code would share its bugs. `apps/conformance/src/assert/format-parity.spec.ts` proves
// both readers accept the same artefacts and refuse the same edits, so they cannot drift apart.
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const json: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(json),
    z.record(z.string(), json),
  ]),
);

const count = z.number().int().nonnegative().nullable();
const GIT_SHA = /^[0-9a-f]{40}$/;
const RUN_URL =
  /^https:\/\/[^/\s@]+\/[^/\s]+\/[^/\s]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/;

const step = z.strictObject({
  index: z.number().int().nonnegative(),
  op: z.string().min(1),
  args: z.record(z.string(), json),
  result: z.record(z.string(), json),
});

const observation = z.strictObject({
  name: z.string().min(1),
  messageId: z.string().min(1),
  survived: z.boolean(),
  position: count,
  redelivered: z.boolean().nullable(),
  'x-delivery-count': count,
  'x-acquired-count': count,
});

const ciProvenance = z.strictObject({
  kind: z.literal('ci'),
  recorder: z.literal('conformance:record'),
  gitSha: z.string().regex(GIT_SHA),
  runUrl: z.string().regex(RUN_URL),
  workflow: z.string().min(1),
  recordedAt: z.iso.datetime(),
});

const provenance = z.discriminatedUnion('kind', [
  ciProvenance,
  z.strictObject({
    kind: z.literal('local'),
    recorder: z.literal('conformance:record'),
    gitSha: z.string().regex(GIT_SHA).nullable(),
    recordedAt: z.iso.datetime(),
  }),
]);

const body = z.strictObject({
  schemaVersion: z.literal(1),
  cfId: z.string().regex(/^CF-[A-Z0-9]+(?:-[A-Z0-9]+)*$/),
  title: z.string().min(1),
  protocol: z.enum(['amqp091', 'amqp10', 'http']),
  brokerVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  steps: z.array(step),
  observations: z.array(observation),
  provenance,
});

const artefact = body.extend({
  integrity: z.strictObject({
    algorithm: z.literal('sha256'),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});

export type Evidence = z.infer<typeof artefact>;
export type CiProvenance = z.infer<typeof ciProvenance>;

export class EvidenceFormatError extends Error {
  readonly code: 'malformed' | 'tampered' | 'misplaced';
  constructor(code: EvidenceFormatError['code'], message: string) {
    super(message);
    this.name = 'EvidenceFormatError';
    this.code = code;
  }
}

/** JSON with sorted keys and no whitespace: the same value always gives the same bytes. */
export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new EvidenceFormatError('malformed', 'a number is not finite');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new EvidenceFormatError('malformed', `${typeof value} is not JSON`);
}

export const digestOf = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

/**
 * Parses the text of an evidence file: it must be valid JSON of exactly the artefact shape, its
 * digest must match its content, and it must sit where its own content says (`<version>/<CF>.json`).
 */
export function parseEvidence(relativePath: string, text: string): Evidence {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new EvidenceFormatError('malformed', 'not valid JSON');
  }
  const parsed = artefact.safeParse(value);
  if (!parsed.success) {
    throw new EvidenceFormatError('malformed', parsed.error.message);
  }
  const { integrity, ...rest } = parsed.data;
  const expected = Buffer.from(digestOf(rest), 'hex');
  const claimed = Buffer.from(integrity.digest, 'hex');
  if (
    expected.length !== claimed.length ||
    !timingSafeEqual(expected, claimed)
  ) {
    throw new EvidenceFormatError(
      'tampered',
      'the integrity digest does not match the content',
    );
  }
  const home = `${parsed.data.brokerVersion}/${parsed.data.cfId}.json`;
  if (relativePath.replaceAll('\\', '/') !== home) {
    throw new EvidenceFormatError(
      'misplaced',
      `the file holds the evidence of ${home}`,
    );
  }
  return parsed.data;
}
