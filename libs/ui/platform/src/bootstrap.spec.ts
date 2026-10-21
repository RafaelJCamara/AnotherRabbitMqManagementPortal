import { TestBed } from '@angular/core/testing';
import { BRIDGE_VERSION, type PlatformBridge } from '@app/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BOOTSTRAP_PATH,
  BootstrapError,
  ENGINE_PORT_MESSAGE,
  LAUNCH_TOKEN_PARAM,
  LAUNCH_TOKEN_STORAGE_KEY,
  bootstrapPlatform,
  consumeLaunchToken,
  providePlatform,
  waitForEnginePort,
  type BootstrapEnvironment,
} from './bootstrap';
import { ENGINE_CREDENTIALS } from './credentials';
import { ENGINE_TRANSPORT } from './engine-transport';
import { HttpWsTransport } from './httpws-transport';
import { MessagePortTransport } from './messageport-transport';
import { PLATFORM_BRIDGE } from './platform-bridge';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const BOOTSTRAP = { engineVersion: '1.4.0', apiVersion: 'v1', mode: 'local' };

class FakeWindow extends EventTarget {
  readonly location = { origin: 'app://main' };

  post(options: {
    data?: unknown;
    origin?: string;
    source?: unknown;
    ports?: readonly unknown[];
  }): void {
    const event = new Event('message') as Event & {
      data: unknown;
      origin: string;
      source: unknown;
      ports: readonly unknown[];
    };
    event.data = 'data' in options ? options.data : { t: ENGINE_PORT_MESSAGE };
    event.origin = options.origin ?? 'app://main';
    event.source = 'source' in options ? options.source : this;
    event.ports = options.ports ?? [];
    this.dispatchEvent(event);
  }
}

function environment(
  overrides: Partial<BootstrapEnvironment> & { hash?: string } = {},
) {
  const store = new Map<string, string>();
  const replaceState = vi.fn();
  const win = new FakeWindow();
  const fetchSpy = vi.fn((input: string) =>
    Promise.resolve(
      input === BOOTSTRAP_PATH
        ? new Response(JSON.stringify(BOOTSTRAP), { status: 200 })
        : new Response('', { status: 404 }),
    ),
  );
  const env: BootstrapEnvironment = {
    appPlatform: undefined,
    location: { hash: overrides.hash ?? '', pathname: '/app/', search: '?q=1' },
    history: { replaceState },
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
      },
    },
    fetch: fetchSpy,
    portWindow: win,
    ...overrides,
  };
  return { env, store, replaceState, fetchSpy, win };
}

describe('consumeLaunchToken', () => {
  it('takes the token from the fragment, stores it for the tab and cleans the URL', () => {
    const { env, store, replaceState } = environment({
      hash: `#t=${TOKEN}`,
    });
    expect(consumeLaunchToken(env)).toBe(TOKEN);
    expect(store.get(LAUNCH_TOKEN_STORAGE_KEY)).toBe(TOKEN);
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/app/?q=1');
  });

  it('AC-13 accepts the launch URL exactly as the engine prints it (blueprint 1.2: #t=<token>, issue #279)', () => {
    const printed = `http://127.0.0.1:4310/#t=${TOKEN}`;
    const { env, store } = environment({ hash: new URL(printed).hash });
    expect(LAUNCH_TOKEN_PARAM).toBe('t');
    expect(consumeLaunchToken(env)).toBe(TOKEN);
    expect(store.get(LAUNCH_TOKEN_STORAGE_KEY)).toBe(TOKEN);
  });

  it('keeps the other fragment parameters', () => {
    const { env, replaceState } = environment({
      hash: `#view=a&t=${TOKEN}`,
    });
    consumeLaunchToken(env);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/app/?q=1#view=a');
  });

  it('reads the stored token when the URL has none', () => {
    const { env, store, replaceState } = environment();
    store.set(LAUNCH_TOKEN_STORAGE_KEY, TOKEN);
    expect(consumeLaunchToken(env)).toBe(TOKEN);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('removes a malformed token from the URL without using or storing it', () => {
    const { env, store, replaceState } = environment({ hash: '#t=short' });
    expect(consumeLaunchToken(env)).toBeUndefined();
    expect(store.size).toBe(0);
    expect(replaceState).toHaveBeenCalledOnce();
  });

  it('ignores a stored value that is not a token', () => {
    const { env, store } = environment();
    store.set(LAUNCH_TOKEN_STORAGE_KEY, '<script>');
    expect(consumeLaunchToken(env)).toBeUndefined();
  });

  it('still returns the token when storage is blocked', () => {
    const { env } = environment({
      hash: `#t=${TOKEN}`,
      storage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(consumeLaunchToken(env)).toBe(TOKEN);
  });
});

describe('waitForEnginePort', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const port = (): MessagePort => new MessageChannel().port2;

  it('registers before it asks, and resolves with the one port of a message from this window and origin', async () => {
    const { win } = environment();
    const delivered = port();
    const promise = waitForEnginePort(
      win,
      () => {
        win.post({ ports: [delivered] });
      },
      1000,
    );
    expect(await promise).toBe(delivered);
  });

  it('ignores messages from another origin or window, with no port or two ports, or other data', async () => {
    vi.useFakeTimers();
    const { win } = environment();
    const good = port();
    const promise = waitForEnginePort(win, () => undefined, 1000);
    win.post({ origin: 'https://evil.example', ports: [port()] });
    win.post({ source: {}, ports: [port()] });
    win.post({ ports: [] });
    win.post({ ports: [port(), port()] });
    win.post({ data: { t: 'other' }, ports: [port()] });
    win.post({ data: null, ports: [port()] });
    win.post({ ports: [good] });
    expect(await promise).toBe(good);
  });

  it('rejects after the timeout and stops listening', async () => {
    vi.useFakeTimers();
    const { win } = environment();
    const promise = waitForEnginePort(win, () => undefined, 500);
    const failure = expect(promise).rejects.toMatchObject({
      code: 'port-timeout',
    });
    await vi.advanceTimersByTimeAsync(500);
    await failure;
    const late = port();
    win.post({ ports: [late] });
    late.close();
  });

  it('rejects when the request itself throws', async () => {
    const { win } = environment();
    await expect(
      waitForEnginePort(win as unknown as Window, () => {
        throw new Error('no preload');
      }),
    ).rejects.toThrow('no preload');
  });
});

describe('bootstrapPlatform', () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  describe('in the browser', () => {
    it('reads /bootstrap.json and builds the web bridge and the HTTP transport', async () => {
      const { env, fetchSpy } = environment();
      const setup = await bootstrapPlatform(env);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(BOOTSTRAP_PATH);
      expect(setup.bridge.kind).toBe('web');
      expect(await setup.bridge.appInfo()).toEqual({
        version: '1.4.0',
        mode: 'local',
      });
      expect(setup.transport).toBeInstanceOf(HttpWsTransport);
      expect(setup.transport.kind).toBe('http');
    });

    it('sends the launch token as the bearer credential and leaves it out of the URL', async () => {
      const { env, replaceState } = environment({ hash: `#t=${TOKEN}` });
      const setup = await bootstrapPlatform(env);
      expect(setup.credentials()).toEqual({ bearer: TOKEN });
      expect(replaceState).toHaveBeenCalledOnce();
    });

    it('has no credentials when there is no token', async () => {
      const { env } = environment();
      expect((await bootstrapPlatform(env)).credentials()).toEqual({});
    });

    it('fails with bootstrap-unavailable when the file cannot be fetched or read', async () => {
      const missing = environment({
        fetch: () => Promise.resolve(new Response('', { status: 404 })),
      });
      await expect(bootstrapPlatform(missing.env)).rejects.toMatchObject({
        code: 'bootstrap-unavailable',
      });
      const down = environment({
        fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      });
      await expect(bootstrapPlatform(down.env)).rejects.toMatchObject({
        code: 'bootstrap-unavailable',
      });
      const notJson = environment({
        fetch: () => Promise.resolve(new Response('<html>', { status: 200 })),
      });
      await expect(bootstrapPlatform(notJson.env)).rejects.toBeInstanceOf(
        BootstrapError,
      );
    });

    it('fails with bootstrap-invalid when the file does not match the contract', async () => {
      for (const body of [
        { ...BOOTSTRAP, apiVersion: 'v2' },
        { ...BOOTSTRAP, mode: 'cloud' },
        { ...BOOTSTRAP, extra: true },
        { engineVersion: '1' },
      ]) {
        const { env } = environment({
          fetch: () =>
            Promise.resolve(
              new Response(JSON.stringify(body), { status: 200 }),
            ),
        });
        await expect(bootstrapPlatform(env)).rejects.toMatchObject({
          code: 'bootstrap-invalid',
        });
      }
    });
  });

  describe('in the desktop shell', () => {
    function desktopBridge(
      win: FakeWindow,
      options: { bridgeVersion?: number; withPort?: boolean } = {},
    ): PlatformBridge {
      return {
        kind: 'desktop',
        bridgeVersion: (options.bridgeVersion ?? BRIDGE_VERSION) as 1,
        ...(options.withPort === false
          ? {}
          : {
              requestEnginePort: () => {
                const channel = new MessageChannel();
                closers.push(() => {
                  channel.port1.close();
                });
                win.post({ ports: [channel.port2] });
              },
            }),
        pickSaveTarget: () => Promise.resolve(null),
        openExternal: () => Promise.resolve('opened'),
        notify: () => Promise.resolve(),
        setMenu: () => undefined,
        onMenuCommand: () => () => undefined,
        appInfo: () => Promise.resolve({ version: '1.4.0', mode: 'desktop' }),
      };
    }

    it('asks the preload bridge for the port and builds the MessagePort transport', async () => {
      const { env, win, fetchSpy } = environment();
      const bridge = desktopBridge(win);
      const setup = await bootstrapPlatform({ ...env, appPlatform: bridge });
      closers.push(() => {
        (setup.transport as MessagePortTransport).close();
      });
      expect(setup.bridge).toBe(bridge);
      expect(setup.transport).toBeInstanceOf(MessagePortTransport);
      expect(setup.transport.kind).toBe('messageport');
      // The tunnel adds the credentials; the renderer holds none, and reads no bootstrap file.
      expect(setup.credentials()).toEqual({});
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('refuses a bridge of another version, naming both versions', async () => {
      const { env, win } = environment();
      const bridge = desktopBridge(win, { bridgeVersion: 2 });
      await expect(
        bootstrapPlatform({ ...env, appPlatform: bridge }),
      ).rejects.toMatchObject({ code: 'bridge-version' });
    });

    it('refuses something that is not a bridge', async () => {
      const { env } = environment();
      await expect(
        bootstrapPlatform({ ...env, appPlatform: { hello: 'world' } }),
      ).rejects.toMatchObject({ code: 'bridge-invalid' });
    });

    it('refuses a bridge that cannot request an engine port', async () => {
      const { env, win } = environment();
      const bridge = desktopBridge(win, { withPort: false });
      await expect(
        bootstrapPlatform({ ...env, appPlatform: bridge }),
      ).rejects.toMatchObject({ code: 'bridge-invalid' });
    });
  });
});

describe('providePlatform', () => {
  let setup: Awaited<ReturnType<typeof bootstrapPlatform>>;
  beforeEach(async () => {
    setup = await bootstrapPlatform(environment({ hash: `#t=${TOKEN}` }).env);
  });

  it('provides the transport, the bridge and the credentials', () => {
    TestBed.configureTestingModule({ providers: [providePlatform(setup)] });
    expect(TestBed.inject(ENGINE_TRANSPORT)).toBe(setup.transport);
    expect(TestBed.inject(PLATFORM_BRIDGE)).toBe(setup.bridge);
    expect(TestBed.inject(ENGINE_CREDENTIALS)()).toEqual({ bearer: TOKEN });
  });
});
