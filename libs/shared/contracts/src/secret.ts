// Write-only secret fields (I-10, DC-45, blueprint 7). A secret (a password, a token, a private key,
// a passphrase) is typed in once. It may appear in the input of a POST, PUT or PATCH body, and
// nowhere else: never in an output, a topic frame, a query string or a path. What a client reads
// back is `SecretStatus`, whether a secret is set, never the secret.
//
// `secretInput()` marks the field `writeOnly` in the generated JSON Schema, which OpenAPI 3.1
// carries into the committed spec. `checkRegistry` (kit/invariants.ts) then rejects any action whose
// output or URL, and any topic whose params or items, contains a `writeOnly` field. The rule is
// about the contract: logging and storage are the engine's, covered by the canary-secret scan.
import { z } from 'zod';

/** The longest secret accepted: room for a PEM private key, small enough to bound a request (I-6). */
export const SECRET_MAX_CHARS = 8192;

/** A secret the user types in. Write-only: see the file comment for where it may appear. */
export function secretInput() {
  return z
    .string()
    .min(1)
    .max(SECRET_MAX_CHARS)
    .meta({ writeOnly: true, format: 'password' });
}

/** What a client may know about a stored secret. */
export const SecretStatusSchema = z.strictObject({
  isSet: z.boolean(),
  /** Epoch milliseconds of the last write; null when never set. */
  updatedAt: z.number().int().nonnegative().nullable(),
});
export type SecretStatus = z.infer<typeof SecretStatusSchema>;

/** True when a JSON Schema, at any depth, marks a value `writeOnly`. */
export function containsWriteOnly(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return false;
  if (Array.isArray(schema)) return schema.some(containsWriteOnly);
  const record = schema as Record<string, unknown>;
  if (record.writeOnly === true) return true;
  return Object.values(record).some(containsWriteOnly);
}

/** True when a zod schema has a write-only field at any depth, in the shape it is read or written. */
export function hasSecretField(
  schema: z.ZodType,
  io: 'input' | 'output',
): boolean {
  return containsWriteOnly(
    z.toJSONSchema(schema, { io, unrepresentable: 'any' }),
  );
}
