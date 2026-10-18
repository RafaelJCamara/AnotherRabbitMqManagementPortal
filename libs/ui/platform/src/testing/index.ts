// Test support for UI specs: a fake engine behind a MessagePort and behind fetch plus WebSocket.
// Imported as `@app/ui-platform/testing`; it is not part of the production API of ui-platform.
export {
  FakeConnection,
  FakeEngine,
  jsonResponse,
  problemResponse,
  type FakeEngineOptions,
  type FakeHandler,
} from './fake-engine';
export {
  createFakePort,
  type FakePort,
  type FakePortOptions,
} from './fake-port';
export { MemoryTransport } from './fake-transport';
export { tick, waitFor } from './wait';
export {
  FakeWebSocket,
  createFakeFetch,
  createFakeWebSocketFactory,
} from './fake-websocket';
