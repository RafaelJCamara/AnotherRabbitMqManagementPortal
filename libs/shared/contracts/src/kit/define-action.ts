// defineAction: one declaration per capability (ADR-003). The router, the MCP tools, the CLI, the
// OpenAPI document and the UI client are all derived from it. Declaring is cheap and never throws;
// `checkRegistry` (kit/invariants.ts) is what rejects a bad declaration.
import type { z } from 'zod';
import type { ActionId, ConnectionId, Permission } from '../brands.ts';
import type { EnvClass, Risk } from '../config/env.ts';

export interface TargetRef {
  connectionId?: ConnectionId;
  vhost?: string;
  kind?: string;
  name?: string;
  messageCount?: number;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ActionKind = 'query' | 'command' | 'peek' | 'job';

export interface ActionDef<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> {
  readonly id: ActionId;
  readonly kind: ActionKind;
  readonly summary: string;
  readonly input: I;
  readonly output: O;
  readonly permission: Permission;
  /** A function lets the risk depend on the input and the environment class. */
  readonly risk: Risk | RiskFn<I>;
  /** The environment policy may raise it. */
  readonly planning: 'none' | 'optional' | 'required';
  readonly confirm?: {
    requiredWhen(env: EnvClass, risk: Risk): boolean;
    phrase(input: z.infer<I>): string;
  };
  readonly audit: 'none' | 'outcome' | 'attempt+outcome';
  target(input: z.infer<I>): TargetRef;
  readonly http?: { method: HttpMethod; path: `/${string}` };
  readonly mcp?: {
    expose: boolean;
    mutating: boolean;
    title: string;
    description: string;
  };
  readonly cli?: { command: string };
  /** Contract version that introduced the action, `major.minor`. */
  readonly since: `${number}.${number}`;
}

// A method-shaped alias keeps `ActionDef<SpecificInput>` assignable to `ActionDef` in a registry.
type RiskFn<I extends z.ZodType> = {
  bivarianceHack(input: z.infer<I>, env: EnvClass): Risk;
}['bivarianceHack'];

/** Everything `defineAction` takes; the id is a plain string and is branded here. */
export type ActionInit<I extends z.ZodType, O extends z.ZodType> = Omit<
  ActionDef<I, O>,
  'id'
> & { readonly id: string };

export function defineAction<I extends z.ZodType, O extends z.ZodType>(
  init: ActionInit<I, O>,
): ActionDef<I, O> {
  return Object.freeze({ ...init, id: init.id as ActionId });
}

export type InputOf<A> = A extends ActionDef<infer I> ? z.infer<I> : never;
export type OutputOf<A> =
  A extends ActionDef<z.ZodType, infer O> ? z.infer<O> : never;
