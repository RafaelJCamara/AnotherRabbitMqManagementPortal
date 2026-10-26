export { createMessagesModule } from './module';
export type {
  MessagesModuleDeps,
  PublishRecord,
  PublishRecorder,
} from './deps';
export type { EngineModule } from './module';
// Fakes for the ports of this module, for the architecture manifest and the HTTP specs.
export {
  createFakeSealer,
  createMemoryCaptureRepository,
  createMemoryPublishRecorder,
  createMessagesFakeDeps,
  sampleMessage,
  type FakeSealer,
  type MemoryCaptureRepository,
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
