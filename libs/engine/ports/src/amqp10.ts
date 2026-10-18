// AMQP 1.0 receiver (credit-1 peeks and stream reads, ADR-009). Settling by accepting needs a
// proof, like an ack on 0-9-1.
import type { AckProof, StreamCreditProof } from './proofs.ts';

export interface Amqp10Message {
  annotations: Record<string, unknown>;
  properties: Record<string, unknown>;
  applicationProperties: Record<string, unknown>;
  body: Uint8Array;
}

export interface Amqp10Delivery {
  id: number;
  message: Amqp10Message;
  deliveryCount?: number;
}

export interface Amqp10Receiver {
  /** The filters the broker applied; a filter it dropped silently is absent. */
  readonly appliedFilters: ReadonlyMap<string, unknown>;
  addCredit(n: number): void;
  drain(): Promise<void>;
  deliveries(): AsyncIterable<Amqp10Delivery>;
  release(id: number): void;
  accept(id: number, proof: AckProof | StreamCreditProof): void;
  /** Throws if any delivery is still unsettled. */
  detach(): Promise<void>;
}
