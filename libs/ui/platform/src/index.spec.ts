import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('ui-platform public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'API_PREFIX',
      'BOOTSTRAP_PATH',
      'BootstrapError',
      'BootstrapSchema',
      'DEFAULT_MAX_PENDING_FRAMES',
      'DEFAULT_MAX_RESPONSE_BYTES',
      'DEFAULT_PORT_TIMEOUT_MS',
      'ENGINE_CREDENTIALS',
      'ENGINE_PORT_MESSAGE',
      'ENGINE_TRANSPORT',
      'EngineTransportHttpBackend',
      'FrameQueue',
      'HttpWsTransport',
      'LAUNCH_TOKEN_PARAM',
      'LAUNCH_TOKEN_STORAGE_KEY',
      'LIVE_PATH',
      'LIVE_SUBPROTOCOL',
      'LIVE_TICKET_PATH',
      'LIVE_TICKET_SUBPROTOCOL_PREFIX',
      'MessagePortTransport',
      'PLATFORM_BRIDGE',
      'TransportError',
      'WebBridge',
      'bootstrapPlatform',
      'browserEnvironment',
      'consumeLaunchToken',
      'credentialHeaders',
      'isEngineUrl',
      'isPlatformBridge',
      'isTransportError',
      'providePlatform',
      'waitForEnginePort',
    ]);
  });
});
