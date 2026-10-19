// The evidence artefact (M0-15, blueprint 5.2): what one lab scenario observed on one broker
// version, in the form `testing/lab-evidence/<broker-version>/<CF-id>.json` keeps it.
//
// Evidence is recorded independently of the semantics registry (ADR-007): this file, and everything
// in src/record, imports nothing from @app/semantics (arch test, AC-2). It is tamper-evident: the
// artefact carries a SHA-256 over its own canonical JSON, so an edit by hand (a flipped
// `redelivered`, a swapped digest, a file copied under another version) no longer verifies. The
// digest cannot stop someone who recomputes it; the control for that is the bot pull request, the
// human approval and the run URL in the provenance stamp (amendment A-20).
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** Changes whenever a field is added, renamed or loses a meaning. */
export const EVIDENCE_SCHEMA_VERSION = 1;

export const CF_ID = /^CF-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
export const BROKER_VERSION = /^\d+\.\d+\.\d+$/;
export const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const RUN_URL =
  /^https:\/\/[^/\s@]+\/[^/\s]+\/[^/\s]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/;

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

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

/** One operation of the scenario, as it ran: what was asked and what the broker answered. */
const step = z
  .object({
    index: z.number().int().nonnegative(),
    op: z.string().min(1),
    args: z.record(z.string(), json),
    result: z.record(z.string(), json),
  })
  .strict();

/**
 * What the queue held after the scenario, one entry per message it published. `position` is the
 * place in the drain order (0 is the head); `survived` is false when the message was not found.
 */
const observation = z
  .object({
    name: z.string().min(1),
    messageId: z.string().min(1),
    survived: z.boolean(),
    position: count,
    redelivered: z.boolean().nullable(),
    'x-delivery-count': count,
    'x-acquired-count': count,
  })
  .strict();

const recordedAt = z.iso.datetime();

const provenance = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ci'),
      recorder: z.literal('conformance:record'),
      gitSha: z.string().regex(GIT_SHA),
      runUrl: z.string().regex(RUN_URL),
      workflow: z.string().min(1),
      recordedAt,
    })
    .strict(),
  // A run on a developer machine: useful to look at, never accepted into the evidence tree.
  z
    .object({
      kind: z.literal('local'),
      recorder: z.literal('conformance:record'),
      gitSha: z.string().regex(GIT_SHA).nullable(),
      recordedAt,
    })
    .strict(),
]);

const integrity = z
  .object({
    algorithm: z.literal('sha256'),
    /** Over the canonical JSON of every other field. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const body = z
  .object({
    schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
    cfId: z.string().regex(CF_ID),
    title: z.string().min(1),
    protocol: z.enum(['amqp091', 'amqp10', 'http']),
    /** The version the broker itself reported (`/api/overview`), checked against the lab pin. */
    brokerVersion: z.string().regex(BROKER_VERSION),
    /** The pinned digest of the official base image in testing/broker-lab/versions.json. */
    imageDigest: z.string().regex(IMAGE_DIGEST),
    steps: z.array(step),
    observations: z.array(observation),
    provenance,
  })
  .strict();

export const evidenceArtefactSchema = body.extend({ integrity });

export type EvidenceBody = z.infer<typeof body>;
export type EvidenceArtefact = z.infer<typeof evidenceArtefactSchema>;
export type EvidenceStep = z.infer<typeof step>;
export type EvidenceObservation = z.infer<typeof observation>;
export type EvidenceProvenance = z.infer<typeof provenance>;

/** The JSON Schema of an artefact, for `testing/lab-evidence/schema.json` (a maintainer commits it). */
export const evidenceJsonSchema = (): unknown =>
  z.toJSONSchema(evidenceArtefactSchema, { io: 'input' });

export class EvidenceError extends Error {
  readonly code:
    | 'malformed'
    | 'tampered'
    | 'misplaced'
    | 'unsupported'
    | 'secret'
    | 'refused';
  constructor(code: EvidenceError['code'], message: string) {
    super(message);
    this.name = 'EvidenceError';
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
      throw new EvidenceError('malformed', 'a number is not finite');
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
  throw new EvidenceError('malformed', `${typeof value} is not JSON`);
}

const digestOf = (value: EvidenceBody): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Validates the body and adds the integrity digest. */
export function sealArtefact(value: EvidenceBody): EvidenceArtefact {
  const parsed = body.safeParse(value);
  if (!parsed.success) {
    throw new EvidenceError('malformed', parsed.error.message);
  }
  return {
    ...parsed.data,
    integrity: { algorithm: 'sha256', digest: digestOf(parsed.data) },
  };
}

/** Parses an artefact (an object or the text of a file) and checks its integrity digest. */
export function verifyArtefact(input: unknown): EvidenceArtefact {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      throw new EvidenceError('malformed', 'the artefact is not valid JSON');
    }
  }
  const parsed = evidenceArtefactSchema.safeParse(value);
  if (!parsed.success) {
    throw new EvidenceError('malformed', parsed.error.message);
  }
  const { integrity: claimed, ...rest } = parsed.data;
  const expected = Buffer.from(digestOf(rest), 'hex');
  const actual = Buffer.from(claimed.digest, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new EvidenceError(
      'tampered',
      `the integrity digest of ${parsed.data.cfId} does not match its content`,
    );
  }
  return parsed.data;
}

/** The path of an artefact below the evidence root: `<broker-version>/<CF-id>.json`. */
export const evidenceRelativePath = (
  artefact: Pick<EvidenceArtefact, 'brokerVersion' | 'cfId'>,
): string => `${artefact.brokerVersion}/${artefact.cfId}.json`;

/**
 * Reads one evidence file the way the conformance cells will: it must verify, and it must sit where
 * its own content says it belongs (a file moved to another version's folder is refused).
 */
export function verifyEvidenceText(
  relativePath: string,
  text: string,
): EvidenceArtefact {
  const artefact = verifyArtefact(text);
  const expected = evidenceRelativePath(artefact);
  if (relativePath.replaceAll('\\', '/') !== expected) {
    throw new EvidenceError(
      'misplaced',
      `${relativePath} holds the evidence of ${expected}`,
    );
  }
  return artefact;
}
