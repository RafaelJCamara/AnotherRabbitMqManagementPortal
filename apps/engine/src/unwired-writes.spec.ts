import type { Principal } from '@app/ports';
import { describe, expect, it } from 'vitest';

import { createUnwiredWrites } from './unwired-writes.ts';

const signal = new AbortController().signal;

describe('the write ports of this build', () => {
  it('every write refuses with CAPABILITY_MISSING: nothing here can change a broker', async () => {
    const writes = createUnwiredWrites();
    const principal: Principal = {
      kind: 'system',
      id: 'p',
      display: 'p',
      roles: [],
      surface: 'system',
      unattended: true,
    };
    const refusals = await Promise.all(
      [
        () => writes.mgmt.send({} as never, signal),
        () => writes.connections.peek('c' as never, 'v', principal, signal),
        () => writes.connections.source('c' as never, 'v', principal, signal),
        () => writes.connections.publish('c' as never, 'v', principal, signal),
        () => writes.connections.observe('c' as never, 'v', principal, signal),
      ].map((call) =>
        call().then(
          () => 'resolved',
          (error: unknown) => error,
        ),
      ),
    );

    for (const refusal of refusals) {
      expect(refusal).toMatchObject({ code: 'CAPABILITY_MISSING' });
    }
    expect(writes.connections.budget('c' as never, 'v')).toEqual([]);
    expect(writes.connections.usage('c' as never)).toEqual({
      inUse: 0,
      max: 0,
      queued: 0,
      brokerMax: null,
    });
  });

  it('its refusal says what is missing and carries nothing from the request', async () => {
    const writes = createUnwiredWrites();

    const error = await writes.mgmt
      .send({ path: '/secret-path', body: 'topsecret' } as never, signal)
      .catch((e: unknown) => e as Error);

    expect(String((error as { detail?: string }).detail)).toContain(
      'no broker adapter',
    );
    expect(JSON.stringify(error)).not.toContain('topsecret');
  });
});
