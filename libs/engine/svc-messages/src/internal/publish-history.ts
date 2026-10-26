// The publish history (M1-19, PUB-02): what a person published, per owner and per connection, kept
// 30 days, from which a publish can be sent again with its secrets masked.
//
//   record   masks the message (mask.ts), seals the masked properties, headers and body as one
//            document with the field sealer (ADR-014, table publish_history, column data_sealed, the
//            row id in the AAD) and writes the plain columns beside it. The secret is never stored,
//            so there is nothing to unmask later (OQ-1442). A locked vault stores nothing: there is
//            no plaintext fallback (I-10). Every call also purges a bounded batch of expired rows.
//   window   a keyset page of at most 200 summaries, newest first, of the owner's entries on one
//            connection; no sealed byte is opened (I-6, I-7).
//   get      one entry and its re-send data; the mask runs again on the opened document.
//
// An entry of another owner, an entry of another connection, an expired entry and an unknown id all
// answer NOT_FOUND (H4, H5). `get` of the repository does not look at expiry, so this file does.
// No error and no log line carries a body, a header, a property or a key (I-10); a failure from the
// store or the sealer is replaced by a fixed text, its own text is dropped.
import type { CopyOutcome, PublishSummary } from '@app/contracts';
import { AppError, type Clock, type Logger } from '@app/kernel';
import {
  PUBLISH_HISTORY_MAX_PURGE,
  PUBLISH_HISTORY_MAX_SEALED_BYTES,
  PUBLISH_HISTORY_MAX_WINDOW,
  type FieldSealer,
  type PublishHistoryHead,
  type PublishHistoryRepository,
} from '@app/ports';

import type { PublishRecord, PublishRecorder } from '../deps';
import {
  maskMessage,
  remaskMessage,
  type BodyOmitted,
  type MaskedMessage,
  type WireHeader,
} from './mask';
import { sha256Hex } from './seal';

/** How long an entry is kept (H5): 30 days from the publish. */
export const PUBLISH_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** The most rows one purge pass removes (I-6). */
export const PUBLISH_HISTORY_PURGE_BATCH = 200;
/** The window size when the caller names none. */
export const PUBLISH_HISTORY_DEFAULT_WINDOW = 50;

const TABLE = 'publish_history';
const COLUMN = 'data_sealed';
/** The version of the sealed document, so a later layout can still read an old entry. */
const DOCUMENT_VERSION = 1;

const OUTCOMES: readonly CopyOutcome[] = [
  'confirmed',
  'nacked',
  'returned',
  'blocked',
  'timeout',
  'failed',
  'not-sent',
];

/** One entry of a window: the plain facts, no property, header or body. */
export interface HistorySummary {
  readonly id: string;
  /** When the publish ended (epoch ms). */
  readonly at: number;
  /** When the entry stops being returned (epoch ms). */
  readonly expiresAt: number;
  readonly vhost: string;
  readonly exchange: string;
  readonly routingKey: string;
  readonly copies: number;
  readonly summary: PublishSummary;
  /** The size of the body as published, whether or not it is kept. */
  readonly bodyBytes: number;
  /** sha256 of the body as published (hex). */
  readonly bodySha256: string;
}

/** What the studio is prefilled with to send a publish again. */
export interface ResendData {
  readonly exchange: string;
  readonly routingKey: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, WireHeader>>;
  /** Absent when `bodyOmitted` says why: the person supplies it. */
  readonly body?: { readonly encoding: 'utf8'; readonly data: string };
  readonly copies: number;
  /** Where a value was replaced: `prop:<name>`, `header:<name>`, `body`. The person types it again. */
  readonly masked: readonly string[];
  readonly bodyOmitted?: BodyOmitted;
}

export interface HistoryEntry {
  readonly entry: HistorySummary;
  readonly resend: ResendData;
}

export interface HistoryQuery {
  /** Required: a history is read one connection at a time. */
  readonly connectionId: string;
  readonly vhost?: string;
  readonly exchange?: string;
  /** Exact, case-sensitive prefix of the routing key. */
  readonly routingKeyPrefix?: string;
  /** At or after / at or before this time (epoch ms). */
  readonly from?: number;
  readonly to?: number;
  /** 1 to 200; 50 when absent. */
  readonly limit?: number;
  /** The `nextCursor` of the previous window. */
  readonly cursor?: string;
}

export interface HistoryWindow {
  readonly entries: readonly HistorySummary[];
  readonly nextCursor?: string;
}

export interface PublishHistoryDeps {
  readonly history: PublishHistoryRepository;
  /** Rejects while the vault is locked. */
  readonly sealer: FieldSealer;
  readonly newId: () => string;
  readonly clock: Clock;
  /** Redacts (I-10). The store logs fixed texts, never a value. */
  readonly logger: Logger;
}

/** The recorder the action calls, and the reads the two history actions need. */
export interface PublishHistory extends PublishRecorder {
  /** Returns the id of the new entry; rejects, with a fixed text, when it could not be written. */
  record(entry: PublishRecord): Promise<string>;
  window(ownerId: string, query: HistoryQuery): Promise<HistoryWindow>;
  get(ownerId: string, connectionId: string, id: string): Promise<HistoryEntry>;
  /** Deletes at most `limit` (200 by default, never more) expired rows; returns how many. */
  purge(limit?: number): Promise<number>;
}

// --- Fixed texts: nothing a store, a sealer or a document said is repeated ------------------------

const notFound = (): AppError =>
  new AppError('NOT_FOUND', {
    detail: 'There is no such publish history entry.',
  });

const unavailable = (): AppError =>
  new AppError('INTERNAL', {
    detail: 'The publish history could not be read or written.',
  });

const locked = (): AppError =>
  new AppError('GATE_BLOCKED', {
    detail:
      'The vault is locked, so the publish was not recorded. Unlock it and publish again.',
  });

const unreadable = (): AppError =>
  new AppError('INTERNAL', {
    detail:
      'A publish history entry could not be opened: the vault is locked, or the entry is damaged.',
  });

const tooBig = (): AppError =>
  new AppError('VALIDATION_FAILED', {
    detail: 'The publish is too large to keep in the history.',
  });

// --- The sealed document -------------------------------------------------------------------------

interface HistoryDocument {
  readonly v: typeof DOCUMENT_VERSION;
  readonly props: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, WireHeader>>;
  readonly body?: { readonly encoding: 'utf8'; readonly data: string };
  readonly bodyOmitted?: BodyOmitted;
  readonly masked: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The document a sealed entry opens to, or undefined when it is not one. */
function parseDocument(plaintext: Uint8Array): MaskedMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(plaintext).toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.v !== DOCUMENT_VERSION) return undefined;
  if (!isRecord(value.props)) return undefined;
  if (value.headers !== undefined && !isRecord(value.headers)) return undefined;
  const body = value.body;
  if (
    body !== undefined &&
    !(
      isRecord(body) &&
      body.encoding === 'utf8' &&
      typeof body.data === 'string'
    )
  ) {
    return undefined;
  }
  const omitted = value.bodyOmitted;
  if (
    omitted !== undefined &&
    omitted !== 'too-large' &&
    omitted !== 'binary'
  ) {
    return undefined;
  }
  const masked = value.masked;
  if (
    !Array.isArray(masked) ||
    !masked.every((place) => typeof place === 'string')
  ) {
    return undefined;
  }
  return {
    props: value.props,
    ...(value.headers === undefined
      ? {}
      : { headers: value.headers as Record<string, WireHeader> }),
    ...(body === undefined
      ? {}
      : {
          body: {
            encoding: 'utf8' as const,
            data: (body as { data: string }).data,
          },
        }),
    ...(omitted === undefined ? {} : { bodyOmitted: omitted }),
    masked: masked,
  };
}

/** The per-outcome counts as the plain `summary` column holds them. */
function encodeSummary(summary: Readonly<Record<CopyOutcome, number>>): string {
  const counts: Record<string, number> = {};
  for (const outcome of OUTCOMES) counts[outcome] = summary[outcome];
  return JSON.stringify(counts);
}

function decodeSummary(text: string): PublishSummary {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw unreadable();
  }
  if (!isRecord(value)) throw unreadable();
  const counts: Record<string, number> = {};
  for (const outcome of OUTCOMES) {
    const count = value[outcome];
    if (
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      throw unreadable();
    }
    counts[outcome] = count;
  }
  return counts as unknown as PublishSummary;
}

function toSummary(head: PublishHistoryHead): HistorySummary {
  return {
    id: head.id,
    at: head.at,
    expiresAt: head.expiresAt,
    vhost: head.vhost,
    exchange: head.exchange,
    routingKey: head.routingKey,
    copies: head.copies,
    summary: decodeSummary(head.summary),
    bodyBytes: head.bodyBytes,
    bodySha256: head.bodySha256,
  };
}

export function createPublishHistory(deps: PublishHistoryDeps): PublishHistory {
  const { history, sealer, newId, clock, logger } = deps;

  async function purge(limit = PUBLISH_HISTORY_PURGE_BATCH): Promise<number> {
    const batch = Math.min(
      Math.max(Math.trunc(limit), 1),
      PUBLISH_HISTORY_PURGE_BATCH,
      PUBLISH_HISTORY_MAX_PURGE,
    );
    try {
      return await history.purgeExpired(clock.now(), batch);
    } catch {
      throw unavailable();
    }
  }

  return {
    purge,

    async record(entry: PublishRecord): Promise<string> {
      const id = newId();
      const masked = maskMessage({
        props: entry.props,
        ...(entry.headers === undefined ? {} : { headers: entry.headers }),
        body: entry.body,
      });
      const document: HistoryDocument = {
        v: DOCUMENT_VERSION,
        props: masked.props,
        ...(masked.headers === undefined ? {} : { headers: masked.headers }),
        ...(masked.body === undefined ? {} : { body: masked.body }),
        ...(masked.bodyOmitted === undefined
          ? {}
          : { bodyOmitted: masked.bodyOmitted }),
        masked: masked.masked,
      };
      const plaintext = Buffer.from(JSON.stringify(document), 'utf8');
      let dataSealed: Uint8Array;
      try {
        if (plaintext.byteLength > PUBLISH_HISTORY_MAX_SEALED_BYTES) {
          throw tooBig();
        }
        try {
          dataSealed = await sealer.seal(TABLE, COLUMN, id, plaintext);
        } catch {
          throw locked();
        }
      } finally {
        plaintext.fill(0);
      }
      const bodySha256 = await sha256Hex(entry.body);
      try {
        await history.insert({
          id,
          ownerId: entry.ownerId,
          connectionId: entry.connectionId,
          vhost: entry.vhost,
          at: entry.at,
          expiresAt: entry.at + PUBLISH_HISTORY_RETENTION_MS,
          exchange: entry.exchange,
          routingKey: entry.routingKey,
          copies: entry.copies,
          summary: encodeSummary(entry.summary),
          bodyBytes: entry.body.byteLength,
          bodySha256,
          dataSealed,
        });
      } catch {
        throw unavailable();
      }
      // The entry stands; a purge that fails is for the next write to retry (H5).
      try {
        await purge();
      } catch {
        logger.warn(
          { event: 'messages.publish-history.purge-failed' },
          'expired publish history entries could not be purged',
        );
      }
      return id;
    },

    async window(ownerId, query) {
      const limit = query.limit ?? PUBLISH_HISTORY_DEFAULT_WINDOW;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > PUBLISH_HISTORY_MAX_WINDOW
      ) {
        throw new AppError('VALIDATION_FAILED', {
          detail: `The limit must be a whole number from 1 to ${String(PUBLISH_HISTORY_MAX_WINDOW)}.`,
        });
      }
      let page;
      try {
        page = await history.window(ownerId, {
          connectionId: query.connectionId,
          now: clock.now(),
          limit,
          ...(query.vhost === undefined ? {} : { vhost: query.vhost }),
          ...(query.exchange === undefined ? {} : { exchange: query.exchange }),
          ...(query.routingKeyPrefix === undefined
            ? {}
            : { routingKeyPrefix: query.routingKeyPrefix }),
          ...(query.from === undefined ? {} : { from: query.from }),
          ...(query.to === undefined ? {} : { to: query.to }),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        });
      } catch (error) {
        // The only input the repository refuses by itself is a cursor that is not one of its own.
        if (error instanceof RangeError) {
          throw new AppError('VALIDATION_FAILED', {
            detail: 'The cursor is not a publish history cursor.',
          });
        }
        throw unavailable();
      }
      return {
        entries: page.rows.map(toSummary),
        ...(page.nextCursor === undefined
          ? {}
          : { nextCursor: page.nextCursor }),
      };
    },

    async get(ownerId, connectionId, id) {
      let row;
      try {
        row = await history.get(ownerId, connectionId, id);
      } catch {
        throw unavailable();
      }
      // The repository does not look at expiry: an expired entry is gone even before it is purged.
      if (row === undefined || row.expiresAt <= clock.now()) throw notFound();
      let plaintext: Uint8Array;
      try {
        plaintext = await sealer.open(TABLE, COLUMN, row.id, row.dataSealed);
      } catch {
        throw unreadable();
      }
      const stored = parseDocument(plaintext);
      plaintext.fill(0);
      if (stored === undefined) throw unreadable();
      const message = remaskMessage(stored);
      return {
        entry: toSummary(row),
        resend: {
          exchange: row.exchange,
          routingKey: row.routingKey,
          props: message.props,
          ...(message.headers === undefined
            ? {}
            : { headers: message.headers }),
          ...(message.body === undefined ? {} : { body: message.body }),
          copies: row.copies,
          masked: message.masked,
          ...(message.bodyOmitted === undefined
            ? {}
            : { bodyOmitted: message.bodyOmitted }),
        },
      };
    },
  };
}
