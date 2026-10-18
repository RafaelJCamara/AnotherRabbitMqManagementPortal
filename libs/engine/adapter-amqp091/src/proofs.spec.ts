import { describe, expect, it } from 'vitest';

import {
  ForgedProofError,
  mintConfirmedCopyProof,
  mintDestructiveConsentProof,
  mintSafeReturnProof,
  mintStreamCreditProof,
} from '@app/ports';

import {
  fromWireTag,
  requireAckProof,
  requireSafeReturnProof,
  TagLedger,
  toWireTag,
} from './proofs.ts';

describe('the proof gates', () => {
  it('requireAckProof takes a confirmed copy and a destructive consent, nothing else', () => {
    const confirmed = mintConfirmedCopyProof({
      destination: 'q',
      confirmedAt: 1,
    });
    const consent = mintDestructiveConsentProof({ planHash: 'h' });
    expect(requireAckProof(confirmed)).toBe(confirmed);
    expect(requireAckProof(consent)).toBe(consent);
    for (const other of [
      mintSafeReturnProof({ reason: 'classic' }),
      mintStreamCreditProof(),
      { ...confirmed },
      {},
      null,
    ]) {
      expect(() => requireAckProof(other)).toThrow(ForgedProofError);
    }
  });

  it('requireSafeReturnProof takes a safe-return proof, nothing else', () => {
    const safe = mintSafeReturnProof({ reason: 'quorum-unlimited' });
    expect(requireSafeReturnProof(safe)).toBe(safe);
    for (const other of [
      mintConfirmedCopyProof({ destination: 'q', confirmedAt: 1 }),
      mintDestructiveConsentProof({ planHash: 'h' }),
      { kind: 'safe-return', reason: 'classic' },
    ]) {
      expect(() => requireSafeReturnProof(other)).toThrow(ForgedProofError);
    }
  });
});

describe('delivery tags', () => {
  it('convert between the wire number and bigint, and refuse what is not a tag', () => {
    expect(toWireTag(1n)).toBe(1);
    expect(toWireTag(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    for (const bad of [
      0n,
      -1n,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      1 as never,
    ]) {
      expect(() => toWireTag(bad)).toThrow(
        expect.objectContaining({ reason: 'invalid-argument' }) as Error,
      );
    }
    expect(fromWireTag(5)).toBe(5n);
    for (const bad of [0, -3, 1.5, Number.NaN, 2 ** 60]) {
      expect(() => fromWireTag(bad)).toThrow(
        expect.objectContaining({ reason: 'broker-error' }) as Error,
      );
    }
  });
});

describe('TagLedger', () => {
  it('holds tags, settles one or all below a tag, and knows the highest', () => {
    const ledger = new TagLedger(10);
    for (const tag of [1n, 2n, 3n, 5n]) ledger.add(tag);
    expect(ledger.size).toBe(4);
    expect(ledger.highest()).toBe(5n);
    ledger.settle(5n);
    expect(ledger.highest()).toBe(3n);
    expect(ledger.settleUpTo(2n)).toBe(2);
    expect(ledger.has(3n)).toBe(true);
    expect(ledger.has(1n)).toBe(false);
    expect(ledger.clear()).toBe(1);
    expect(ledger.highest()).toBeUndefined();
  });

  it('require refuses a tag that is not held', () => {
    const ledger = new TagLedger(2);
    ledger.add(4n);
    expect(() => {
      ledger.require(4n);
    }).not.toThrow();
    expect(() => {
      ledger.require(5n);
    }).toThrow(
      expect.objectContaining({ reason: 'unknown-delivery-tag' }) as Error,
    );
  });

  it('is bounded: it will not hold more than its limit, nor the same tag twice', () => {
    const ledger = new TagLedger(2);
    ledger.add(1n);
    ledger.add(2n);
    expect(ledger.hasRoom()).toBe(false);
    expect(() => {
      ledger.add(3n);
    }).toThrow(expect.objectContaining({ reason: 'too-many-held' }) as Error);
    ledger.settle(1n);
    expect(() => {
      ledger.add(2n);
    }).toThrow(expect.objectContaining({ reason: 'broker-error' }) as Error);
    expect(() => new TagLedger(0)).toThrow(RangeError);
  });
});
