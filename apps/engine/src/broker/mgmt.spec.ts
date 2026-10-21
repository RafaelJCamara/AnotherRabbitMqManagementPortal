// The adapter's errors as Problems (AC-10): `MgmtHttpError` carries a stable code, a safe detail and
// what the broker answered; a service sees an `AppError` with the same, and anything else untouched.
import { MgmtHttpError, errorForStatus } from '@app/adapter-mgmt-http';
import { AppError, toProblem } from '@app/kernel';
import type { MgmtReadPort } from '@app/ports';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { mapMgmtErrors } from './mgmt.ts';

const request = {
  connectionId: 'c1' as never,
  path: '/api/overview',
  schema: z.unknown(),
  lane: 'interactive' as const,
};
const failing = (error: Error): MgmtReadPort => ({
  get: () => Promise.reject(error),
  stream: () => Promise.reject(error),
});

describe('mapMgmtErrors', () => {
  it('AC-10 a management failure becomes an AppError with its code, detail and broker status', async () => {
    const mapped = mapMgmtErrors(
      failing(
        errorForStatus(403, '{"reason":"Not allowed"}', 'GET /api/overview'),
      ),
    );

    const error = await mapped
      .get(request, new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(toProblem(error)).toMatchObject({
      code: 'FORBIDDEN_BROKER',
      broker: { protocol: 'http', code: 403 },
    });
  });

  it('AC-10 a streamed body that fails midway fails with an AppError too, and anything else passes through', async () => {
    const boom = new MgmtHttpError('network', 'the connection failed');
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(boom),
      }),
    };
    const mapped = mapMgmtErrors({
      get: () => Promise.reject(new RangeError('not ours')),
      stream: () => Promise.resolve(body),
    });

    const stream = await mapped.stream(request, new AbortController().signal);
    const midway = await stream[Symbol.asyncIterator]()
      .next()
      .catch((caught: unknown) => caught);
    const other = await mapped
      .get(request, new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(midway).toBeInstanceOf(AppError);
    expect((midway as AppError).code).toBe('BROKER_UNREACHABLE');
    expect(other).toBeInstanceOf(RangeError);
  });
});
