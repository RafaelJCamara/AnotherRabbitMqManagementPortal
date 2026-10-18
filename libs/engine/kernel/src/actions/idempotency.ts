// Idempotency keys (blueprint 5.1 step 9): execute needs one, and it can be used once. A key is
// scoped to the principal that sent it, so nobody can use up another principal's key.
import type { ActionId, PlanId } from '@app/contracts';
import type { IdempotencyRepository } from '@app/ports';

import { AppError } from '../problem/problem.ts';

/** 8 to 128 characters of a URL-safe alphabet: a UUID or a ULID fits, a sentence does not. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:~-]{8,128}$/;

/** Returns the key when it is well-formed; otherwise `VALIDATION_FAILED`. */
export function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'idempotencyKey is required.',
    });
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new AppError('VALIDATION_FAILED', {
      detail:
        'idempotencyKey must be 8 to 128 characters of letters, digits and . _ : ~ -',
    });
  }
  return value;
}

const alreadyUsed = (): AppError =>
  new AppError('VALIDATION_FAILED', {
    detail: 'This idempotencyKey was already used; send a new one.',
    status: 409,
  });

export interface IdempotencyGuard {
  /** Throws when the key is malformed or already used. Does not take the key. */
  ensureUnused(principalId: string, key: unknown): Promise<string>;
  /** Takes the key atomically; throws when someone else took it first. */
  claim(
    principalId: string,
    key: string,
    info: { actionId: ActionId; planId: PlanId | null; at: number },
  ): Promise<void>;
}

export function createIdempotencyGuard(
  repository: IdempotencyRepository,
): IdempotencyGuard {
  return {
    async ensureUnused(principalId, key) {
      const parsed = parseIdempotencyKey(key);
      if (await repository.has(principalId, parsed)) throw alreadyUsed();
      return parsed;
    },
    async claim(principalId, key, info) {
      if (!(await repository.claim(principalId, key, info))) {
        throw alreadyUsed();
      }
    },
  };
}
