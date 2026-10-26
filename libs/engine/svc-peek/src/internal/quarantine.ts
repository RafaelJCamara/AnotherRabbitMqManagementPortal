// The quarantine queue of the rescue preflight (M1-13, DC-09, amendment A-5, blueprint 5.5): its name,
// the two literal shapes it may be declared with, the check of a queue already on the broker, and the
// one idempotent declare that arms it.
//
// Nothing here names a write port, a lease or the connection manager (I-2): `ensureQuarantine` takes
// its `send` as an argument, and the peek action (M1-16) passes `ctx.writes.mgmt.send` from `execute()`.
// The result carries closed codes only, never the broker's text (I-10).
import type { ConnectionId } from '@app/contracts';
import type { MgmtSendRequest } from '@app/ports';
import { z } from 'zod';

export const QUARANTINE_SUFFIX = 'quarantine';

/** The prefix is injected by the composition root (OQ-1470); this is the longest it may be. */
export const QUARANTINE_PREFIX_MAX = 40;

const PREFIX_SHAPE = /^[a-z][a-z0-9-]*$/;

/**
 * `${prefix}.quarantine`. Throws `RangeError` for a prefix that is empty, over 40 characters, outside
 * `[a-z][a-z0-9-]*`, starts with `amq` (the broker reserves it) or contains "rabbitmq" or "rmq"
 * (ADR-029, AGENTS.md section 1). The composition root calls it at start, so a bad prefix fails there
 * and not at the first peek.
 */
export function quarantineName(prefix: string): string {
  if (prefix.length === 0 || prefix.length > QUARANTINE_PREFIX_MAX) {
    throw new RangeError(
      `the quarantine prefix must be 1 to ${QUARANTINE_PREFIX_MAX.toString()} characters`,
    );
  }
  if (!PREFIX_SHAPE.test(prefix)) {
    throw new RangeError(
      'the quarantine prefix must match [a-z][a-z0-9-]* (lower case letters, digits and hyphens)',
    );
  }
  if (prefix.startsWith('amq')) {
    throw new RangeError('the quarantine prefix may not start with "amq"');
  }
  if (prefix.includes('rabbitmq') || prefix.includes('rmq')) {
    throw new RangeError(
      'the quarantine prefix may not contain "rabbitmq" or "rmq"',
    );
  }
  return `${prefix}.${QUARANTINE_SUFFIX}`;
}

/** A-5, literal: durable classic, overflow reject-publish, no max-length, never drop-head. */
export interface ClassicQuarantineSpec {
  readonly name: string;
  readonly vhost: string;
  readonly durable: true;
  readonly autoDelete: false;
  readonly arguments: {
    readonly 'x-queue-type': 'classic';
    readonly 'x-overflow': 'reject-publish';
  };
}

/** The fallback where classic is disabled and the registry says -1 does not destroy a returned message. */
export interface QuorumQuarantineSpec {
  readonly name: string;
  readonly vhost: string;
  readonly durable: true;
  readonly autoDelete: false;
  readonly arguments: {
    readonly 'x-queue-type': 'quorum';
    readonly 'x-overflow': 'reject-publish';
    readonly 'x-delivery-limit': -1;
  };
}

export type QuarantineQueueSpec = ClassicQuarantineSpec | QuorumQuarantineSpec;
export type QuarantineQueueType =
  QuarantineQueueSpec['arguments']['x-queue-type'];

/** The spec as an immutable value: the object and its arguments are frozen. */
export function buildQuarantineSpec(
  name: string,
  vhost: string,
  type: 'classic',
): ClassicQuarantineSpec;
export function buildQuarantineSpec(
  name: string,
  vhost: string,
  type: 'quorum',
): QuorumQuarantineSpec;
export function buildQuarantineSpec(
  name: string,
  vhost: string,
  type: QuarantineQueueType,
): QuarantineQueueSpec;
export function buildQuarantineSpec(
  name: string,
  vhost: string,
  type: QuarantineQueueType,
): QuarantineQueueSpec {
  if (type === 'classic') {
    return Object.freeze({
      name,
      vhost,
      durable: true,
      autoDelete: false,
      arguments: Object.freeze({
        'x-queue-type': 'classic',
        'x-overflow': 'reject-publish',
      } as const),
    });
  }
  return Object.freeze({
    name,
    vhost,
    durable: true,
    autoDelete: false,
    arguments: Object.freeze({
      'x-queue-type': 'quorum',
      'x-overflow': 'reject-publish',
      'x-delivery-limit': -1,
    } as const),
  });
}

/** A queue read from the broker, reduced to what the conformity check needs. */
export interface FoundQueue {
  readonly name: string;
  readonly vhost: string;
  /** As the broker reports it: `classic`, `quorum`, `stream` or a type this code does not know. */
  readonly type: string;
  readonly durable: boolean;
  readonly autoDelete: boolean;
  readonly exclusive?: boolean;
  /** The arguments the queue was declared with (policies are not in here). */
  readonly arguments: Readonly<Record<string, unknown>>;
}

/**
 * Whether a queue found on the broker is the spec. Exact on purpose: a queue of the right name that
 * is non-durable, exclusive, auto-delete, of another type, or that carries any argument the spec does
 * not (a max-length, a message TTL, an expiry, a dead-letter exchange, `drop-head`) is `wrong-shape`.
 * It is never reused and never changed.
 */
export function conformsToSpec(
  found: FoundQueue,
  spec: QuarantineQueueSpec,
): 'conforms' | 'wrong-shape' {
  if (found.name !== spec.name || found.vhost !== spec.vhost) {
    return 'wrong-shape';
  }
  if (found.type !== spec.arguments['x-queue-type']) return 'wrong-shape';
  if (!found.durable || found.autoDelete || found.exclusive === true) {
    return 'wrong-shape';
  }
  const wanted = spec.arguments as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(found.arguments)) {
    if (!(key in wanted)) return 'wrong-shape';
  }
  for (const [key, value] of Object.entries(wanted)) {
    const present = found.arguments[key];
    // The broker lists `x-queue-type` for a queue that declared it; the `type` field above is
    // authoritative, so a classic queue declared without the argument still conforms.
    if (present === undefined && key === 'x-queue-type') continue;
    if (present !== value) return 'wrong-shape';
  }
  return 'conforms';
}

/**
 * The write of this WP. The caller passes `send` (the peek action passes `ctx.writes.mgmt.send`); no
 * file in this project names a write port or a lease, so the architecture test needs no exemption.
 */
export type QuarantineSend = (
  request: MgmtSendRequest<unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

export type EnsureOutcome =
  | { readonly state: 'reused' }
  | { readonly state: 'created' }
  | {
      readonly state: 'unavailable';
      readonly reason: 'wrong-shape' | 'refused' | 'unreadable';
    };

const AnyBodySchema = z.unknown();

/**
 * Arms the quarantine: nothing when a conforming queue exists, one `PUT /api/queues/{vhost}/{name}`
 * when it is absent, and no write at all when a queue of that name has another shape (the person
 * decides what to do with it; this code never deletes or redeclares).
 *
 * A declare that fails is followed by one re-read: another peek may have created the queue between the
 * preflight and now. The queue is then `reused` when it conforms, `wrong-shape` when it does not,
 * `refused` when it is still absent (the broker or its permissions said no), and `unreadable` when the
 * re-read itself fails. An aborted signal rethrows. The outcome holds no broker text (I-10).
 */
export async function ensureQuarantine(
  args: {
    readonly connectionId: ConnectionId;
    readonly spec: QuarantineQueueSpec;
    readonly found: FoundQueue | null;
    readonly send: QuarantineSend;
    readonly reread: () => Promise<FoundQueue | null>;
  },
  signal: AbortSignal,
): Promise<EnsureOutcome> {
  const { connectionId, spec, found, send, reread } = args;
  if (found !== null) {
    return conformsToSpec(found, spec) === 'conforms'
      ? { state: 'reused' }
      : { state: 'unavailable', reason: 'wrong-shape' };
  }
  signal.throwIfAborted();
  // A function, so the narrowing of the line above does not hide a later abort.
  const aborted = (): boolean => signal.aborted;
  try {
    await send(
      {
        connectionId,
        method: 'PUT',
        path: `/api/queues/${encodeURIComponent(spec.vhost)}/${encodeURIComponent(spec.name)}`,
        body: {
          durable: spec.durable,
          auto_delete: spec.autoDelete,
          arguments: { ...spec.arguments },
        },
        schema: AnyBodySchema,
      },
      signal,
    );
    return { state: 'created' };
  } catch (error) {
    if (aborted()) throw error;
  }
  let now: FoundQueue | null;
  try {
    now = await reread();
  } catch (error) {
    if (aborted()) throw error;
    return { state: 'unavailable', reason: 'unreadable' };
  }
  if (now === null) return { state: 'unavailable', reason: 'refused' };
  return conformsToSpec(now, spec) === 'conforms'
    ? { state: 'reused' }
    : { state: 'unavailable', reason: 'wrong-shape' };
}
