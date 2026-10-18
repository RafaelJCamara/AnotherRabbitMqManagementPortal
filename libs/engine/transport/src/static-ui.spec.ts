// The static UI: the nonce, the N and N-1 asset directories, and a determined attempt to read
// files outside them. Requests go over a real socket, with the request target sent as written.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SECRET,
  bearer,
  createHarness,
  createUiFixture,
  listen,
  raw,
  tcp,
  type Harness,
  type Listening,
  type UiFixture,
} from './testing/harness.test.ts';

describe('static UI', () => {
  let fx: UiFixture;
  let h: Harness;
  let server: Listening;
  beforeAll(async () => {
    fx = createUiFixture();
    h = createHarness({
      ui: { roots: [fx.newest, fx.previous], engineVersion: '1.2.3' },
    });
    server = await listen(h.app);
  });
  afterAll(async () => {
    await h.app.close();
    fx.cleanup();
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    tcp(server, { path, headers });

  it('static UI: index.html carries the nonce of its own response and the CSP header names the same nonce', async () => {
    const a = await get('/');
    const b = await get('/index.html');
    for (const res of [a, b]) {
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      const nonce = /<meta name="csp-nonce" content="([^"]+)"/.exec(
        res.body,
      )?.[1];
      expect(nonce).toMatch(/^[A-Za-z0-9+/=]{22,}$/);
      expect(res.body).toContain(`ngCspNonce="${nonce ?? ''}"`);
      expect(res.body).not.toContain('__CSP_NONCE__');
      expect(res.headers['content-security-policy']).toContain(
        `style-src 'self' 'nonce-${nonce ?? ''}'`,
      );
      expect(res.headers['content-security-policy']).toContain(
        "default-src 'none'",
      );
      expect(res.headers['content-security-policy']).toContain(
        "script-src 'self'",
      );
      expect(res.headers['content-security-policy']).toContain(
        "frame-ancestors 'none'",
      );
    }
    const nonceOf = (body: string) => /content="([^"]+)"/.exec(body)?.[1];
    expect(nonceOf(a.body)).not.toBe(nonceOf(b.body));
  });

  it('static UI: files come from N first, then from N-1; index.html only from N', async () => {
    expect((await get('/main-ABCD1234.js')).body).toBe('N-main');
    // Present in both: N wins.
    expect((await get('/shared.js')).body).toBe('N-shared');
    // Only in N-1: a tab still running the old build keeps finding its chunks.
    const old = await get('/chunk-OLDCHUNK1.js');
    expect(old.status).toBe(200);
    expect(old.body).toBe('OLD-chunk');
    expect((await get('/')).body).toContain('N-INDEX');
    expect((await get('/index.html')).body).not.toContain('OLD-INDEX');
    // Nowhere: 404.
    expect((await get('/gone-12345678.js')).status).toBe(404);
  });

  it('static UI: types, caching and sniffing headers of assets', async () => {
    const js = await get('/main-ABCD1234.js');
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(js.headers['x-content-type-options']).toBe('nosniff');
    expect(js.headers['content-length']).toBe('6');
    expect((await get('/shared.js')).headers['cache-control']).toBe('no-cache');
    expect((await get('/styles.css')).headers['content-type']).toBe(
      'text/css; charset=utf-8',
    );
    expect((await get('/assets/logo.svg')).headers['content-type']).toBe(
      'image/svg+xml',
    );
    expect((await get('/data.bin')).headers['content-type']).toBe(
      'application/octet-stream',
    );
    const head = await tcp(server, {
      method: 'HEAD',
      path: '/main-ABCD1234.js',
    });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('static UI: the UI is public but still behind the Host, Origin and Sec-Fetch guards', async () => {
    expect((await get('/')).status).toBe(200);
    expect((await get('/', { origin: 'https://evil.example' })).status).toBe(
      403,
    );
    expect((await get('/', { 'sec-fetch-site': 'cross-site' })).status).toBe(
      403,
    );
    const rebinding = await tcp(server, {
      path: '/',
      headers: { host: 'evil.example' },
      defaultHost: false,
    });
    expect(rebinding.status).toBe(403);
    const nav = await get('/', {
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'navigate',
    });
    expect(nav.status).toBe(200);
  });

  it('static UI: bootstrap.json states the engine facts and nothing secret', async () => {
    const res = await get('/bootstrap.json');
    expect(res.json()).toEqual({
      engineVersion: '1.2.3',
      apiVersion: 'v1',
      mode: 'local',
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(
      (await get('/bootstrap.json', { 'sec-fetch-site': 'cross-site' })).status,
    ).toBe(403);
  });

  it('static UI: router addresses get the app, missing files do not', async () => {
    const page = await get('/c/abc/queues', {
      accept: 'text/html,application/xhtml+xml',
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain('N-INDEX');
    expect(
      (await get('/c/abc/queues', { accept: 'application/json' })).status,
    ).toBe(404);
    expect((await get('/c/abc/queues')).status).toBe(404);
    expect((await get('/missing.js', { accept: 'text/html' })).status).toBe(
      404,
    );
  });

  it('static UI: the UI never answers for the API, and the API is private', async () => {
    for (const path of [
      '/api',
      '/api/',
      '/API',
      '/Api/v1/meta',
      '/api/v1/nothing',
    ]) {
      const res = await get(path);
      expect([401, 404], path).toContain(res.status);
      expect(res.body, path).not.toContain('N-INDEX');
    }
    expect((await get('/api/v1/nothing')).status).toBe(401);
    expect((await get('/api/v1/nothing', bearer())).status).toBe(404);
  });

  it('static UI: methods other than GET and HEAD do not reach the UI', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const res = await tcp(server, { method, path: '/main-ABCD1234.js' });
      expect(res.status, method).toBe(401);
    }
  });

  it('static UI: path traversal: no spelling of ../ reaches a file outside the asset directories', async () => {
    const targets = [
      '/../secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/%2E%2E%2Fsecret.txt',
      '/..%5csecret.txt',
      '/%2e%2e%5csecret.txt',
      '/..\\secret.txt',
      '/assets/../../secret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/%252e%252e/secret.txt',
      '/%252e%252e%252fsecret.txt',
      '/....//secret.txt',
      '/..;/secret.txt',
      '/.%00./secret.txt',
      '/%c0%ae%c0%ae/secret.txt',
      '/%e0%80%ae%e0%80%ae/secret.txt',
      '//secret.txt',
      '//../secret.txt',
      '/./secret.txt',
      '/.env',
      '/assets/.env',
      '/.git/config',
      '/secret.txt%00.js',
      '/main-ABCD1234.js%00',
      '/main-ABCD1234.js/../../secret.txt',
      '/main-ABCD1234.js/.',
      '/main-ABCD1234.js::$DATA',
      '/main-ABCD1234.js.',
      '/main-ABCD1234.js%20',
      '/CON',
      '/NUL',
      '/C:/Windows/win.ini',
      '/C%3A/Windows/win.ini',
      '/%5c%5c.%5cpipe%5cx',
      '/' + 'a/'.repeat(30) + 'secret.txt',
      '/' + 'a'.repeat(500),
      '/linked/secret.txt',
      '/linked%2fsecret.txt',
      '/assets/%2e/../../outside/secret.txt',
    ];
    for (const path of targets) {
      const res = await tcp(server, { path, headers: { accept: '*/*' } });
      expect(res.body, path).not.toContain(SECRET);
      expect([400, 403, 404], path).toContain(res.status);
    }
    // The same through a raw socket, so the client cannot tidy the target first.
    for (const path of [
      '/../../secret.txt',
      '/a/../../secret.txt',
      '/%2e%2e/%2e%2e/secret.txt',
    ]) {
      const out = await raw(
        server,
        `GET ${path} HTTP/1.1\r\nhost: 127.0.0.1:${String(server.port)}\r\nconnection: close\r\n\r\n`,
      );
      expect(out, path).not.toContain(SECRET);
      expect(out, path).not.toMatch(/^HTTP\/1\.1 200 /);
    }
  });

  it('static UI: path traversal: a link inside the asset directory that leaves it is not followed', async (ctx) => {
    if (!fx.linked) ctx.skip();
    const res = await get('/linked/secret.txt');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain(SECRET);
  });

  it('static UI: only the root index.html is the page, whatever its case, and it always gets a nonce', async () => {
    const upper = await get('/INDEX.HTML');
    expect(upper.status).toBe(200);
    expect(upper.body).toContain('N-INDEX');
    expect(upper.body).not.toContain('__CSP_NONCE__');
    expect((await get('/assets/index.html')).status).toBe(404);
  });

  it('static UI: directories and dotfiles are not served', async () => {
    for (const path of ['/assets', '/assets/', '/.env']) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.body).not.toContain(SECRET);
    }
  });
});

describe('static UI configuration', () => {
  it('static UI: refuses to start without absolute asset directories (never the working directory)', () => {
    for (const roots of [[], ['relative/dir'], ['.'], ['']]) {
      expect(() =>
        createHarness({ ui: { roots, engineVersion: '1' } }),
      ).toThrow(TypeError);
    }
  });

  it('static UI: without a UI directory, / is an unknown route and still not a file read', async () => {
    const h = createHarness();
    const res = await h.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(401);
    await h.app.close();
  });

  it('static UI: a missing N directory answers 404, not an error page', async () => {
    const fx = createUiFixture();
    const h = createHarness({
      ui: { roots: [fx.newest + '-gone', fx.previous], engineVersion: '1' },
    });
    const res = await h.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(fx.base);
    await h.app.close();
    fx.cleanup();
  });
});
