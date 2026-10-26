import type { CopyOutcome, PublishHeaders, PublishProps } from '@app/contracts';
import type { Logger } from '@app/kernel';

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

/**
 * The ports this module needs, injected by the composition root. The broker is reached only through
 * `ctx.writes.connections` of the executor, so the module needs no lease port of its own.
 */
export interface MessagesModuleDeps {
  readonly recorder: PublishRecorder;
  /** Redacts (I-10). The action logs fixed texts and codes, never a value. */
  readonly logger: Logger;
}
