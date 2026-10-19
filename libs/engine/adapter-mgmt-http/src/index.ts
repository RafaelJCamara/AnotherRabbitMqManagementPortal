// @app/adapter-mgmt-http: the management HTTP API behind MgmtReadPort and MgmtWritePort (M0-24,
// ADR-009, DC-32/48/55). Sockets come from the Dialer (I-9); the BrokerScheduler is the only
// caller (I-8), so nothing here schedules, caches or retries.
export {
  createMgmtHttpClient,
  type MgmtAuth,
  type MgmtHttpClient,
  type MgmtHttpClientOptions,
  type MgmtTarget,
  type MgmtTargetResolver,
} from './client.ts';
export {
  ENDPOINTS,
  defineEndpoint,
  defineList,
  fillTemplate,
  getRequest,
  matchEndpoint,
  type EndpointSpec,
} from './endpoints/index.ts';
export * as endpoints from './endpoints/index.ts';
export {
  MgmtHttpError,
  errorForStatus,
  safeText,
  type MgmtHttpErrorCode,
  type MgmtHttpErrorOptions,
  type MgmtHttpReason,
} from './errors.ts';
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  clampPageSize,
  pagedSchema,
  type Page,
} from './paging.ts';
export {
  isGetMessagesPath,
  isRabbitMqFamily,
  normaliseGetMessagesBody,
  productFromOverview,
} from './product.ts';
export {
  assertSafePath,
  shapeRequest,
  type CapabilityCheck,
  type QueryProfile,
  type ShapedRequest,
} from './query.ts';
export { DIAL_PURPOSE, type DialInfo } from './transport.ts';
