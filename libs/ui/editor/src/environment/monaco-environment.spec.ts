import { describe, expect, it } from 'vitest';

import {
  fakeRealm,
  type Minted,
  type WorkerCall,
} from './environment-spec-support';
import { installEditorEnvironment } from './monaco-environment';

describe('installEditorEnvironment', () => {
  it('M1-46 AC-1 installs exactly the two policies of the allow-list, once', () => {
    const realm = fakeRealm();

    installEditorEnvironment(realm);
    installEditorEnvironment(realm);

    expect(realm.trustedTypes?.created).toEqual([
      'app-worker-url',
      'app-monaco-html',
    ]);
    expect(realm.MonacoEnvironment?.getWorker).toBeTypeOf('function');
    expect(realm.MonacoEnvironment?.createTrustedTypesPolicy).toBeTypeOf(
      'function',
    );
  });

  it('M1-46 AC-6 works without Trusted Types and keeps the path list', () => {
    const realm = fakeRealm({ trustedTypes: false });

    expect(() => {
      installEditorEnvironment(realm);
    }).not.toThrow();
    const env = realm.MonacoEnvironment;
    // Monaco's own default (no Trusted Types) is left alone: no hook is installed.
    expect(env?.createTrustedTypesPolicy).toBeUndefined();

    env?.getWorker?.('1', 'json');
    env?.getWorker?.('2', 'typescript');
    expect(realm.workers).toEqual<WorkerCall[]>([
      {
        url: 'http://127.0.0.1:4200/workers/json.worker.js',
        options: { type: 'module', name: 'json' },
      },
      {
        url: 'http://127.0.0.1:4200/workers/editor.worker.js',
        options: { type: 'module', name: 'typescript' },
      },
    ]);

    // The list check still applies: a realm on an opaque origin mints nothing.
    const opaque = fakeRealm({ trustedTypes: false, origin: 'null' });
    installEditorEnvironment(opaque);
    expect(() => opaque.MonacoEnvironment?.getWorker?.('1', 'json')).toThrow(
      TypeError,
    );
    expect(opaque.workers).toEqual([]);
  });

  it('starts workers as module workers from a URL the worker policy minted', () => {
    const realm = fakeRealm();
    installEditorEnvironment(realm);

    realm.MonacoEnvironment?.getWorker?.('1', 'json');

    expect(realm.workers).toHaveLength(1);
    expect(realm.workers).toEqual<WorkerCall[]>([
      {
        url: {
          kind: 'script-url',
          policy: 'app-worker-url',
          value: 'http://127.0.0.1:4200/workers/json.worker.js',
        } satisfies Minted,
        options: { type: 'module', name: 'json' },
      },
    ]);
  });

  it('keeps what else was on MonacoEnvironment', () => {
    const realm = fakeRealm();
    realm.MonacoEnvironment = { globalAPI: false };

    installEditorEnvironment(realm);

    expect(realm.MonacoEnvironment).toMatchObject({ globalAPI: false });
  });

  it('retries after a refused policy without creating a name twice', () => {
    const realm = fakeRealm();
    realm.trustedTypes?.refused.add('app-monaco-html');

    expect(() => {
      installEditorEnvironment(realm);
    }).toThrow(TypeError);
    expect(realm.MonacoEnvironment).toBeUndefined();

    realm.trustedTypes?.refused.clear();
    installEditorEnvironment(realm);

    expect(realm.trustedTypes?.created).toEqual([
      'app-worker-url',
      'app-monaco-html',
    ]);
    expect(realm.MonacoEnvironment?.getWorker).toBeTypeOf('function');
  });

  it('installs the same environment object once, however often it is called', () => {
    const realm = fakeRealm();

    installEditorEnvironment(realm);
    const first = realm.MonacoEnvironment;
    installEditorEnvironment(realm);

    expect(first).toBeDefined();
    expect(realm.MonacoEnvironment).toBe(first);
  });

  it('puts the page nonce on the style elements Monaco creates', () => {
    const realm = fakeRealm({ nonce: 'N0nce' });
    const before = realm.document.createElement;

    installEditorEnvironment(realm);

    expect(realm.document.createElement).not.toBe(before);
    expect(realm.document.createElement('style')).toEqual({ nonce: 'N0nce' });
    expect(realm.document.createElement('div')).toEqual({});
  });

  it('does not create a policy twice when a later step fails and the call is retried', () => {
    let failing = true;
    const base = fakeRealm({ nonce: 'N0nce' });
    const realm = {
      ...base,
      document: {
        querySelector: (selector: string) => {
          if (failing) throw new Error('document gone');
          return base.document.querySelector(selector);
        },
        createElement: (tagName: string) => ({ tagName }),
      },
    };

    expect(() => {
      installEditorEnvironment(realm);
    }).toThrow('document gone');
    failing = false;
    installEditorEnvironment(realm);

    expect(base.trustedTypes?.created).toEqual([
      'app-worker-url',
      'app-monaco-html',
    ]);
    expect(realm.document.createElement('style')).toEqual({
      tagName: 'style',
      nonce: 'N0nce',
    });
  });

  it('keeps one environment per realm', () => {
    const first = fakeRealm();
    const second = fakeRealm();

    installEditorEnvironment(first);
    installEditorEnvironment(second);

    expect(first.trustedTypes?.created).toHaveLength(2);
    expect(second.trustedTypes?.created).toHaveLength(2);
    expect(first.MonacoEnvironment).not.toBe(second.MonacoEnvironment);
  });
});
