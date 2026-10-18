// Public API of the transport kit (M0-32). The kit is capped at 800 lines by ADR-004 (kit-loc).
export { buildApp, type BuildAppOptions, type TransportAuth } from './app.ts';
export { createCarrierAuth } from './auth/carrier.ts';
export {
  CARRIER_HEADER,
  type Authenticator,
  type AuthInput,
} from './auth/credentials.ts';
export { createLocalTokenAuth } from './auth/local-token.ts';
export { INTERNAL_HOST } from './guards/host-origin.ts';
export {
  PROBLEM_CONTENT_TYPE,
  httpError,
  sendProblem,
} from './problem-handler.ts';
export { API_PREFIX } from './router.ts';
export {
  NONCE_PLACEHOLDER,
  contentSecurityPolicy,
  type StaticUiOptions,
} from './static-ui.ts';
