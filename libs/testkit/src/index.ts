// Public API of the testkit: the broker-lab helpers (M0-14), createTestEngine and the port fakes
// (M0-35).
export { startBroker, waitForManagement } from './broker-lab.ts';
export {
  API,
  createTestEngine,
  type InjectRequest,
  type TestEngine,
  type TestEngineOptions,
  type TestResponse,
} from './create-test-engine.ts';
export {
  createFakeMgmtRead,
  createFakeMgmtWrite,
  type FakeMgmtRead,
  type FakeMgmtWrite,
} from './fakes.ts';
export type {
  BrokerHandle,
  BrokerLabDeps,
  StartBrokerOptions,
  Variant,
} from './broker-lab.ts';
export { signLabToken } from './lab/material.ts';
export type { Check } from './lab/probes.ts';
export { verifyBroker } from './lab/verify.ts';
export { findBroker, loadBrokerVersions } from './lab/versions.ts';
export type { BrokerImage } from './lab/versions.ts';
