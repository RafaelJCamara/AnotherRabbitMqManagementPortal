// implementAction: the one way to give an action behaviour (I-2). It checks the declaration is
// complete enough to be safe and mints the only kind of object the executor will register.
//
// Two layers hold the funnel:
//   - at run time `isImplementedAction` is true only for what this function returned (a WeakSet,
//     so a literal `{ def, execute }`, a spread copy or a Proxy is refused by `register`);
//   - at build time the architecture test (tools/arch-tests) fails any file outside the engine's
//     plumbing that names a write-capable port without calling `implementAction` or `defineJob`.
import type { ActionDef } from '@app/contracts';

import type { ActionBody, ActionImpl } from './types.ts';

const minted = new WeakSet();

/**
 * Does the action change state or touch messages? Everything but a query does (a peek counts), and
 * so does a query that declares its MCP tool mutating: the prod lock and the audit must not be
 * escapable by calling a mutation a query.
 */
export function isMutatingAction(def: ActionDef): boolean {
  return def.kind !== 'query' || def.mcp?.mutating === true;
}

/** True only for an object `implementAction` returned. */
export function isImplementedAction(value: unknown): value is ActionImpl {
  return typeof value === 'object' && value !== null && minted.has(value);
}

export function implementAction<A extends ActionDef, P = unknown>(
  def: A,
  body: ActionBody<A, P>,
): ActionImpl<A, P> {
  const fail = (message: string): never => {
    throw new TypeError(`implementAction(${def.id}): ${message}`);
  };
  const mutating = isMutatingAction(def);

  if (typeof body.execute !== 'function') fail('execute is required.');
  if (mutating && def.audit !== 'attempt+outcome') {
    fail(
      `a ${def.kind} action needs audit 'attempt+outcome'; got '${def.audit}'.`,
    );
  }
  // A mutating action can be planned at any time (the environment policy may raise `planning`),
  // so it needs both halves of the two-phase contract whatever it declares today.
  if (
    (mutating || def.planning !== 'none') &&
    typeof body.plan !== 'function'
  ) {
    fail('plan() is required (reads only).');
  }
  if (
    (mutating || def.planning !== 'none') &&
    typeof body.revalidate !== 'function'
  ) {
    fail('revalidate() is required (the TOCTOU re-check).');
  }

  const impl: ActionImpl<A, P> = Object.freeze({
    def,
    execute: body.execute.bind(body),
    ...(body.plan === undefined ? {} : { plan: body.plan.bind(body) }),
    ...(body.revalidate === undefined
      ? {}
      : { revalidate: body.revalidate.bind(body) }),
  });
  minted.add(impl);
  return impl;
}
