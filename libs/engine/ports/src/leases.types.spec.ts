// Compile-time tests (ADR-009, A-9). Each `@ts-expect-error` line is an attempt to break an
// invariant; `tsc` (the typecheck target) fails if one of them ever compiles, because an unused
// `@ts-expect-error` is an error. The bodies are never run: `compileOnly` drops them.
import type { ConnectionId } from '@app/contracts';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Amqp10Receiver } from './amqp10.ts';
import type {
  ObserveLease,
  PeekLease,
  PublishLease,
  SourceLease,
} from './amqp091.ts';
import type { ConnectionManager } from './connection-manager.ts';
import type {
  Lane,
  MgmtGetRequest,
  MgmtReadPort,
  MgmtSendRequest,
  MgmtWritePort,
  PromScrapePort,
} from './mgmt.ts';
import type {
  ConfirmedCopyProof,
  DestructiveConsentProof,
  SafeReturnProof,
  StreamCreditProof,
} from './proofs.ts';

function compileOnly(body: () => unknown): void {
  expect(typeof body).toBe('function');
}

declare const peek: PeekLease;
declare const source: SourceLease;
declare const publisher: PublishLease;
declare const receiver: Amqp10Receiver;
declare const confirmed: ConfirmedCopyProof;
declare const consent: DestructiveConsentProof;
declare const safeReturn: SafeReturnProof;
declare const streamCredit: StreamCreditProof;

describe('role-typed leases (compile time)', () => {
  it('a peek lease never publishes, consumes or declares', () => {
    expectTypeOf<PeekLease>().not.toHaveProperty('publish');
    expectTypeOf<PeekLease>().not.toHaveProperty('consume');
    expectTypeOf<PeekLease>().not.toHaveProperty('declareTapQueue');
    expectTypeOf<PeekLease>().not.toHaveProperty('cancel');
  });

  it('nothing is acked without a proof, and a forged literal is not a proof', () => {
    compileOnly(() => {
      // @ts-expect-error ack needs a proof
      peek.ackWithProof(1n);
      // @ts-expect-error ack needs a proof
      source.ackWithProof(1n);
      // @ts-expect-error a literal is not a proof (the brand cannot be named)
      peek.ackWithProof(1n, {
        kind: 'confirmed-copy',
        destination: 'q',
        confirmedAt: 1,
      });
      const legacy = { __proof: 'destructive-consent', planHash: 'h' } as const;
      // @ts-expect-error the legacy literal form is not a proof either
      source.ackWithProof(1n, legacy);
      // @ts-expect-error a safe-return proof does not authorise losing the message
      peek.ackWithProof(1n, safeReturn);
      // @ts-expect-error a stream credit proof does not authorise losing the message
      source.ackWithProof(1n, streamCredit);
      // @ts-expect-error copying the fields of a proof does not copy the brand
      peek.ackWithProof(1n, {
        kind: confirmed.kind,
        destination: confirmed.destination,
        confirmedAt: confirmed.confirmedAt,
      });

      peek.ackWithProof(1n, confirmed);
      peek.ackWithProof(1n, consent);
      source.ackWithProof(1n, confirmed);
      source.ackWithProof(1n, consent);
    });
  });

  it('nack returns a message only as requeue=true, and a source needs a safe-return proof', () => {
    compileOnly(() => {
      // @ts-expect-error requeue is only ever the literal true
      peek.nackRequeue(1n, { multiple: true, requeue: false });
      // @ts-expect-error a peek returns everything up to a tag: multiple is only ever true
      peek.nackRequeue(1n, { multiple: false, requeue: true });
      // @ts-expect-error a source cannot return a delivery without a proof
      source.nackRequeue(1n);
      // @ts-expect-error a confirmed copy is not a safe return
      source.nackRequeue(1n, confirmed);
      // @ts-expect-error a literal is not a safe-return proof
      source.nackRequeue(1n, { kind: 'safe-return', reason: 'classic' });

      peek.nackRequeue(1n, { multiple: true, requeue: true });
      source.nackRequeue(1n, safeReturn);
    });
  });

  it('a source lease cannot publish or declare; a publish lease cannot consume or settle', () => {
    expectTypeOf<SourceLease>().not.toHaveProperty('publish');
    expectTypeOf<SourceLease>().not.toHaveProperty('declareTapQueue');
    expectTypeOf<PublishLease>().not.toHaveProperty('consume');
    expectTypeOf<PublishLease>().not.toHaveProperty('ackWithProof');
    expectTypeOf<PublishLease>().not.toHaveProperty('nackRequeue');
  });

  it('a publish is mandatory and its confirmed outcome carries the only confirmed-copy proof', async () => {
    type PublishOptions = Parameters<PublishLease['publish']>[4];
    expectTypeOf<PublishOptions>().toEqualTypeOf<{
      mandatory: true;
      timeoutMs: number;
    }>();
    compileOnly(async () => {
      const result = await publisher.publish(
        'x',
        'k',
        new Uint8Array(),
        {},
        { mandatory: true, timeoutMs: 1 },
      );
      // @ts-expect-error the proof exists only on the confirmed outcome
      expectTypeOf(result.proof).toBeObject();
      if (result.outcome === 'confirmed') {
        expectTypeOf(result.proof).toEqualTypeOf<ConfirmedCopyProof>();
      }
    });
    await Promise.resolve();
  });

  it('an observe lease cannot publish or settle a user message', () => {
    expectTypeOf<ObserveLease>().not.toHaveProperty('publish');
    expectTypeOf<ObserveLease>().not.toHaveProperty('ackWithProof');
    expectTypeOf<ObserveLease>().not.toHaveProperty('nackRequeue');
  });

  it('a receiver accepts with a proof; a safe-return proof is not one', () => {
    compileOnly(() => {
      // @ts-expect-error accept needs a proof
      receiver.accept(1);
      // @ts-expect-error a literal is not a proof
      receiver.accept(1, { __proof: 'stream-credit' });
      // @ts-expect-error a safe return does not settle by accepting
      receiver.accept(1, safeReturn);

      receiver.accept(1, confirmed);
      receiver.accept(1, consent);
      receiver.accept(1, streamCredit);
    });
  });

  it('the manager returns exactly the lease of the role asked for', () => {
    expectTypeOf<
      Awaited<ReturnType<ConnectionManager['peek']>>
    >().toEqualTypeOf<PeekLease>();
    expectTypeOf<
      Awaited<ReturnType<ConnectionManager['source']>>
    >().toEqualTypeOf<SourceLease>();
    expectTypeOf<
      Awaited<ReturnType<ConnectionManager['publish']>>
    >().toEqualTypeOf<PublishLease>();
    expectTypeOf<
      Awaited<ReturnType<ConnectionManager['observe']>>
    >().toEqualTypeOf<ObserveLease>();
  });

  it('proofs of different kinds are not assignable to each other, nor is a lookalike literal', () => {
    expectTypeOf<ConfirmedCopyProof>().not.toExtend<DestructiveConsentProof>();
    expectTypeOf<SafeReturnProof>().not.toExtend<ConfirmedCopyProof>();
    expectTypeOf<StreamCreditProof>().not.toExtend<SafeReturnProof>();
    expectTypeOf<DestructiveConsentProof>().not.toExtend<StreamCreditProof>();
    expectTypeOf<{
      kind: 'confirmed-copy';
      destination: string;
      confirmedAt: number;
    }>().not.toExtend<ConfirmedCopyProof>();
  });
});

describe('Read/Write split (compile time)', () => {
  it('a read port cannot write and a write port cannot read', () => {
    expectTypeOf<MgmtReadPort>().not.toHaveProperty('send');
    expectTypeOf<MgmtWritePort>().not.toHaveProperty('get');
    expectTypeOf<MgmtWritePort>().not.toHaveProperty('stream');
    expectTypeOf<PromScrapePort>().not.toHaveProperty('send');
    expectTypeOf<MgmtReadPort>().not.toExtend<MgmtWritePort>();
    expectTypeOf<MgmtWritePort>().not.toExtend<MgmtReadPort>();
  });

  it('a read request names a lane; a write request is never a GET', () => {
    // A request without a lane cannot skip the scheduler's priorities.
    expectTypeOf<MgmtGetRequest<unknown>['lane']>().toEqualTypeOf<Lane>();
    expectTypeOf<{
      connectionId: ConnectionId;
      path: string;
      schema: MgmtGetRequest<unknown>['schema'];
    }>().not.toExtend<MgmtGetRequest<unknown>>();
    expectTypeOf<MgmtSendRequest<unknown>['method']>().toEqualTypeOf<
      'PUT' | 'POST' | 'DELETE'
    >();
  });
});
