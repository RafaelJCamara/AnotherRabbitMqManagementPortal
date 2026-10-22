// The runtime half of `scope: 'local'` (OQ-783). The syntactic arch test (tools/arch-tests) reads one
// module and misses `ctx['writes']`, a computed key, `Reflect.get(ctx, 'writes')`, a renamed alias
// and a helper in another file. This is the check that cannot be walked around: an action that
// declares `scope: 'local'` is handed a `writes` bundle in which every access throws, so the broker
// ports are not reachable at all, whatever the module's source looks like.
import { AppError } from '../problem/problem.ts';
import type { ExecutorWrite } from './types.ts';

export interface LocalWritesTrap {
  /** Stands where `ExecuteContext.writes` stands. Every use of it throws; nothing is ever returned. */
  readonly writes: ExecutorWrite;
  /** True once anything touched the bundle, even when the action swallowed the error. */
  tripped(): boolean;
}

/**
 * A `writes` bundle for a local action. Every proxy trap (get, has, ownKeys, set, ...) throws an
 * INTERNAL Problem that names the action and says what went wrong, with no stack-bearing detail
 * from the broker side because none is ever reached. `tripped()` lets the executor fail the call
 * even when the action catches the error, so a swallowed trap cannot end in an audited success.
 */
export function createLocalWritesTrap(actionId: string): LocalWritesTrap {
  let touched = false;
  const refuse = (): never => {
    touched = true;
    throw new AppError('INTERNAL', {
      detail: `The action ${actionId} declares scope 'local' and reached for a broker write port; it was stopped.`,
    });
  };
  const handler: ProxyHandler<object> = {
    get: refuse,
    set: refuse,
    has: refuse,
    ownKeys: refuse,
    getOwnPropertyDescriptor: refuse,
    defineProperty: refuse,
    deleteProperty: refuse,
    getPrototypeOf: refuse,
    setPrototypeOf: refuse,
    isExtensible: refuse,
    preventExtensions: refuse,
  };
  return {
    writes: new Proxy({}, handler) as ExecutorWrite,
    tripped: () => touched,
  };
}
