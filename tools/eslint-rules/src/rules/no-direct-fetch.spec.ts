import { typescriptTester } from '../test-utils.ts';
import { noDirectFetch } from './no-direct-fetch.ts';

typescriptTester().run('no-direct-fetch', noDirectFetch, {
  valid: [
    'this.http.get(url);',
    'const response = await this.api.queues.list(cid);',
    // A local binding that shadows the global is not the browser's fetch.
    'function f(fetch: (u: string) => void) { fetch(url); }',
    'const fetch = makeFetch(); fetch(url);',
    "import { fetch } from './fetch'; fetch(url);",
    // A method that happens to be called fetch.
    'this.fetch(url);',
    'cache.fetch(key);',
    // Types and typeof checks.
    'let socket: WebSocket | undefined;',
    "const supported = typeof fetch === 'function';",
    'type Fetch = typeof fetch;',
  ],
  invalid: [
    {
      code: 'fetch(url);',
      errors: [{ messageId: 'direct', data: { name: 'fetch' } }],
    },
    {
      code: 'const response = await fetch(`/api/${path}`);',
      errors: [{ messageId: 'direct' }],
    },
    {
      code: 'window.fetch(url);',
      errors: [{ messageId: 'direct', data: { name: 'window.fetch' } }],
    },
    { code: 'globalThis.fetch(url);', errors: [{ messageId: 'direct' }] },
    { code: 'self.fetch(url);', errors: [{ messageId: 'direct' }] },
    { code: 'new XMLHttpRequest();', errors: [{ messageId: 'direct' }] },
    { code: 'new WebSocket(url);', errors: [{ messageId: 'direct' }] },
    { code: 'new EventSource(url);', errors: [{ messageId: 'direct' }] },
    {
      code: 'navigator.sendBeacon(url, body);',
      errors: [{ messageId: 'direct', data: { name: 'navigator.sendBeacon' } }],
    },
  ],
});
