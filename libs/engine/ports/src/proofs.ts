// Settlement proofs (ADR-009, amendment A-9). Acknowledging a delivery loses the message from its
// queue, so the leases accept an ack only together with a proof that the message is safe elsewhere
// (a confirmed copy) or that a human consented to its loss (a destructive-consent proof). Returning
// a source delivery needs a safe-return proof.
//
// A proof is NOMINAL, twice over:
//  - at compile time each interface carries a property keyed by a `unique symbol` that this module
//    does not export, so no other module can write an object literal that has the type;
//  - at run time the only way to obtain a proof is a `mint*` function, which records the object in
//    a module-private WeakMap. Lease implementations call the `assert*` functions, so a literal
//    cast with `as`, a spread copy or a structured clone of a real proof is refused.
//
// Who may call the `mint*` functions is decided by the architecture test (tools/arch-tests, A-9):
//  - `mintConfirmedCopyProof`: PublishLease implementations, from a broker publisher confirm;
//  - `mintDestructiveConsentProof` and `mintSafeReturnProof`: the planners (pure), from a plan
//    whose consent was granted or whose source queue was proven safe to return to;
//  - `mintStreamCreditProof`: the stream consumer of an observe lease.
// Nothing else imports them.

declare const confirmedCopyBrand: unique symbol;
declare const destructiveConsentBrand: unique symbol;
declare const safeReturnBrand: unique symbol;
declare const streamCreditBrand: unique symbol;

/** The message was published to `destination` and the broker confirmed it. */
export interface ConfirmedCopyProof {
  readonly [confirmedCopyBrand]: true;
  readonly kind: 'confirmed-copy';
  readonly destination: string;
  readonly confirmedAt: number;
}

/** A human accepted the loss of the message in the plan with this hash. */
export interface DestructiveConsentProof {
  readonly [destructiveConsentBrand]: true;
  readonly kind: 'destructive-consent';
  readonly planHash: string;
}

/**
 * Returning the message to its source queue cannot lose it. Issued by the planner only, and only
 * for a classic queue or a quorum queue without a finite delivery limit.
 */
export interface SafeReturnProof {
  readonly [safeReturnBrand]: true;
  readonly kind: 'safe-return';
  readonly reason: 'classic' | 'quorum-unlimited';
}

/** Accepting a stream delivery only returns credit; the stream keeps the message. */
export interface StreamCreditProof {
  readonly [streamCreditBrand]: true;
  readonly kind: 'stream-credit';
}

export type SettlementProof =
  | ConfirmedCopyProof
  | DestructiveConsentProof
  | SafeReturnProof
  | StreamCreditProof;
export type SettlementProofKind = SettlementProof['kind'];

/** What `ack` accepts on an AMQP 0-9-1 lease. */
export type AckProof = ConfirmedCopyProof | DestructiveConsentProof;

/** Thrown when a value that is not a minted proof is offered as one. It is a bug, not a user error. */
export class ForgedProofError extends Error {
  readonly expected: readonly SettlementProofKind[];

  constructor(expected: readonly SettlementProofKind[]) {
    super(`Not a settlement proof of kind ${expected.join(' or ')}.`);
    this.name = 'ForgedProofError';
    this.expected = expected;
  }
}

// Every minted proof, with its kind. A WeakMap holds no proof alive and cannot be enumerated.
const minted = new WeakMap<object, SettlementProofKind>();

// The brand properties exist only in the type, so the object is built from its runtime fields and
// asserted to the branded interface here, in the one place that is allowed to.
function register<T extends SettlementProof>(
  fields: { kind: T['kind'] } & Record<string, unknown>,
): T {
  const sealed = Object.freeze(fields) as unknown as T;
  minted.set(sealed, sealed.kind);
  return sealed;
}

function requireText(name: string, value: string): void {
  if (value.length === 0) {
    throw new RangeError(`${name} must not be empty.`);
  }
}

export function mintConfirmedCopyProof(args: {
  destination: string;
  confirmedAt: number;
}): ConfirmedCopyProof {
  requireText('destination', args.destination);
  if (!Number.isFinite(args.confirmedAt)) {
    throw new RangeError('confirmedAt must be a finite number.');
  }
  return register<ConfirmedCopyProof>({
    kind: 'confirmed-copy',
    destination: args.destination,
    confirmedAt: args.confirmedAt,
  });
}

export function mintDestructiveConsentProof(args: {
  planHash: string;
}): DestructiveConsentProof {
  requireText('planHash', args.planHash);
  return register<DestructiveConsentProof>({
    kind: 'destructive-consent',
    planHash: args.planHash,
  });
}

export function mintSafeReturnProof(args: {
  reason: SafeReturnProof['reason'];
}): SafeReturnProof {
  const allowed: readonly string[] = ['classic', 'quorum-unlimited'];
  if (!allowed.includes(args.reason)) {
    throw new RangeError('reason must be "classic" or "quorum-unlimited".');
  }
  return register<SafeReturnProof>({
    kind: 'safe-return',
    reason: args.reason,
  });
}

export function mintStreamCreditProof(): StreamCreditProof {
  return register<StreamCreditProof>({ kind: 'stream-credit' });
}

function isMinted(value: unknown, kinds: readonly SettlementProofKind[]) {
  if (typeof value !== 'object' || value === null) return false;
  const kind = minted.get(value);
  return kind !== undefined && kinds.includes(kind);
}

export function isConfirmedCopyProof(
  value: unknown,
): value is ConfirmedCopyProof {
  return isMinted(value, ['confirmed-copy']);
}

export function isDestructiveConsentProof(
  value: unknown,
): value is DestructiveConsentProof {
  return isMinted(value, ['destructive-consent']);
}

export function isSafeReturnProof(value: unknown): value is SafeReturnProof {
  return isMinted(value, ['safe-return']);
}

export function isStreamCreditProof(
  value: unknown,
): value is StreamCreditProof {
  return isMinted(value, ['stream-credit']);
}

/** For `ack` on an AMQP 0-9-1 lease: a confirmed copy or a destructive consent. */
export function assertAckProof(value: unknown): asserts value is AckProof {
  if (!isMinted(value, ['confirmed-copy', 'destructive-consent'])) {
    throw new ForgedProofError(['confirmed-copy', 'destructive-consent']);
  }
}

/** For `nackRequeue` on a source lease. */
export function assertSafeReturnProof(
  value: unknown,
): asserts value is SafeReturnProof {
  if (!isMinted(value, ['safe-return'])) {
    throw new ForgedProofError(['safe-return']);
  }
}

/** For `accept` on an AMQP 1.0 receiver: any proof that settles by accepting. */
export function assertAcceptProof(
  value: unknown,
): asserts value is AckProof | StreamCreditProof {
  if (
    !isMinted(value, ['confirmed-copy', 'destructive-consent', 'stream-credit'])
  ) {
    throw new ForgedProofError([
      'confirmed-copy',
      'destructive-consent',
      'stream-credit',
    ]);
  }
}
