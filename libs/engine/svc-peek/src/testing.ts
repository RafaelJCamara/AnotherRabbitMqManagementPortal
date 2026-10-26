// Fakes for the ports of this module, shared by its specs, by the architecture manifest
// (tools/arch-tests) and by the HTTP specs (libs/testkit). Give each port in deps.ts a fake here.
import { createManualClock } from '@app/kernel';

import type { PeekModuleDeps } from './deps';
import {
  createFakeEvidence,
  createScriptedManagement,
} from './internal/preflight-fakes.ts';

export function createPeekFakeDeps(): PeekModuleDeps {
  return {
    mgmt: createScriptedManagement({ vhost: '/' }).mgmt,
    evidence: createFakeEvidence(),
    clock: createManualClock(),
    quarantinePrefix: 'product',
  };
}
