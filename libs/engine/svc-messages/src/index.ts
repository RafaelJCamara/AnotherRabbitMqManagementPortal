export { createMessagesModule } from './module';
export type {
  MessagesActionDeps,
  MessagesModuleDeps,
  PublishRecord,
  PublishHistoryReader,
  PublishRecorder,
} from './deps';
export type { EngineModule } from './module';
// Fakes for the ports of this module, for the architecture manifest and the HTTP specs.
export {
  createFakeSealer,
  createMemoryCaptureRepository,
  createMemoryPublishHistory,
  createMemoryPublishRecorder,
  createMessagesFakeDeps,
  createMessagesFakeModuleDeps,
  sampleMessage,
  type FakeSealer,
  type MemoryCaptureRepository,
  type MemoryPublishHistory,
  type MemoryPublishRecorder,
} from './testing';
// The capture store (M1-09): sealed captures, blobs, the redacted projection and the ingest queue.
export {
  createCaptureStore,
  DEFAULT_CAPTURE_STORE_OPTIONS,
  MAX_BLOB_READ_BYTES,
  type CaptureStore,
  type CaptureStoreDeps,
  type CaptureStoreOptions,
} from './internal/capture-store';
export { BLOB_MAX_BYTES, CHUNK_BYTES, INLINE_MAX_BYTES } from './internal/seal';
export { buildProjection, type Projection } from './internal/projection';
export type {
  AppendOptions,
  AppendReceipt,
  CaptureInput,
  CapturePersist,
  CaptureQuery,
  CaptureStats,
  CaptureView,
  CapturedMessageDetail,
  CapturedMessageInput,
  CapturedMessageView,
  JsonValue,
  SaveOptions,
  SaveResult,
} from './internal/types';
export { createMessagesPublishAction } from './actions/messages-publish';
// The publish history (M1-19, PUB-02): masked, sealed and kept 30 days per owner and connection.
export {
  createPublishHistory,
  PUBLISH_HISTORY_DEFAULT_WINDOW,
  PUBLISH_HISTORY_PURGE_BATCH,
  PUBLISH_HISTORY_RETENTION_MS,
  type HistoryEntry,
  type HistoryQuery,
  type HistorySummary,
  type HistoryWindow,
  type PublishHistory,
  type PublishHistoryDeps,
  type ResendData,
} from './internal/publish-history';
export {
  maskBody,
  maskMessage,
  MASK_MAX_BODY_BYTES,
  type BodyOmitted,
  type MaskedMessage,
} from './internal/mask';
export { createMessagesPublishHistoryListAction } from './actions/messages-publish-history-list';
export { createMessagesPublishHistoryGetAction } from './actions/messages-publish-history-get';
