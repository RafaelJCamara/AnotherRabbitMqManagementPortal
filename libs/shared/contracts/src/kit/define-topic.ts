// defineTopic: a live subscription declared once (ADR-005). `params` is what a client sends in
// `sub`, `item` is one element of a `data`, `snapshot` or `delta` frame.
import type { z } from 'zod';
import type { Permission, TopicId } from '../brands.ts';
import type { Qos } from '../config/env.ts';

export interface TopicDef<
  P extends z.ZodType = z.ZodType,
  T extends z.ZodType = z.ZodType,
> {
  readonly id: TopicId;
  readonly params: P;
  readonly item: T;
  readonly qos: Qos;
  readonly flow: 'credit' | 'snapshot-delta';
  readonly permission: Permission;
  /** Identity of an item; required by `snapshot-delta`, whose `removes` list carries these keys. */
  key?(item: z.infer<T>): string;
  readonly maxHz?: number;
  /** Every buffer is bounded by items and bytes (I-6). */
  readonly ring: { readonly items: number; readonly bytes: number };
}

export type TopicInit<P extends z.ZodType, T extends z.ZodType> = Omit<
  TopicDef<P, T>,
  'id'
> & { readonly id: string };

export function defineTopic<P extends z.ZodType, T extends z.ZodType>(
  init: TopicInit<P, T>,
): TopicDef<P, T> {
  return Object.freeze({ ...init, id: init.id as TopicId });
}

export type ParamsOf<T> = T extends TopicDef<infer P> ? z.infer<P> : never;
export type ItemOf<T> =
  T extends TopicDef<z.ZodType, infer I> ? z.infer<I> : never;
