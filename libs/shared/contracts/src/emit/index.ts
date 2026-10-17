// The committed specs and how to tell that they drifted from the registry.
import type { Registry } from '../kit/invariants.ts';
import { emitAsyncApi } from './asyncapi.ts';
import { serialize } from './json-schema.ts';
import { emitOpenApi } from './openapi.ts';

/** File name (inside docs/api) to file content. */
export function emitSpecs(registry: Registry): Record<string, string> {
  return {
    'openapi.v1.json': serialize(emitOpenApi(registry)),
    'asyncapi.v1.json': serialize(emitAsyncApi(registry)),
  };
}

/** Names of the files whose committed content differs from what the registry emits. */
export function specDrift(
  registry: Registry,
  committed: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.entries(emitSpecs(registry))
    .filter(([name, content]) => committed[name] !== content)
    .map(([name]) => name);
}

export { emitAsyncApi } from './asyncapi.ts';
export { emitOpenApi } from './openapi.ts';
