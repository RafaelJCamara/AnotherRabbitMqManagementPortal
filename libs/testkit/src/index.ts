// Public API of the testkit. Only the broker-lab helpers exist so far (M0-14).
export { startBroker, waitForManagement } from './broker-lab.ts';
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
