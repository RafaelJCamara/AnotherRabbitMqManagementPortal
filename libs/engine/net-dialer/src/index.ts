// @app/net-dialer: the single outbound socket path (M0-26, I-9, DC-43).
export {
  createDialer,
  type CheckResult,
  type CheckTarget,
  type DialResult,
  type DialTarget,
  type Dialer,
  type DialerLog,
  type DialerOptions,
  type DirectRoute,
} from './dialer.ts';
export { type Forwarder, type ForwarderOptions } from './forwarder.ts';
export {
  allowAllPolicy,
  systemResolver,
  type EgressDecision,
  type EgressPolicy,
  type EgressRequest,
  type ResolvedAddress,
  type Resolver,
} from './policy-hook.ts';
export {
  createUndiciConnector,
  type ConnectorCallback,
  type ConnectorOptions,
  type UndiciConnector,
  type UndiciConnectorOptions,
} from './undici-connector.ts';
