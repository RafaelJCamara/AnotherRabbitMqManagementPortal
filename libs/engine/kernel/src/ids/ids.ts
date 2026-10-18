// Identifier generation. ULIDs (26 characters, Crockford base32: 48 bits of millisecond time, then
// 80 bits of randomness) sort by creation time, which suits plan, job and receipt ids and tap queue
// names. Within one millisecond, and when the clock steps backwards, ids still increase.
import { randomBytes } from 'node:crypto';

import type { JobId, PlanId, ReceiptId } from '@app/contracts';

import { systemClock, type Clock } from '../clock/clock.ts';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TIME_LIMIT = 2 ** 48;
const RANDOM_BITS = 80n;
const RANDOM_LIMIT = 1n << RANDOM_BITS;

/** Fills a fresh array with `length` random bytes. Inject a seeded one in tests. */
export type RandomBytes = (length: number) => Uint8Array;

export const systemRandomBytes: RandomBytes = (length) => randomBytes(length);

export interface IdGenerator {
  /** A ULID. Ids from one generator strictly increase. */
  ulid(): string;
  /** A random (version 4) UUID. */
  uuid(): string;
  /** The id that ties one request, action or job to its log lines and its Problem. */
  correlationId(): string;
  planId(): PlanId;
  jobId(): JobId;
  receiptId(): ReceiptId;
}

export interface IdGeneratorOptions {
  clock?: Clock;
  randomBytes?: RandomBytes;
}

function toBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function encode(time: number, random: bigint): string {
  let value = (BigInt(time) << RANDOM_BITS) | random;
  let out = '';
  for (let i = 0; i < 26; i += 1) {
    out = ALPHABET.charAt(Number(value & 31n)) + out;
    value >>= 5n;
  }
  return out;
}

export function isUlid(value: string): boolean {
  // The first character carries only 3 bits of the 128, so it is at most 7.
  return ULID_PATTERN.test(value) && value.charAt(0) <= '7';
}

/** The creation time, in epoch milliseconds, encoded in a ULID. */
export function ulidTimestamp(id: string): number {
  if (!isUlid(id)) throw new RangeError('Not a ULID.');
  let time = 0;
  for (const char of id.slice(0, 10)) time = time * 32 + ALPHABET.indexOf(char);
  return time;
}

function formatUuid(bytes: Uint8Array): string {
  const copy = Uint8Array.from(bytes);
  copy[6] = ((copy[6] ?? 0) & 0x0f) | 0x40; // version 4
  copy[8] = ((copy[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(copy, (byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

export function createIdGenerator(
  options: IdGeneratorOptions = {},
): IdGenerator {
  const clock = options.clock ?? systemClock;
  const random = options.randomBytes ?? systemRandomBytes;
  let lastTime = -1;
  let lastRandom = 0n;

  const freshRandom = (): bigint => toBigInt(random(10));

  const ulid = (): string => {
    const wall = Math.floor(clock.now());
    if (!Number.isFinite(wall) || wall < 0 || wall >= TIME_LIMIT) {
      throw new RangeError('The clock is outside the ULID time range.');
    }
    // A clock that steps back keeps the last time, so ids never decrease.
    let time = Math.max(wall, lastTime);
    let value: bigint;
    if (time === lastTime) {
      value = lastRandom + 1n;
      if (value >= RANDOM_LIMIT) {
        // 2^80 ids in one millisecond: move to the next one rather than wrap.
        time += 1;
        value = freshRandom();
      }
    } else {
      value = freshRandom();
    }
    lastTime = time;
    lastRandom = value;
    return encode(time, value);
  };

  return {
    ulid,
    uuid: () => formatUuid(random(16)),
    correlationId: ulid,
    planId: () => ulid() as PlanId,
    jobId: () => ulid() as JobId,
    receiptId: () => ulid() as ReceiptId,
  };
}
