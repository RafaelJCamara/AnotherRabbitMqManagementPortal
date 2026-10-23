// Sealing and opening the parts of a saved message (M1-09). The vault's field cipher (AES-256-GCM, a
// fresh nonce per seal, the place in the authenticated data) does the cryptography; this file only
// decides where each part lives, so a value copied to another row, column or chunk fails to open:
//
//   captured_messages.body_sealed   AAD  captured_messages:body_sealed:<message id>
//   captured_messages.meta_sealed   AAD  captured_messages:meta_sealed:<message id>
//   capture_blob_chunks.sealed      AAD  capture_blob_chunks:sealed:<sha256>.<chunk index>
//
// A locked vault rejects every seal; the caller then stores nothing (never a plaintext fallback). No
// error built here names a key, a value or a place.
import { createHash } from 'node:crypto';

import { AppError } from '@app/kernel';
import type { FieldSealer } from '@app/ports';

import type { JsonValue } from './types';

/** Plaintext bytes in a blob chunk: one seal is a fraction of a millisecond (I-5). */
export const CHUNK_BYTES = 256 * 1024;
/** The largest body sealed in its row. */
export const INLINE_MAX_BYTES = 64 * 1024;
/** The largest body kept at all; one bigger is stored as `omitted`. The field cipher's own limit. */
export const BLOB_MAX_BYTES = 16 * 1024 * 1024;

const MESSAGES = 'captured_messages';
const CHUNKS = 'capture_blob_chunks';
/** Bytes hashed or sealed before the loop gets a turn. */
const SLICE_BYTES = 1024 * 1024;

export interface SealedMeta {
  readonly properties: Readonly<Record<string, JsonValue>>;
  readonly headers: Readonly<Record<string, JsonValue>>;
}

export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** sha256 in hex of `body`, giving the loop a turn every megabyte. */
export async function sha256Hex(body: Uint8Array): Promise<string> {
  const hash = createHash('sha256');
  for (let at = 0; at < body.byteLength; at += SLICE_BYTES) {
    hash.update(body.subarray(at, Math.min(at + SLICE_BYTES, body.byteLength)));
    if (at + SLICE_BYTES < body.byteLength) await yieldToLoop();
  }
  return hash.digest('hex');
}

const locked = (): AppError =>
  new AppError('GATE_BLOCKED', {
    detail:
      'The vault is locked, so nothing can be saved. Unlock it and try again.',
  });

const unreadable = (): AppError =>
  new AppError('INTERNAL', {
    detail:
      'A saved capture could not be opened: it is damaged, or sealed under a key this vault does not hold.',
  });

export interface CaptureSealer {
  sealBody(messageId: string, body: Uint8Array): Promise<Uint8Array>;
  openBody(messageId: string, sealed: Uint8Array): Promise<Uint8Array>;
  sealMeta(messageId: string, meta: SealedMeta): Promise<Uint8Array>;
  openMeta(messageId: string, sealed: Uint8Array): Promise<SealedMeta>;
  /** The body in sealed chunks of `CHUNK_BYTES`; the loop gets a turn between chunks. */
  sealChunks(ref: string, body: Uint8Array): Promise<Uint8Array[]>;
  openChunk(
    ref: string,
    index: number,
    sealed: Uint8Array,
  ): Promise<Uint8Array>;
}

export function createCaptureSealer(sealer: FieldSealer): CaptureSealer {
  const seal = async (
    table: string,
    column: string,
    rowId: string,
    plaintext: Uint8Array,
  ): Promise<Uint8Array> => {
    try {
      return await sealer.seal(table, column, rowId, plaintext);
    } catch {
      throw locked();
    }
  };
  const open = async (
    table: string,
    column: string,
    rowId: string,
    sealed: Uint8Array,
  ): Promise<Uint8Array> => {
    try {
      return await sealer.open(table, column, rowId, sealed);
    } catch {
      throw unreadable();
    }
  };

  return {
    sealBody: (id, body) => seal(MESSAGES, 'body_sealed', id, body),
    openBody: (id, sealed) => open(MESSAGES, 'body_sealed', id, sealed),

    async sealMeta(id, meta) {
      const plaintext = Buffer.from(JSON.stringify(meta), 'utf8');
      try {
        return await seal(MESSAGES, 'meta_sealed', id, plaintext);
      } finally {
        plaintext.fill(0);
      }
    },

    async openMeta(id, sealed) {
      const plaintext = await open(MESSAGES, 'meta_sealed', id, sealed);
      try {
        const parsed = JSON.parse(
          Buffer.from(plaintext).toString('utf8'),
        ) as SealedMeta | null;
        if (parsed === null || typeof parsed !== 'object') throw unreadable();
        return parsed;
      } catch (error) {
        throw error instanceof AppError ? error : unreadable();
      } finally {
        plaintext.fill(0);
      }
    },

    async sealChunks(ref, body) {
      const chunks: Uint8Array[] = [];
      for (let at = 0, index = 0; at < body.byteLength; at += CHUNK_BYTES) {
        chunks.push(
          await seal(
            CHUNKS,
            'sealed',
            `${ref}.${String(index)}`,
            body.subarray(at, Math.min(at + CHUNK_BYTES, body.byteLength)),
          ),
        );
        index += 1;
        if (index % 4 === 0) await yieldToLoop();
      }
      return chunks;
    },

    openChunk: (ref, index, sealed) =>
      open(CHUNKS, 'sealed', `${ref}.${String(index)}`, sealed),
  };
}
