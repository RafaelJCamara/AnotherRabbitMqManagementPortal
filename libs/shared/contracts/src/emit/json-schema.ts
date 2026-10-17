// z.toJSONSchema, narrowed to what the emitted documents embed: one self-contained schema per
// call. The `$schema` keyword is dropped (both documents declare their dialect once), and a schema
// that needs `$defs` or `$ref` is rejected because the document would carry dangling local pointers.
import { z } from 'zod';

export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}

export const SPEC_VERSION = '1.0.0';
export const SPEC_TITLE = '<Product> engine API';

export function schemaOf(
  schema: z.ZodType,
  io: 'input' | 'output',
): JsonObject {
  const rest = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
  }) as JsonObject;
  delete rest.$schema;
  // A local pointer (`#/$defs/x`, `#`) would resolve against the host document, not this schema.
  if ('$defs' in rest || JSON.stringify(rest).includes('"$ref"')) {
    throw new Error(
      'Recursive or reused-by-reference schemas are not supported in specs yet',
    );
  }
  return rest;
}

/** Sorted keys and a trailing newline, so regenerating is byte-for-byte reproducible. */
export function serialize(document: Json): string {
  const sort = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(sort);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, sort(value[key] as Json)]),
      );
    }
    return value;
  };
  return `${JSON.stringify(sort(document), null, 2)}\n`;
}
