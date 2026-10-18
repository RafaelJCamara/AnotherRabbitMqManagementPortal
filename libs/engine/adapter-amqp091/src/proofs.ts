// Settlement on a lease: which tags a lease holds, and the one gate each settle path goes through.
//
// Acknowledging a delivery loses the message from its queue, so every lease that can settle calls
// an `assert*Proof` function of `@app/ports` before it touches a channel (A-9, OQ-171). The
// functions check the run-time half of the nominal proof (a WeakMap of minted proofs), so a
// literal cast with `as`, a spread copy, a JSON round trip or a Proxy is refused with a
// `ForgedProofError` even when the compile-time half was bypassed. The gate comes first in every
// settle method: nothing is looked up, sent or recorded for a forged proof.
//
// This file never mints a proof. Minting belongs to the publish lease (a confirmed copy), the
// planners (consent, safe return) and the stream consumer (credit); see `@app/ports`.
import {
  assertAckProof,
  assertSafeReturnProof,
  type AckProof,
  type SafeReturnProof,
} from '@app/ports';

import { Amqp091Error } from './errors.ts';

/** A confirmed copy or a destructive consent; anything else throws `ForgedProofError`. */
export function requireAckProof(proof: unknown): AckProof {
  assertAckProof(proof);
  return proof;
}

/** A safe-return proof; anything else throws `ForgedProofError`. */
export function requireSafeReturnProof(proof: unknown): SafeReturnProof {
  assertSafeReturnProof(proof);
  return proof;
}

/** A delivery tag as AMQP carries it: a positive integer that a JS number holds exactly. */
export function toWireTag(tag: bigint): number {
  if (
    typeof tag !== 'bigint' ||
    tag < 1n ||
    tag > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Amqp091Error(
      'invalid-argument',
      'a delivery tag must be a positive bigint that fits a safe integer',
    );
  }
  return Number(tag);
}

export function fromWireTag(tag: number): bigint {
  if (!Number.isSafeInteger(tag) || tag < 1) {
    throw new Amqp091Error(
      'broker-error',
      'the broker sent a delivery tag that is not a positive safe integer',
    );
  }
  return BigInt(tag);
}

/**
 * The delivery tags a lease holds (delivered and not settled) on its channel. A settle for a tag
 * that is not in it is refused before anything is sent: the broker answers an unknown tag with
 * 406 and closes the channel, which returns every other held delivery through a DOWN (DC-04, I-4).
 *
 * The ledger is bounded (I-6): it refuses to grow past `limit`, and the lease checks that before it
 * asks the broker for another message, so a delivery is never received that cannot be recorded.
 */
export class TagLedger {
  readonly limit: number;
  readonly #tags = new Set<bigint>();

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('the ledger limit must be a positive integer');
    }
    this.limit = limit;
  }

  get size(): number {
    return this.#tags.size;
  }

  hasRoom(): boolean {
    return this.#tags.size < this.limit;
  }

  add(tag: bigint): void {
    if (this.#tags.has(tag)) {
      throw new Amqp091Error(
        'broker-error',
        'the broker delivered the same tag twice',
      );
    }
    if (!this.hasRoom()) {
      throw new Amqp091Error(
        'too-many-held',
        `more than ${String(this.limit)} deliveries are held on this lease`,
      );
    }
    this.#tags.add(tag);
  }

  has(tag: bigint): boolean {
    return this.#tags.has(tag);
  }

  /** The tag must be held; otherwise the caller must not send its settle. */
  require(tag: bigint): void {
    if (!this.#tags.has(tag)) {
      throw new Amqp091Error(
        'unknown-delivery-tag',
        'this lease does not hold that delivery tag (not delivered, already settled, or lost)',
      );
    }
  }

  settle(tag: bigint): void {
    this.#tags.delete(tag);
  }

  /** Settles `tag` and every held tag below it (a `multiple` settle). Returns how many. */
  settleUpTo(tag: bigint): number {
    let count = 0;
    for (const held of [...this.#tags]) {
      if (held <= tag) {
        this.#tags.delete(held);
        count += 1;
      }
    }
    return count;
  }

  /** The highest held tag, the one a multiple nack names. */
  highest(): bigint | undefined {
    let top: bigint | undefined;
    for (const held of this.#tags) {
      if (top === undefined || held > top) top = held;
    }
    return top;
  }

  /** The channel is gone, so its deliveries are gone with it. Returns how many were held. */
  clear(): number {
    const count = this.#tags.size;
    this.#tags.clear();
    return count;
  }
}
