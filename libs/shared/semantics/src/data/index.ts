// The registry data this release ships. Each table is a typed constant in its own `*.data.ts` file;
// this file only assembles them. M0-12 and M0-13 replace the empty tables below with their data.
import type { RegistryData } from '../registry.ts';
import { settleMatrix } from './settle-matrix.data.ts';

export const SEMANTICS_VERSION = 'sem-2026.10.1';

export const registryData: RegistryData = {
  version: SEMANTICS_VERSION,
  cells: [...settleMatrix],
  warnings: [],
  hazards: [],
  gates: [],
  peekCaps: [],
  tapRules: [],
};
