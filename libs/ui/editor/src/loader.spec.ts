import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { EditorHost } from './facade';
import { createMonacoLoader, EditorLoadError, MONACO_LOADER } from './loader';

const FAKE_HOST: EditorHost = {
  createEditor: () => {
    throw new Error('not used');
  },
};

describe('the Monaco loader', () => {
  it('M1-46 AC-5 installs the environment before Monaco, single flight, and retries after a failure', async () => {
    const log: string[] = [];
    let release: (host: EditorHost) => void = () => undefined;
    let outcome: 'wait' | 'fail' | 'ok' = 'wait';
    const loader = createMonacoLoader({
      install: () => log.push('install'),
      importHost: () => {
        log.push('factory');
        if (outcome === 'fail') return Promise.reject(new Error('chunk 404'));
        if (outcome === 'ok') return Promise.resolve(FAKE_HOST);
        return new Promise<EditorHost>((resolve) => {
          release = resolve;
        });
      },
    });

    // Two callers at once: one attempt, the environment first.
    const first = loader.load();
    const second = loader.load();
    expect(log).toEqual(['install', 'factory']);
    release(FAKE_HOST);
    expect(await first).toBe(FAKE_HOST);
    expect(await second).toBe(FAKE_HOST);

    // A success is kept: no new attempt.
    expect(await loader.load()).toBe(FAKE_HOST);
    expect(log).toEqual(['install', 'factory']);

    // A fresh loader: the factory fails, the failure is typed and not cached, the retry works.
    log.length = 0;
    outcome = 'fail';
    const retrying = createMonacoLoader({
      install: () => log.push('install'),
      importHost: () => {
        log.push('factory');
        return outcome === 'fail'
          ? Promise.reject(new Error('chunk 404'))
          : Promise.resolve(FAKE_HOST);
      },
    });
    const failed = await retrying.load().catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(EditorLoadError);
    expect((failed as EditorLoadError).code).toBe('module');
    expect(((failed as EditorLoadError).cause as Error).message).toBe(
      'chunk 404',
    );
    const concurrent = await Promise.allSettled([
      retrying.load(),
      retrying.load(),
    ]);
    expect(concurrent.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(log).toEqual(['install', 'factory', 'install', 'factory']);

    outcome = 'ok';
    expect(await retrying.load()).toBe(FAKE_HOST);
    expect(await retrying.load()).toBe(FAKE_HOST);
    expect(log).toEqual([
      'install',
      'factory',
      'install',
      'factory',
      'install',
      'factory',
    ]);
  });

  it('does not import Monaco when the environment cannot be installed', async () => {
    let imported = 0;
    const loader = createMonacoLoader({
      install: () => {
        throw new TypeError('policy refused');
      },
      importHost: () => {
        imported += 1;
        return Promise.resolve(FAKE_HOST);
      },
    });

    const failed = await loader.load().catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(EditorLoadError);
    expect((failed as EditorLoadError).code).toBe('environment');
    expect(imported).toBe(0);
  });

  it('turns a factory that throws synchronously into a typed rejection', async () => {
    const loader = createMonacoLoader({
      install: () => undefined,
      importHost: () => {
        throw new Error('sync');
      },
    });

    const failed = await loader.load().catch((error: unknown) => error);

    expect((failed as EditorLoadError).code).toBe('module');
  });

  it('keeps a typed error from the entry as it is', async () => {
    const own = new EditorLoadError('not-bundled', 'no entry');
    const loader = createMonacoLoader({
      install: () => undefined,
      importHost: () => Promise.reject(own),
    });

    await expect(loader.load()).rejects.toBe(own);
  });

  it('says plainly that this build has no Monaco entry yet', async () => {
    const loader = TestBed.inject(MONACO_LOADER);

    const failed = await loader.load().catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(EditorLoadError);
    expect((failed as EditorLoadError).code).toBe('not-bundled');
  });
});
