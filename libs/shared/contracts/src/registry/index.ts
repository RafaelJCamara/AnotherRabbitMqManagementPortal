// The contract registry. A new action or topic is added here, then `pnpm nx run contracts:api-docs`
// regenerates the committed specs; `contracts:api-docs-check` fails on any drift.
import type { Registry } from '../kit/invariants.ts';
import { metaGet } from './meta.ts';
import { opsArm, opsDisarm } from './ops.ts';

export const registry: Registry = {
  actions: [metaGet, opsArm, opsDisarm],
  topics: [],
};
