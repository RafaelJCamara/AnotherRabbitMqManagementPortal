// How an action's input maps onto its HTTP binding. Shared by the kit invariants and the emitter,
// so the check and the generated document cannot disagree.
import { z } from 'zod';
import type { ActionDef } from './define-action.ts';

/** `{cid}` and `{qkey}` segments of `/connections/{cid}/queues/{qkey}`, in order. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([^{}/]+)\}/g)].map((match) => match[1] ?? '');
}

/** The fields of an object input, or undefined when the input is not an object schema. */
export function inputShape(
  action: ActionDef,
): Readonly<Record<string, z.ZodType>> | undefined {
  return action.input instanceof z.ZodObject ? action.input.shape : undefined;
}

export function isOptionalField(field: z.ZodType): boolean {
  return field.safeParse(undefined).success;
}

/** A mutating action changes state or touches messages; it must audit attempt and outcome. */
export function isMutating(action: ActionDef): boolean {
  return action.kind !== 'query' || action.mcp?.mutating === true;
}
