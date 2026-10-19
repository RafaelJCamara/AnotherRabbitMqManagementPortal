export { createCapabilitiesModule } from './module';
export type { CapabilitiesModuleDeps } from './deps';
export type { EngineModule } from './module';
export { buildProfile, type BuildInput } from './profile-builder';
export { canonicalJson, fingerprintOf } from './fingerprint';
export { runProbe, type ProbeRun, type StepResult } from './probe/run';
// Fakes for the ports of this module, for the architecture manifest and the HTTP specs.
export {
  brokerError,
  createCapabilitiesFakeDeps,
  createFakeWire,
  createMemoryProfileStore,
  createScriptedMgmt,
  FAKE_CONNECTION_ID,
  MINIMAL_BROKER,
  type CapabilitiesFakeDeps,
  type FakeWire,
  type RecordedRequest,
  type Route,
  type ScriptedMgmt,
} from './testing';
export { createProfileGetAction } from './actions/profile-get';
export { createProbeRunAction } from './actions/probe-run';
