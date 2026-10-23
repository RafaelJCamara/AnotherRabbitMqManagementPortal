export type TypedHeaderValue =
  | {
      t:
        | 'string'
        | 'long'
        | 'int'
        | 'short'
        | 'byte'
        | 'double'
        | 'float'
        | 'bool'
        | 'timestamp'
        | 'decimal'
        | 'bytes'
        | 'void';
      v: unknown;
    }
  | { t: 'array'; v: TypedHeaderValue[] }
  | { t: 'table'; v: Record<string, TypedHeaderValue> };

export interface DecodeInput {
  headers: Readonly<Record<string, TypedHeaderValue>>;
  properties: Readonly<Record<string, unknown>>;
  body: Uint8Array;
  bodyTruncated: boolean;
  queue?: string;
  protocol: 'amqp091' | 'amqp10';
  era: string;
}

export interface NormalizedFailure {
  framework: string;
  messageId?: string;
  logicalIds: Record<string, string>;
  exception?: { type?: string; message?: string; frames?: string[] };
  deaths: {
    queue: string;
    reason: 'rejected' | 'expired' | 'maxlen' | 'delivery_limit';
    count: number;
    scheduledNotFailed?: boolean;
  }[];
  infrastructure?: 'delay' | 'retry' | 'none';
}

export interface DecoderPlugin {
  apiVersion: 1;
  id: string;
  tier: 'builtin' | 'declarative' | 'sandboxed';
  frameworks: readonly string[];
  /** 0 means "not this framework", 1 means certain. */
  detect(message: DecodeInput): number;
  decode(message: DecodeInput): NormalizedFailure;
  fingerprint(
    failure: NormalizedFailure,
    level: 'type' | 'type+frame' | 'type+frame+template',
  ): string;
  replayPlan(
    failure: NormalizedFailure,
    context: { knownQueues: ReadonlySet<string> },
  ): {
    destinationQueue?: string;
    stripHeaders: string[];
    preserveIds: string[];
    confidence: number;
  } | null;
}
