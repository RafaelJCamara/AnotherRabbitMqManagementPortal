// Boot sequence (blueprint 10): "the preload sets `__APP_PLATFORM__`, otherwise the app reads
// `/bootstrap.json`". The first path is the desktop (the bridge, then the one engine MessagePort of
// this page load); the second is the browser (launch token, then HTTP plus WebSocket). Everything
// the boot touches in the page is passed in as `BootstrapEnvironment`, so tests need no browser.
import {
  makeEnvironmentProviders,
  type EnvironmentProviders,
} from '@angular/core';
import {
  BRIDGE_VERSION,
  EngineModeSchema,
  LAUNCH_TOKEN_PARAM,
  type PlatformBridge,
} from '@app/contracts';
import { z } from 'zod';

import {
  ENGINE_CREDENTIALS,
  type EngineCredentialsSource,
} from './credentials';
import { ENGINE_TRANSPORT, type EngineTransport } from './engine-transport';
import {
  HttpWsTransport,
  type FetchLike,
  type WebSocketFactory,
} from './httpws-transport';
import { MessagePortTransport } from './messageport-transport';
import {
  PLATFORM_BRIDGE,
  WebBridge,
  isPlatformBridge,
} from './platform-bridge';

/** What `GET /bootstrap.json` returns: the same facts as `meta.get`. */
export const BootstrapSchema = z.strictObject({
  engineVersion: z.string(),
  apiVersion: z.literal('v1'),
  mode: EngineModeSchema,
});
export type Bootstrap = z.infer<typeof BootstrapSchema>;

export const BOOTSTRAP_PATH = '/bootstrap.json';
/** The preload forwards the port with `postMessage({ t: 'engine-port' }, origin, [port])`. */
export const ENGINE_PORT_MESSAGE = 'engine-port';
/** The fragment parameter of the printed launch URL (#t=<token>), shared with the engine (issue #279). */
export { LAUNCH_TOKEN_PARAM };
export const LAUNCH_TOKEN_STORAGE_KEY = 'app.engine-token';
const LAUNCH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;
export const DEFAULT_PORT_TIMEOUT_MS = 10_000;

export type BootstrapErrorCode =
  | 'bridge-invalid'
  | 'bridge-version'
  | 'port-timeout'
  | 'bootstrap-unavailable'
  | 'bootstrap-invalid';

export class BootstrapError extends Error {
  readonly code: BootstrapErrorCode;

  constructor(code: BootstrapErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BootstrapError';
    this.code = code;
  }
}

export type PortWindow = Pick<
  Window,
  'addEventListener' | 'removeEventListener'
> & { readonly location: Pick<Location, 'origin'> };

export interface BootstrapEnvironment {
  /** `window.__APP_PLATFORM__`: the bridge the desktop preload exposes, or undefined. */
  readonly appPlatform: unknown;
  readonly location: Pick<Location, 'hash' | 'pathname' | 'search'>;
  readonly history: Pick<History, 'replaceState'>;
  readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined;
  readonly fetch: FetchLike;
  readonly webSocket?: WebSocketFactory;
  readonly portWindow: PortWindow;
  readonly portTimeoutMs?: number;
}

export function browserEnvironment(): BootstrapEnvironment {
  let storage: Storage | undefined;
  try {
    storage = globalThis.sessionStorage;
  } catch {
    storage = undefined;
  }
  return {
    appPlatform: (globalThis as { __APP_PLATFORM__?: unknown })
      .__APP_PLATFORM__,
    location: globalThis.location,
    history: globalThis.history,
    storage,
    fetch: (input, init) => globalThis.fetch(input, init),
    portWindow: globalThis.window,
  };
}

export interface PlatformSetup {
  readonly bridge: PlatformBridge;
  readonly transport: EngineTransport;
  readonly credentials: EngineCredentialsSource;
}

/** Providers for `ENGINE_TRANSPORT`, `PLATFORM_BRIDGE` and `ENGINE_CREDENTIALS`. */
export function providePlatform(setup: PlatformSetup): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: ENGINE_TRANSPORT, useValue: setup.transport },
    { provide: PLATFORM_BRIDGE, useValue: setup.bridge },
    { provide: ENGINE_CREDENTIALS, useValue: setup.credentials },
  ]);
}

/**
 * Registers for the port, asks the preload for it, and resolves with it. Only a message from this
 * very window, from its own origin, carrying exactly one port counts: nothing else may deliver the
 * engine port.
 */
export function waitForEnginePort(
  win: PortWindow,
  requestPort: () => void,
  timeoutMs: number = DEFAULT_PORT_TIMEOUT_MS,
): Promise<MessagePort> {
  return new Promise<MessagePort>((resolve, reject) => {
    const timer = setTimeout(() => {
      win.removeEventListener('message', onMessage);
      reject(
        new BootstrapError(
          'port-timeout',
          'The desktop shell did not deliver the engine port.',
        ),
      );
    }, timeoutMs);
    const onMessage = (event: MessageEvent<unknown>): void => {
      const data = event.data as { t?: unknown } | null;
      const [port, ...rest] = event.ports;
      if (
        event.source !== (win as unknown) ||
        event.origin !== win.location.origin ||
        data?.t !== ENGINE_PORT_MESSAGE ||
        port === undefined ||
        rest.length > 0
      ) {
        return;
      }
      clearTimeout(timer);
      win.removeEventListener('message', onMessage);
      resolve(port);
    };
    win.addEventListener('message', onMessage);
    try {
      requestPort();
    } catch (error) {
      clearTimeout(timer);
      win.removeEventListener('message', onMessage);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * The local launch token arrives in the URL fragment (blueprint 7.2). It moves to sessionStorage
 * and the URL is cleaned at once, so it is never in history, bookmarks or a copied link. Returns
 * the token of this tab, if any.
 */
export function consumeLaunchToken(
  env: Pick<BootstrapEnvironment, 'location' | 'history' | 'storage'>,
): string | undefined {
  const params = new URLSearchParams(env.location.hash.replace(/^#/, ''));
  const fromUrl = params.get(LAUNCH_TOKEN_PARAM);
  if (fromUrl !== null) {
    params.delete(LAUNCH_TOKEN_PARAM);
    const rest = params.toString();
    env.history.replaceState(
      null,
      '',
      `${env.location.pathname}${env.location.search}${rest === '' ? '' : `#${rest}`}`,
    );
    if (LAUNCH_TOKEN_PATTERN.test(fromUrl)) {
      try {
        env.storage?.setItem(LAUNCH_TOKEN_STORAGE_KEY, fromUrl);
      } catch {
        // Storage can be blocked. The token then lives for this page load only.
      }
      return fromUrl;
    }
  }
  try {
    const stored = env.storage?.getItem(LAUNCH_TOKEN_STORAGE_KEY) ?? undefined;
    return stored !== undefined && LAUNCH_TOKEN_PATTERN.test(stored)
      ? stored
      : undefined;
  } catch {
    return undefined;
  }
}

async function bootstrapDesktop(
  env: BootstrapEnvironment,
  candidate: unknown,
): Promise<PlatformSetup> {
  if (!isPlatformBridge(candidate)) {
    const version = (candidate as { bridgeVersion?: unknown } | null)
      ?.bridgeVersion;
    throw typeof version === 'number' && version !== BRIDGE_VERSION
      ? new BootstrapError(
          'bridge-version',
          `The shell offers bridge version ${String(version)}; this UI needs ${String(BRIDGE_VERSION)}.`,
        )
      : new BootstrapError(
          'bridge-invalid',
          'The desktop shell did not offer a PlatformBridge.',
        );
  }
  const request = candidate.requestEnginePort?.bind(candidate);
  if (request === undefined) {
    throw new BootstrapError(
      'bridge-invalid',
      'The desktop bridge cannot request an engine port.',
    );
  }
  const port = await waitForEnginePort(
    env.portWindow,
    request,
    env.portTimeoutMs,
  );
  return {
    bridge: candidate,
    transport: new MessagePortTransport(port),
    // The tunnel replaces the credentials (blueprint 3.3); the renderer holds none.
    credentials: () => ({}),
  };
}

async function bootstrapWeb(env: BootstrapEnvironment): Promise<PlatformSetup> {
  const token = consumeLaunchToken(env);
  const credentials: EngineCredentialsSource = () =>
    token === undefined ? {} : { bearer: token };
  let body: unknown;
  try {
    const response = await env.fetch(BOOTSTRAP_PATH, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new BootstrapError(
        'bootstrap-unavailable',
        `${BOOTSTRAP_PATH} answered HTTP ${String(response.status)}.`,
      );
    }
    body = await response.json();
  } catch (error) {
    throw error instanceof BootstrapError
      ? error
      : new BootstrapError(
          'bootstrap-unavailable',
          `${BOOTSTRAP_PATH} could not be read.`,
          error,
        );
  }
  const parsed = BootstrapSchema.safeParse(body);
  if (!parsed.success) {
    throw new BootstrapError(
      'bootstrap-invalid',
      `${BOOTSTRAP_PATH} does not match the bootstrap contract.`,
      parsed.error,
    );
  }
  const info = parsed.data;
  return {
    bridge: new WebBridge({
      appInfo: () =>
        Promise.resolve({ version: info.engineVersion, mode: info.mode }),
    }),
    transport: new HttpWsTransport({
      fetch: env.fetch,
      credentials,
      ...(env.webSocket === undefined ? {} : { webSocket: env.webSocket }),
    }),
    credentials,
  };
}

/** Picks the desktop or the web path and builds the transport and the bridge. */
export function bootstrapPlatform(
  env: BootstrapEnvironment = browserEnvironment(),
): Promise<PlatformSetup> {
  return env.appPlatform === undefined
    ? bootstrapWeb(env)
    : bootstrapDesktop(env, env.appPlatform);
}
