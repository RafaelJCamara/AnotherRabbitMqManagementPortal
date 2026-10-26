import type { CopyOutcome, PublishHeaders, PublishProps } from '@app/contracts';
import type { Clock, Logger } from '@app/kernel';
import type { FieldSealer, PublishHistoryRepository } from '@app/ports';

import type { PublishHistory } from './internal/publish-history';

/**
 * What `messages.publish` hands to the history once the copies have an outcome (H1). It carries the
 * message as the caller typed it: the recorder masks it before anything is stored (H3), so the
 * action never decides what is a secret and nothing here is logged.
 */
export interface PublishRecord {
  /** The principal's id: history is per owner (H4). */
  readonly ownerId: string;
  readonly connectionId: string;
  readonly vhost: string;
  /** Milliseconds since the epoch, when the publish ended. */
  readonly at: number;
  readonly exchange: string;
  readonly routingKey: string;
  readonly copies: number;
  /** One count per outcome; they add up to `copies`. */
  readonly summary: Readonly<Record<CopyOutcome, number>>;
  readonly props: PublishProps;
  readonly headers?: PublishHeaders;
  /** The decoded body. */
  readonly body: Uint8Array;
}

/**
 * Where a publish is remembered. The action calls it after the loop and never lets it change the
 * outcome: a rejection becomes `historyRecorded: false` (I-13). The history store of slices B to D
 * implements it; until then a fake does (src/testing.ts).
 */
export interface PublishRecorder {
  /** Returns the id of the history entry. */
  record(entry: PublishRecord): Promise<string>;
}

/** The two reads of the publish history store, all the history actions need. */
export type PublishHistoryReader = Pick<PublishHistory, 'window' | 'get'>;

/**
 * What the actions of this module read through. The composition root does not build it: it hands
 * `MessagesModuleDeps` to `createMessagesModule`, which builds the history store and passes it here
 * as both the recorder of `messages.publish` and the reader of the two history actions. The broker is
 * reached only through `ctx.writes.connections` of the executor, so the module needs no lease port.
 */
export interface MessagesActionDeps {
  readonly recorder: PublishRecorder;
  readonly store: PublishHistoryReader;
  /** Redacts (I-10). The actions log fixed texts and codes, never a value. */
  readonly logger: Logger;
}

/** The ports this module needs, injected by the composition root. */
export interface MessagesModuleDeps {
  /** The history table (slice B): `@app/persistence`'s `repos.publishHistory`. */
  readonly history: PublishHistoryRepository;
  /** The vault's field cipher. It rejects while the vault is locked, so nothing is stored then (I-10). */
  readonly sealer: FieldSealer;
  /** A new, opaque, path-safe id: a ULID. */
  readonly newId: () => string;
  readonly clock: Clock;
  /** Redacts (I-10). */
  readonly logger: Logger;
}
