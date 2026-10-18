// engineResource: a signal-based read of one query action, `httpResource` plus `parse` (blueprint
// 3.8). The input is a function of signals; the resource reloads when it changes and stays idle
// while it returns undefined.
import { httpResource, type HttpResourceRef } from '@angular/common/http';
import { Injector, inject } from '@angular/core';
import type { ActionDef, InputOf, OutputOf } from '@app/contracts';

import { buildEngineRequest } from './engine-request';
import { ENGINE_PARSE } from './parse-mode';

export interface EngineResourceOptions {
  /** Needed when called outside an injection context. */
  readonly injector?: Injector;
}

/**
 * Only a `query` action can be a resource: a resource re-runs whenever its input changes, and
 * re-running a command or a peek would repeat its effect.
 */
export function engineResource<A extends ActionDef>(
  action: A,
  input: () => InputOf<A> | undefined,
  options: EngineResourceOptions = {},
): HttpResourceRef<OutputOf<A> | undefined> {
  if (action.kind !== 'query' || action.mcp?.mutating === true) {
    throw new TypeError(
      `${action.id} is not a read: engineResource takes query actions only; use EngineApi.`,
    );
  }
  const injector = options.injector ?? inject(Injector);
  const parse = injector.get(ENGINE_PARSE);
  return httpResource<OutputOf<A>>(
    () => {
      const value = input();
      if (value === undefined) return undefined;
      const request = buildEngineRequest(action, value);
      return {
        url: request.url,
        method: request.method,
        ...(request.params === undefined
          ? {}
          : {
              params: request.params as Record<
                string,
                string | number | boolean
              >,
            }),
        ...(request.body === undefined ? {} : { body: request.body }),
      };
    },
    {
      injector,
      parse: (raw) => (parse ? action.output.parse(raw) : raw) as OutputOf<A>,
    },
  );
}
