// An endpoint of the management API as data: its path template, the zod schema of its answer and,
// for a list, the columns the engine reads. The catalogue (`index.ts`) is what the client matches a
// request path against, so paging, `columns=` and the stats flags apply to every request for it,
// however the caller built the path.
import type { ConnectionId } from '@app/contracts';
import type { Lane, MgmtGetRequest, MgmtQuery } from '@app/ports';
import type { z } from 'zod';

import { pagedSchema, type Page } from '../paging.ts';

export interface EndpointSpec<T = unknown> {
  /** Stable id, `<resource>.<variant>`. */
  readonly id: string;
  /** `/api/queues/{vhost}/{name}`: each `{x}` is one percent-encoded path segment. */
  readonly template: string;
  /** A list the broker pages (and the client always pages). */
  readonly paged: boolean;
  /** The fields the engine reads, sent as `columns=` so the broker computes nothing else. */
  readonly columns: readonly string[] | undefined;
  /** Whether the answer carries statistics that `disable_stats` leaves out. */
  readonly stats: boolean;
  readonly schema: z.ZodType<T>;
  readonly pattern: RegExp;
}

const PLACEHOLDER = /\{([a-zA-Z]+)\}/g;

function patternOf(template: string): RegExp {
  const source = template
    .split(PLACEHOLDER)
    .map((part, index) =>
      index % 2 === 1 ? '([^/]+)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${source}$`);
}

interface Definition<T> {
  readonly id: string;
  readonly template: string;
  readonly schema: z.ZodType<T>;
  readonly columns?: readonly string[];
  readonly stats?: boolean;
}

/** A single object or a fixed-shape answer. */
export function defineEndpoint<T>(definition: Definition<T>): EndpointSpec<T> {
  return {
    id: definition.id,
    template: definition.template,
    paged: false,
    columns: definition.columns,
    stats: definition.stats ?? false,
    schema: definition.schema,
    pattern: patternOf(definition.template),
  };
}

/** A list: always requested paged, read into a `Page`. */
export function defineList<T>(
  definition: Omit<Definition<T>, 'schema'> & { readonly item: z.ZodType<T> },
): EndpointSpec<Page<T>> {
  return {
    id: definition.id,
    template: definition.template,
    paged: true,
    columns: definition.columns,
    stats: definition.stats ?? false,
    schema: pagedSchema(definition.item),
    pattern: patternOf(definition.template),
  };
}

/** Fills the placeholders; every value is percent-encoded, so a vhost `/` becomes `%2F`. */
export function fillTemplate(
  template: string,
  params: Readonly<Record<string, string>> = {},
): string {
  return template.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new TypeError(`the path ${template} needs the parameter ${name}`);
    }
    return encodeURIComponent(value);
  });
}

/** The request the scheduler will run for an endpoint. */
export function getRequest<T>(
  spec: EndpointSpec<T>,
  args: {
    readonly connectionId: ConnectionId;
    readonly lane: Lane;
    readonly params?: Readonly<Record<string, string>>;
    readonly query?: MgmtQuery;
  },
): MgmtGetRequest<T> {
  return {
    connectionId: args.connectionId,
    path: fillTemplate(spec.template, args.params),
    ...(args.query === undefined ? {} : { query: args.query }),
    schema: spec.schema,
    lane: args.lane,
  };
}
