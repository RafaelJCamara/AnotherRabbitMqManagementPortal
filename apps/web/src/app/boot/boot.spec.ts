import type { ApplicationConfig, Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BRIDGE_VERSION } from '@app/contracts';
import {
  BootstrapError,
  WebBridge,
  type BootstrapEnvironment,
  type BootstrapErrorCode,
  type PlatformSetup,
} from '@app/ui-platform';
import {
  FakeEngine,
  MemoryTransport,
  createFakeFetch,
  jsonResponse,
  problemResponse,
} from '@app/ui-platform/testing';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { App } from '../app';
import system from '../i18n/en/system.json';
import { SCOPE_LOADERS } from '../i18n/i18n.config';
import { englishLoaders, settle } from '../i18n/test-fixtures';
import { bootApp, causeOf } from './boot';
import { BootFailed } from './boot-failed';
import { PAGE_RELOAD } from './page-reload';

const CAUSE_TEXT: Readonly<Record<BootstrapErrorCode | 'unknown', string>> = {
  'bridge-invalid': system.boot.cause.bridgeInvalid,
  'bridge-version': system.boot.cause.bridgeVersion,
  'port-timeout': system.boot.cause.portTimeout,
  'bootstrap-unavailable': system.boot.cause.bootstrapUnavailable,
  'bootstrap-invalid': system.boot.cause.bootstrapInvalid,
  unknown: system.boot.cause.unknown,
};

type Start = (
  root: Type<unknown>,
  config: ApplicationConfig,
) => Promise<unknown>;

function environment(
  engine: FakeEngine,
  overrides: Partial<BootstrapEnvironment> = {},
): BootstrapEnvironment {
  return {
    appPlatform: undefined,
    location: { hash: '', pathname: '/', search: '' },
    history: { replaceState: vi.fn() },
    storage: undefined,
    fetch: createFakeFetch(engine),
    portWindow: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: { origin: 'http://localhost' },
    },
    ...overrides,
  };
}

function firstStart(start: Mock<Start>): {
  readonly root: Type<unknown>;
  readonly config: ApplicationConfig;
} {
  const call = start.mock.calls[0];
  if (call === undefined) throw new Error('bootApp started nothing');
  return { root: call[0], config: call[1] };
}

/** Mounts what `bootApp` asked to start, with the English files, like the browser would. */
async function mount(
  root: Type<unknown>,
  config: ApplicationConfig,
  reload: () => void,
): Promise<HTMLElement> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      config.providers,
      { provide: SCOPE_LOADERS, useValue: englishLoaders() },
      { provide: PAGE_RELOAD, useValue: reload },
    ],
  });
  const fixture = TestBed.createComponent(root);
  await settle(fixture);
  return fixture.nativeElement as HTMLElement;
}

describe('bootApp', () => {
  it('AC-1 boot failure renders the cannot-start view and makes no engine call', async () => {
    const codes: readonly BootstrapErrorCode[] = [
      'bridge-invalid',
      'bridge-version',
      'port-timeout',
      'bootstrap-unavailable',
      'bootstrap-invalid',
    ];
    for (const code of codes) {
      const engine = new FakeEngine();
      const start = vi.fn<Start>(() => Promise.resolve());
      await bootApp(environment(engine), {
        bootstrapPlatform: () =>
          Promise.reject(
            new BootstrapError(
              code,
              'https://secret.example/boot?token=hunter2',
            ),
          ),
        start,
      });

      // The shell is never created: the one thing started is the cannot-start view.
      expect(start).toHaveBeenCalledTimes(1);
      const started = firstStart(start);
      expect(started.root).toBe(BootFailed);

      const reload = vi.fn();
      const host = await mount(BootFailed, started.config, reload);
      expect(host.querySelector('h1')?.textContent).toBe(system.boot.title);
      expect(host.textContent).toContain(CAUSE_TEXT[code]);
      // The class of failure only: not the error text, a URL or a secret.
      expect(host.textContent).not.toContain('secret.example');
      expect(host.textContent).not.toContain('hunter2');
      const button = host.querySelector('button');
      expect(button?.textContent.trim()).toBe(system.boot.reload);
      button?.click();
      expect(reload).toHaveBeenCalledTimes(1);

      expect(engine.requests).toEqual([]);
    }
  });

  it('shows the real failures of the platform boot without any request but the bootstrap one', async () => {
    const cases: readonly {
      readonly code: BootstrapErrorCode;
      readonly env: (engine: FakeEngine) => BootstrapEnvironment;
      readonly requests: readonly string[];
    }[] = [
      {
        code: 'bridge-invalid',
        env: (engine) => environment(engine, { appPlatform: {} }),
        requests: [],
      },
      {
        code: 'bridge-version',
        env: (engine) =>
          environment(engine, {
            appPlatform: { bridgeVersion: BRIDGE_VERSION + 1 },
          }),
        requests: [],
      },
      {
        code: 'bootstrap-unavailable',
        env: (engine) => environment(engine),
        requests: ['/bootstrap.json'],
      },
    ];
    for (const { code, env, requests } of cases) {
      const engine = new FakeEngine({
        handler: () =>
          problemResponse({
            type: 'about:blank',
            title: 'Unavailable',
            status: 503,
            code: 'INTERNAL',
            correlationId: 'x',
            retryable: true,
          }),
      });
      const start = vi.fn<Start>(() => Promise.resolve());
      await bootApp(env(engine), { start });
      const started = firstStart(start);
      expect(started.root).toBe(BootFailed);
      const host = await mount(BootFailed, started.config, vi.fn());
      expect(host.textContent).toContain(CAUSE_TEXT[code]);
      expect(engine.requests.map((request) => request.url)).toEqual(requests);
    }
  });

  it('treats an unexpected error as an unknown cause, and anything but a BootstrapError', () => {
    expect(causeOf(new TypeError('boom'))).toBe('unknown');
    expect(causeOf('boom')).toBe('unknown');
    expect(causeOf(new BootstrapError('port-timeout', 'x'))).toBe(
      'port-timeout',
    );
  });

  it('starts the app, not the failure view, when the platform is set up', async () => {
    const engine = new FakeEngine({
      handler: () =>
        jsonResponse(200, { engineVersion: '1.0.0', apiVersion: 'v1' }),
    });
    const setup: PlatformSetup = {
      bridge: new WebBridge({
        appInfo: () => Promise.resolve({ version: '1.0.0', mode: 'local' }),
      }),
      transport: new MemoryTransport(engine),
      credentials: () => ({}),
    };
    const start = vi.fn<Start>(() => Promise.resolve());
    await bootApp(environment(engine), {
      bootstrapPlatform: () => Promise.resolve(setup),
      start,
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]).toBe(App);
    expect(engine.requests).toEqual([]);
  });
});
