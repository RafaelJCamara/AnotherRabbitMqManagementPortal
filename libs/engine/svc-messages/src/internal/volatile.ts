// Volatile captures (M1-09, blueprint 6.3): messages kept in memory only, in a ring bounded by items
// and bytes. Nothing is written to the database before the person saves the capture, and nothing
// survives a restart. An evicted message is counted (I-13). The search reads the same redacted
// projection a saved capture indexes, so what is found in memory is what would be found once saved.
import { BoundedRing } from '@app/kernel';
import type { MessageQuery, MessageSummary } from '@app/ports';

import type { CaptureView, CapturedMessageInput } from './types';

export interface VolatileMessage {
  readonly id: string;
  readonly input: CapturedMessageInput;
  readonly sha256: string;
  readonly metaText: string;
  readonly bodyText: string | null;
  /** Bytes the message holds in memory (the ring's measure). */
  readonly bytes: number;
}

export interface VolatileCapture {
  view: CaptureView;
  readonly ring: BoundedRing<VolatileMessage>;
  /** Messages pushed out of the ring (or too large to enter it). */
  evicted: number;
  /** The saved capture made from this one, once the person saved it. */
  savedAs: string | undefined;
}

export function createVolatileCapture(
  view: CaptureView,
  limits: { maxItems: number; maxBytes: number },
): VolatileCapture {
  const capture: VolatileCapture = {
    view,
    evicted: 0,
    savedAs: undefined,
    ring: new BoundedRing<VolatileMessage>({
      maxItems: limits.maxItems,
      maxBytes: limits.maxBytes,
      sizeOf: (message) => message.bytes,
      onDrop: (event) => {
        capture.evicted += event.items;
      },
    }),
  };
  return capture;
}

/** The words of a text, lower case, letters and digits (the index's own idea of a word). */
function wordsOf(text: string): string[] {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w.toLowerCase());
}

function queryTerms(text: string): { word: string; prefix: boolean }[] {
  return (text.slice(0, 2048).match(/[\p{L}\p{N}]+\*?/gu) ?? [])
    .slice(0, 16)
    .map((raw) => {
      const prefix = raw.endsWith('*');
      return {
        word: (prefix ? raw.slice(0, -1) : raw).toLowerCase().slice(0, 64),
        prefix,
      };
    });
}

export function summaryOf(
  captureId: string,
  m: VolatileMessage,
): MessageSummary {
  return {
    id: m.id,
    captureId,
    receivedAt: m.input.receivedAt,
    exchange: m.input.exchange,
    routingKey: m.input.routingKey,
    source: m.input.source ?? '',
    contentType: m.input.contentType ?? null,
    redelivered: m.input.redelivered ?? false,
    size: m.input.body.byteLength,
    bodySha256: m.sha256,
    bodyState: 'inline',
    blobRef: null,
    bodyIndexed: m.bodyText !== null,
    preview: m.bodyText === null ? null : m.bodyText.slice(0, 200),
  };
}

/** A window of the ring's messages: the same filters and order as the saved query. */
export function queryVolatile(
  capture: VolatileCapture,
  query: MessageQuery,
  maxWindow: number,
): { items: MessageSummary[]; nextCursor?: string } {
  const terms = query.text === undefined ? [] : queryTerms(query.text);
  const wantsText = query.text !== undefined && query.text.trim() !== '';
  if (wantsText && terms.length === 0) return { items: [] };
  const limit = Math.min(Math.max(Math.trunc(query.limit), 1), maxWindow);
  const ordered = capture.ring
    .toArray()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (query.order === 'desc') ordered.reverse();
  const matches: MessageSummary[] = [];
  for (const m of ordered) {
    if (query.cursor !== undefined) {
      if (query.order === 'asc' ? m.id <= query.cursor : m.id >= query.cursor) {
        continue;
      }
    }
    const i = m.input;
    if (query.exchange !== undefined && i.exchange !== query.exchange) continue;
    if (query.routingKey !== undefined && i.routingKey !== query.routingKey) {
      continue;
    }
    if (query.source !== undefined && (i.source ?? '') !== query.source) {
      continue;
    }
    if (
      query.contentType !== undefined &&
      (i.contentType ?? null) !== query.contentType
    ) {
      continue;
    }
    if (
      query.redelivered !== undefined &&
      (i.redelivered ?? false) !== query.redelivered
    ) {
      continue;
    }
    const size = i.body.byteLength;
    if (query.sizeMin !== undefined && size < query.sizeMin) continue;
    if (query.sizeMax !== undefined && size > query.sizeMax) continue;
    if (query.from !== undefined && i.receivedAt < query.from) continue;
    if (query.to !== undefined && i.receivedAt >= query.to) continue;
    if (terms.length > 0) {
      const words = wordsOf(`${m.metaText} ${m.bodyText ?? ''}`);
      const all = terms.every((t) =>
        words.some((w) => (t.prefix ? w.startsWith(t.word) : w === t.word)),
      );
      if (!all) continue;
    }
    matches.push(summaryOf(capture.view.id, m));
    if (matches.length > limit) break;
  }
  const page = matches.slice(0, limit);
  const last = page.at(-1);
  return matches.length > limit && last !== undefined
    ? { items: page, nextCursor: last.id }
    : { items: page };
}
