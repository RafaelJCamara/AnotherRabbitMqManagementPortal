// Runs one query of this module the way the engine does, over the fakes of its ports. Shared by the
// specs of the actions; edit it, not the generated specs.
import type { ActionDef, OutputOf } from '@app/contracts';
import {
  createTestContext,
  createTestExecutor,
  type ActionImpl,
} from '@app/kernel';

import { createTopologyFakeDeps, type TopologyFakeDeps } from '../testing';

export type FakeOptions = NonNullable<
  Parameters<typeof createTopologyFakeDeps>[0]
>;

/**
 * The output of `def` for `input` (the connection is `c1`), or a rejection with the Problem. `deps`
 * lets a spec read what the scripted broker saw.
 */
export async function runQuery<A extends ActionDef>(
  def: A,
  create: (deps: TopologyFakeDeps) => ActionImpl<A>,
  input: Record<string, unknown>,
  options: FakeOptions = {},
): Promise<{ output: OutputOf<A>; deps: TopologyFakeDeps }> {
  const deps = createTopologyFakeDeps(options);
  const engine = createTestExecutor();
  engine.executor.register(create(deps));
  const outcome = await engine.executor.run(
    def,
    { cid: 'c1', ...input },
    createTestContext({ idempotencyKey: 'run-fixture-key-0001' }),
  );
  if (outcome.kind !== 'output') throw new Error(`got ${outcome.kind}`);
  return { output: outcome.output, deps };
}
