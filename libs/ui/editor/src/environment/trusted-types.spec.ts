import { describe, expect, it } from 'vitest';

import { fakeRealm, type Minted } from './environment-spec-support';
import { installEditorEnvironment } from './monaco-environment';
import { checkWorkerUrl, EDITOR_WORKER_PATHS } from './trusted-types';

const ORIGIN = 'http://127.0.0.1:4200';
const LOCATION = { origin: ORIGIN, href: `${ORIGIN}/c/dev/publish` };

/** The ten policy names Monaco 0.57 asks for, one of them twice (S-04). */
const MONACO_POLICY_NAMES = [
  'editorViewLayer',
  'tokenizeToString',
  'standaloneColorizer',
  'defaultWorkerFactory',
  'defaultWorkerFactory',
  'diffEditorWidget',
  'stickyScrollViewLayer',
  'domLineBreaksComputer',
  'viewLineRenderer',
  'editorGhostText',
];

describe('the worker policy', () => {
  it('M1-46 AC-2 the worker policy mints only the listed same-origin paths', () => {
    const realm = fakeRealm();
    installEditorEnvironment(realm);

    const mint = (value: string): unknown => {
      const hook = realm.MonacoEnvironment?.createTrustedTypesPolicy;
      const policy = hook?.('probe', { createScriptURL: (input) => input });
      return policy?.createScriptURL?.(value);
    };

    expect(EDITOR_WORKER_PATHS).toEqual([
      '/workers/editor.worker.js',
      '/workers/json.worker.js',
    ]);
    expect(mint('/workers/editor.worker.js')).toEqual<Minted>({
      kind: 'script-url',
      policy: 'app-worker-url',
      value: `${ORIGIN}/workers/editor.worker.js`,
    });
    for (const rejected of [
      '/workers/other.js',
      'https://evil.example/workers/json.worker.js',
      '//evil.example/x.js',
      '/workers/../x.js',
      '/workers/json.worker.js?x=1',
      '/workers/json.worker.js#x',
      '/workers/editor.worker.js/../json.worker.js',
      '\\workers\\json.worker.js',
      '/workers/%65ditor.worker.js',
      'workers/editor.worker.js',
      `http://user@127.0.0.1:4200/workers/editor.worker.js`,
      'javascript:alert(1)',
      'data:text/javascript,1',
      'blob:http://127.0.0.1:4200/x',
      '',
    ]) {
      expect(() => mint(rejected), rejected).toThrow(TypeError);
    }
  });

  it('accepts the listed path with the page origin and every listed path', () => {
    for (const path of EDITOR_WORKER_PATHS) {
      expect(checkWorkerUrl(path, LOCATION)).toBe(`${ORIGIN}${path}`);
      expect(checkWorkerUrl(`${ORIGIN}${path}`, LOCATION)).toBe(
        `${ORIGIN}${path}`,
      );
    }
  });

  it('mints nothing on an opaque origin', () => {
    const opaque = { origin: 'null', href: 'file:///index.html' };
    expect(() => checkWorkerUrl('/workers/editor.worker.js', opaque)).toThrow(
      TypeError,
    );
    expect(() =>
      checkWorkerUrl('file:///workers/editor.worker.js', opaque),
    ).toThrow(TypeError);
  });

  it('M1-46 AC-3 routes every Monaco policy through app-monaco-html and the worker policy', () => {
    const realm = fakeRealm();
    installEditorEnvironment(realm);
    const hook = realm.MonacoEnvironment?.createTrustedTypesPolicy;
    expect(hook).toBeTypeOf('function');

    const policies = MONACO_POLICY_NAMES.map((name) =>
      hook?.(name, {
        createHTML: (html) => `<${name}>${html}`,
        createScriptURL: (url) => url,
      }),
    );
    expect(policies.every((policy) => policy !== undefined)).toBe(true);

    // No policy was created under a name of Monaco's.
    expect(realm.trustedTypes?.created).toEqual([
      'app-worker-url',
      'app-monaco-html',
    ]);
    policies.forEach((policy, index) => {
      if (policy === undefined) throw new Error('unreachable');
      expect(policy.createHTML?.('x')).toEqual<Minted>({
        kind: 'html',
        policy: 'app-monaco-html',
        value: `<${MONACO_POLICY_NAMES[index] ?? ''}>x`,
      });
      expect(
        policy.createScriptURL?.('/workers/json.worker.js'),
      ).toEqual<Minted>({
        kind: 'script-url',
        policy: 'app-worker-url',
        value: `${ORIGIN}/workers/json.worker.js`,
      });
      expect(() => policy.createScriptURL?.('/workers/evil.js')).toThrow(
        TypeError,
      );
    });
  });

  it('answers only for the factories Monaco asked for', () => {
    const realm = fakeRealm();
    installEditorEnvironment(realm);
    const hook = realm.MonacoEnvironment?.createTrustedTypesPolicy;

    const htmlOnly = hook?.('a', { createHTML: (html) => html });
    expect(htmlOnly?.createHTML).toBeTypeOf('function');
    expect(htmlOnly?.createScriptURL).toBeUndefined();
    const scriptOnly = hook?.('b', { createScriptURL: (url) => url });
    expect(scriptOnly?.createHTML).toBeUndefined();
    expect(scriptOnly?.createScriptURL).toBeTypeOf('function');
    expect(hook?.('c')).toEqual({});
  });
});
