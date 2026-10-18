import { describe, expect, it } from 'vitest';

import {
  assertAcceptProof,
  assertAckProof,
  assertSafeReturnProof,
  ForgedProofError,
  isConfirmedCopyProof,
  isDestructiveConsentProof,
  isSafeReturnProof,
  isStreamCreditProof,
  mintConfirmedCopyProof,
  mintDestructiveConsentProof,
  mintSafeReturnProof,
  mintStreamCreditProof,
} from './proofs.ts';

const confirmed = () =>
  mintConfirmedCopyProof({ destination: 'orders.parked', confirmedAt: 1000 });
const consent = () => mintDestructiveConsentProof({ planHash: 'sha256-abc' });
const safeReturn = () => mintSafeReturnProof({ reason: 'classic' });
const credit = () => mintStreamCreditProof();

/** Every way code can try to make a proof without minting one. */
function forgeries(real: object): Record<string, unknown> {
  return {
    'a literal cast to the type': {
      kind: 'confirmed-copy',
      destination: 'orders.parked',
      confirmedAt: 1,
    },
    'a literal with the other kind': {
      kind: 'destructive-consent',
      planHash: 'x',
    },
    'a spread copy of a real proof': { ...real },
    'a structured clone of a real proof': structuredClone(real),
    'a JSON round trip of a real proof': JSON.parse(
      JSON.stringify(real),
    ) as unknown,
    'an object that inherits from a real proof': Object.create(real) as object,
    'a Proxy around a real proof': new Proxy(real, {}),
    'the legacy __proof literal': {
      __proof: 'destructive-consent',
      planHash: 'x',
    },
    null: null,
    undefined,
    'a string': 'confirmed-copy',
    'a number': 1,
    'an empty object': {},
  };
}

describe('settlement proofs', () => {
  it('mints sealed objects that carry their fields', () => {
    const proof = confirmed();
    expect(proof).toMatchObject({
      kind: 'confirmed-copy',
      destination: 'orders.parked',
      confirmedAt: 1000,
    });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(() => {
      (proof as { destination: string }).destination = 'elsewhere';
    }).toThrow(TypeError);
    expect(proof.destination).toBe('orders.parked');
  });

  it('refuses to mint from invalid fields', () => {
    expect(() =>
      mintConfirmedCopyProof({ destination: '', confirmedAt: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      mintConfirmedCopyProof({ destination: 'q', confirmedAt: Number.NaN }),
    ).toThrow(RangeError);
    expect(() => mintDestructiveConsentProof({ planHash: '' })).toThrow(
      RangeError,
    );
    expect(() =>
      mintSafeReturnProof({
        reason: 'quorum-finite' as unknown as 'classic',
      }),
    ).toThrow(RangeError);
  });

  it('recognises each minted kind and no other', () => {
    expect(isConfirmedCopyProof(confirmed())).toBe(true);
    expect(isDestructiveConsentProof(consent())).toBe(true);
    expect(isSafeReturnProof(safeReturn())).toBe(true);
    expect(isStreamCreditProof(credit())).toBe(true);

    expect(isConfirmedCopyProof(consent())).toBe(false);
    expect(isDestructiveConsentProof(confirmed())).toBe(false);
    expect(isSafeReturnProof(credit())).toBe(false);
    expect(isStreamCreditProof(safeReturn())).toBe(false);
  });

  describe.each<[string, (value: unknown) => void]>([
    [
      'assertAckProof',
      (v) => {
        assertAckProof(v);
      },
    ],
    [
      'assertSafeReturnProof',
      (v) => {
        assertSafeReturnProof(v);
      },
    ],
    [
      'assertAcceptProof',
      (v) => {
        assertAcceptProof(v);
      },
    ],
  ])('%s', (_name, assertProof) => {
    const real = { kind: 'x' };
    for (const [label, forged] of Object.entries(forgeries(real))) {
      it(`refuses ${label}`, () => {
        expect(() => {
          assertProof(forged);
        }).toThrow(ForgedProofError);
      });
    }
  });

  it('refuses the copy of a real proof even though it has the same fields (AC-A9)', () => {
    const real = confirmed();
    for (const copy of [
      { ...real },
      structuredClone(real),
      Object.create(real) as object,
      new Proxy(real, {}),
    ]) {
      expect(isConfirmedCopyProof(copy)).toBe(false);
      expect(() => {
        assertAckProof(copy);
      }).toThrow(ForgedProofError);
    }
  });

  it('ack accepts a confirmed copy or a destructive consent and nothing else', () => {
    expect(() => {
      assertAckProof(confirmed());
    }).not.toThrow();
    expect(() => {
      assertAckProof(consent());
    }).not.toThrow();
    expect(() => {
      assertAckProof(safeReturn());
    }).toThrow(ForgedProofError);
    expect(() => {
      assertAckProof(credit());
    }).toThrow(ForgedProofError);
  });

  it('a source returns a message only with a safe-return proof', () => {
    expect(() => {
      assertSafeReturnProof(safeReturn());
    }).not.toThrow();
    for (const other of [confirmed(), consent(), credit()]) {
      expect(() => {
        assertSafeReturnProof(other);
      }).toThrow(ForgedProofError);
    }
  });

  it('an AMQP 1.0 accept takes the ack proofs and the stream credit proof, not a safe return', () => {
    for (const ok of [confirmed(), consent(), credit()]) {
      expect(() => {
        assertAcceptProof(ok);
      }).not.toThrow();
    }
    expect(() => {
      assertAcceptProof(safeReturn());
    }).toThrow(ForgedProofError);
  });

  it('the error names what was expected and carries no value', () => {
    try {
      assertAckProof({ kind: 'confirmed-copy', destination: 'secret-queue' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ForgedProofError);
      const forged = error as ForgedProofError;
      expect(forged.expected).toEqual([
        'confirmed-copy',
        'destructive-consent',
      ]);
      expect(forged.message).not.toContain('secret-queue');
    }
  });
});
