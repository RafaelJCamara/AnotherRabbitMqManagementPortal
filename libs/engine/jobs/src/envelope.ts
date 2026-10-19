// What the runner stores for a job. The store sees ciphertext only: the requester, the fields the
// job is bound to (type, version, plan hash, the idempotency and concurrency keys) and the input
// are sealed together, so a row edited in the database by someone without the key cannot make a
// job run as another principal, for another plan, or with another input. The plaintext columns
// stay for lookups, and `openJobInput` refuses a row whose columns and envelope disagree.
//
// Checkpoints and results are sealed on their own. All three are bound to the job id (AAD), so a
// ciphertext copied from one job to another does not open.
import {
  AppError,
  decodeValue,
  encodeValue,
  isPrincipal,
  type PayloadCipher,
} from '@app/kernel';
import type { JobRecord, Principal } from '@app/ports';
import type { JobId } from '@app/contracts';

/** The most a sealed input, checkpoint or result may take (I-6). */
export const MAX_SEALED_BYTES = 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface JobEnvelope {
  readonly v: 1;
  readonly type: string;
  readonly version: number;
  readonly planHash: string | null;
  readonly idempotencyKey: string;
  readonly concurrencyKey: string | null;
  /** The requester: the principal the job acts for. */
  readonly requester: Principal;
  readonly input: unknown;
}

const aad = (kind: 'input' | 'checkpoint' | 'result', id: JobId): string =>
  `jobs:${kind}:${id}`;

async function seal(
  cipher: PayloadCipher,
  kind: 'input' | 'checkpoint' | 'result',
  id: JobId,
  value: unknown,
): Promise<Uint8Array> {
  let text: string;
  try {
    text = encodeValue(value);
  } catch (cause) {
    throw new AppError('VALIDATION_FAILED', {
      detail: `The job ${kind} cannot be stored: ${cause instanceof Error ? cause.message : 'unsupported value'}`,
    });
  }
  const plain = encoder.encode(text);
  if (plain.byteLength > MAX_SEALED_BYTES) {
    throw new AppError('TOKEN_TOO_LARGE', {
      detail: `The job ${kind} is over ${String(MAX_SEALED_BYTES)} bytes.`,
    });
  }
  return cipher.encrypt(plain, aad(kind, id));
}

async function open(
  cipher: PayloadCipher,
  kind: 'input' | 'checkpoint' | 'result',
  id: JobId,
  sealed: Uint8Array,
): Promise<unknown> {
  const plain = await cipher.decrypt(sealed, aad(kind, id));
  return decodeValue(decoder.decode(plain));
}

export function sealJobInput(
  cipher: PayloadCipher,
  id: JobId,
  envelope: JobEnvelope,
): Promise<Uint8Array> {
  return seal(cipher, 'input', id, envelope);
}

export const sealCheckpoint = (
  cipher: PayloadCipher,
  id: JobId,
  value: unknown,
): Promise<Uint8Array> => seal(cipher, 'checkpoint', id, value);

export const sealResult = (
  cipher: PayloadCipher,
  id: JobId,
  value: unknown,
): Promise<Uint8Array> => seal(cipher, 'result', id, value);

export const openCheckpoint = (
  cipher: PayloadCipher,
  id: JobId,
  sealed: Uint8Array,
): Promise<unknown> => open(cipher, 'checkpoint', id, sealed);

const tampered = (): AppError =>
  new AppError('INTERNAL', {
    detail: 'The stored job does not match what was sealed with it.',
  });

/**
 * Opens a job's input and checks the envelope against the plaintext columns. Throws when the
 * ciphertext does not open (wrong key, other job, edited bytes) or when a column was changed.
 */
export async function openJobInput(
  cipher: PayloadCipher,
  record: JobRecord,
): Promise<JobEnvelope> {
  const value = await open(cipher, 'input', record.id, record.input);
  if (typeof value !== 'object' || value === null) throw tampered();
  const envelope = value as Partial<JobEnvelope>;
  if (
    envelope.v !== 1 ||
    envelope.type !== record.type ||
    envelope.version !== record.version ||
    envelope.planHash !== record.planHash ||
    envelope.idempotencyKey !== record.idempotencyKey ||
    envelope.concurrencyKey !== record.concurrencyKey ||
    !isPrincipal(envelope.requester) ||
    envelope.requester.id !== record.principalId ||
    (envelope.requester.onBehalfOf?.id ?? null) !== record.onBehalfOfId
  ) {
    throw tampered();
  }
  return envelope as JobEnvelope;
}
