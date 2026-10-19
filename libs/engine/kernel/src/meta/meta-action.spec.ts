import { describe, expect, it } from 'vitest';

import { createTestContext, createTestExecutor } from '../actions/testing.ts';
import { createMetaAction } from './meta-action.ts';

describe('meta.get', () => {
  it('reports the version, the API version and the mode it was given, and nothing else', async () => {
    const parts = createTestExecutor();
    parts.executor.register(
      createMetaAction({ engineVersion: '1.2.3', mode: 'local' }),
    );
    const def = parts.executor.registered().find((d) => d.id === 'meta.get');
    if (def === undefined) throw new Error('meta.get is not registered');

    const outcome = await parts.executor.run(
      def,
      {},
      createTestContext({ mode: 'local' }),
    );

    expect(outcome).toEqual({
      kind: 'output',
      output: { engineVersion: '1.2.3', apiVersion: 'v1', mode: 'local' },
    });
  });
});
