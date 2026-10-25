// Fakes for the ports of this module, shared by its specs, by the architecture manifest
// (tools/arch-tests) and by the HTTP specs (libs/testkit). Give each port in deps.ts a fake here.
import type { PeekModuleDeps } from './deps';

export function createPeekFakeDeps(): PeekModuleDeps {
  return {};
}
