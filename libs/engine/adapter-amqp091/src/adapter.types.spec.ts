// Compile-time tests (AC-1, ADR-009, A-9): what the adapter hands out is exactly the port's lease
// of the role, and the forbidden settle paths do not compile. Each `@ts-expect-error` line is an
// attempt to break an invariant; the typecheck target fails if one of them ever compiles. The
// bodies are never run: `compileOnly` drops them.
import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  ConfirmedCopyProof,
  DestructiveConsentProof,
  ObserveLease,
  PeekLease,
  PublishLease,
  SafeReturnProof,
  SourceLease,
  StreamCreditProof,
} from '@app/ports';

import type {
  connectObserve,
  connectPeek,
  connectPublish,
  connectSource,
  ControlLease,
} from './index.ts';
import type { connectControl } from './connect.ts';

function compileOnly(body: () => unknown): void {
  expect(typeof body).toBe('function');
}

declare const peek: PeekLease;
declare const confirmed: ConfirmedCopyProof;
declare const consent: DestructiveConsentProof;
declare const safeReturn: SafeReturnProof;
declare const streamCredit: StreamCreditProof;

describe('the adapter hands out exactly the lease of the role', () => {
  it('AC-1 each connect function returns the port lease and nothing wider', () => {
    type Lease<F extends (...args: never[]) => Promise<{ lease: unknown }>> =
      Awaited<ReturnType<F>>['lease'];
    expectTypeOf<Lease<typeof connectPeek>>().toEqualTypeOf<PeekLease>();
    expectTypeOf<Lease<typeof connectSource>>().toEqualTypeOf<SourceLease>();
    expectTypeOf<Lease<typeof connectPublish>>().toEqualTypeOf<PublishLease>();
    expectTypeOf<Lease<typeof connectObserve>>().toEqualTypeOf<ObserveLease>();
    expectTypeOf<Lease<typeof connectControl>>().toEqualTypeOf<ControlLease>();
  });

  it('AC-1 a control lease cannot hold a message', () => {
    for (const name of [
      'get',
      'consume',
      'publish',
      'ackWithProof',
      'nackRequeue',
      'reject',
    ] as const) {
      expectTypeOf<ControlLease>().not.toHaveProperty(name);
    }
  });
});

describe('AC-1 forbidden settle paths do not compile', () => {
  it('peekLease.reject(...) does not exist', () => {
    // Calling a member that does not exist is a compile error (TS2339); the type-level check
    // below is the same fact without a call the linter would flag as unsafe.
    for (const name of [
      'reject',
      'nack',
      'ack',
      'publish',
      'consume',
      'cancel',
    ] as const) {
      expectTypeOf<PeekLease>().not.toHaveProperty(name);
    }
  });

  it('nackRequeue with requeue:false does not compile', () => {
    compileOnly(() => {
      // @ts-expect-error requeue is only ever the literal true
      peek.nackRequeue(1n, { multiple: true, requeue: false });
      // @ts-expect-error multiple is only ever true
      peek.nackRequeue(1n, { multiple: false, requeue: true });
      // @ts-expect-error options are required
      peek.nackRequeue(1n);
      peek.nackRequeue(1n, { multiple: true, requeue: true });
    });
  });

  it('ackWithProof requires a ConfirmedCopyProof or a DestructiveConsentProof', () => {
    expectTypeOf<Parameters<PeekLease['ackWithProof']>[1]>().toEqualTypeOf<
      ConfirmedCopyProof | DestructiveConsentProof
    >();
    compileOnly(() => {
      // @ts-expect-error a proof is required
      peek.ackWithProof(1n);
      // @ts-expect-error a literal is not a proof
      peek.ackWithProof(1n, {
        kind: 'confirmed-copy',
        destination: 'q',
        confirmedAt: 1,
      });
      // @ts-expect-error a safe-return proof does not authorise losing the message
      peek.ackWithProof(1n, safeReturn);
      // @ts-expect-error a stream-credit proof does not either
      peek.ackWithProof(1n, streamCredit);
      peek.ackWithProof(1n, confirmed);
      peek.ackWithProof(1n, consent);
    });
  });
});
