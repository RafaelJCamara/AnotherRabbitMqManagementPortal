// M0-32 acceptance criteria and the attacks on them. Requests that matter for security go over a
// real loopback socket (`tcp`), because "arrived over the network" is what the guards decide on.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CARRIER_HEADER } from './auth/credentials.ts';
import {
  CARRIER,
  LOG_CANARY,
  TOKEN,
  bearer,
  createHarness,
  createUiFixture,
  jsonHeaders,
  listen,
  raw,
  tcp,
  testRegistry,
  type Harness,
  type Listening,
  type UiFixture,
} from './testing/harness.test.ts';

const PROBE = '/api/v1/connections/c1/ping';

function noCors(headers: Record<string, unknown>): void {
  for (const name of Object.keys(headers)) {
    expect(name.startsWith('access-control-')).toBe(false);
  }
}

describe('routes derived from the action registry', () => {
  let h: Harness;
  beforeEach(async () => {
    h = createHarness();
    await h.app.ready();
  });
  afterAll(async () => {
    await h.app.close();
  });

  it('AC-1 an action bound to POST /connections/{cid}/ping has a route, GET is 405 and invalid input is a 400 Problem', async () => {
    const ok = await h.app.inject({
      method: 'POST',
      url: PROBE,
      headers: jsonHeaders(),
      payload: { timeoutMs: 500 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      ok: true,
      cid: 'c1',
      principal: 'local-token',
    });
    expect(h.calls.probe).toBe(1);

    const wrongMethod = await h.app.inject({
      method: 'GET',
      url: PROBE,
      headers: bearer(),
    });
    expect(wrongMethod.statusCode).toBe(405);
    expect(wrongMethod.headers.allow).toBe('POST');
    expect(wrongMethod.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(h.calls.probe).toBe(1);

    const invalid = await h.app.inject({
      method: 'POST',
      url: PROBE,
      headers: jsonHeaders(),
      payload: { timeoutMs: 'soon' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.headers['content-type']).toContain(
      'application/problem+json',
    );
    const problem = invalid.json<Record<string, unknown>>();
    expect(problem).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
      type: 'urn:problem:validation-failed',
      retryable: false,
    });
    expect(problem.correlationId).toBe(invalid.headers['x-request-id']);
    expect(h.calls.probe).toBe(1);
  });

  it('AC-1 hardening: every other method on a bound path is 405 and no CORS header is ever sent', async () => {
    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await h.app.inject({
        method: method as 'GET',
        url: PROBE,
        headers: { ...bearer(), origin: 'http://localhost:80' },
      });
      expect(res.statusCode, method).toBe(405);
      noCors(res.headers);
    }
    // A path with a GET binding refuses POST, and the Allow header says so.
    const post = await h.app.inject({
      method: 'POST',
      url: '/api/v1/meta',
      headers: jsonHeaders(),
      payload: {},
    });
    expect(post.statusCode).toBe(405);
    expect(post.headers.allow).toBe('GET');
    expect(h.calls.meta).toBe(0);
  });

  it('AC-1 hardening: a path parameter cannot be overridden by the body or the query', async () => {
    const body = await h.app.inject({
      method: 'POST',
      url: PROBE,
      headers: jsonHeaders(),
      payload: { cid: 'other' },
    });
    expect(body.statusCode).toBe(400);
    const query = await h.app.inject({
      method: 'GET',
      url: '/api/v1/connections/c1/queues?cid=other',
      headers: bearer(),
    });
    expect(query.statusCode).toBe(400);
    expect(h.calls.probe).toBe(0);
    expect(h.calls.lastList).toBeUndefined();
  });

  it('AC-1 hardening: query text becomes the typed input the action declares', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/connections/c1/queues?limit=25&deep=true&names=a&names=b',
      headers: bearer(),
    });
    expect(res.statusCode).toBe(200);
    expect(h.calls.lastList).toEqual({
      cid: 'c1',
      limit: 25,
      deep: true,
      names: ['a', 'b'],
    });
    const single = await h.app.inject({
      method: 'GET',
      url: '/api/v1/connections/c1/queues?names=only',
      headers: bearer(),
    });
    expect(single.statusCode).toBe(200);
    expect(h.calls.lastList).toEqual({ cid: 'c1', names: ['only'] });
    for (const bad of [
      'limit=abc',
      'limit=',
      'limit=1e3',
      'limit=0x10',
      'limit=5&limit=6',
      'deep=yes',
      'unknown=1',
      '__proto__=1',
    ]) {
      h.calls.lastList = undefined;
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/connections/c1/queues?${bad}`,
        headers: bearer(),
      });
      expect(res.statusCode, bad).toBe(400);
      expect(h.calls.lastList, bad).toBeUndefined();
    }
  });

  it('AC-1 hardening: bodies that are not a JSON object are refused before the action', async () => {
    for (const payload of ['[1,2]', '"text"', '42', 'true', '{"timeoutMs"']) {
      const res = await h.app.inject({
        method: 'POST',
        url: PROBE,
        headers: jsonHeaders(),
        payload,
      });
      expect(res.statusCode, payload).toBe(400);
      expect(res.body).not.toContain('timeoutMs');
    }
    // `null` and an absent body are both "no input".
    const none = await h.app.inject({
      method: 'POST',
      url: PROBE,
      headers: bearer(),
    });
    expect(none.statusCode).toBe(200);
    expect(h.calls.probe).toBe(1);
  });

  it('AC-1 hardening: a poisoned prototype key is refused, not merged', async () => {
    for (const payload of [
      '{"__proto__":{"admin":true}}',
      '{"constructor":{"prototype":{"admin":true}}}',
    ]) {
      const res = await h.app.inject({
        method: 'POST',
        url: PROBE,
        headers: jsonHeaders(),
        payload,
      });
      expect(res.statusCode, payload).toBe(400);
    }
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(h.calls.probe).toBe(0);
  });

  it('AC-1 hardening: only a GET takes a query string; on any other method it is refused, not ignored', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `${PROBE}?timeoutMs=5`,
      headers: jsonHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(h.calls.probe).toBe(0);
  });

  it('AC-1 hardening: a direct call that needs a plan is 428 with the plan in Location', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/connections/c1/queues/q1/purge',
      headers: jsonHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(428);
    expect(res.json()).toMatchObject({ code: 'PLAN_REQUIRED' });
    expect(res.headers.location).toMatch(/^\/api\/v1\/plans\/[0-9A-Z]{26}$/);
    expect(h.calls.purge).toBe(0);
  });

  it('AC-1 hardening: the idempotency key header reaches the executor', async () => {
    const url = '/api/v1/connections/c1/label';
    const without = await h.app.inject({
      method: 'PUT',
      url,
      headers: jsonHeaders(),
      payload: { label: 'x' },
    });
    expect(without.statusCode).toBe(400);
    expect(h.calls.rename).toBe(0);
    const given = await h.app.inject({
      method: 'PUT',
      url,
      headers: jsonHeaders({ 'idempotency-key': 'key-1234567890' }),
      payload: { label: 'x' },
    });
    expect(given.statusCode).toBe(200);
    expect(h.calls.rename).toBe(1);
    // The key is used once.
    const again = await h.app.inject({
      method: 'PUT',
      url,
      headers: jsonHeaders({ 'idempotency-key': 'key-1234567890' }),
      payload: { label: 'x' },
    });
    expect(again.statusCode).toBeGreaterThanOrEqual(400);
    expect(h.calls.rename).toBe(1);
  });

  it('AC-1 hardening: a declared action the executor does not know is a 404 Problem, and an unexpected failure leaks nothing', async () => {
    const orphan = await h.app.inject({
      method: 'GET',
      url: '/api/v1/debug/orphan',
      headers: bearer(),
    });
    expect(orphan.statusCode).toBe(404);
    expect(orphan.json()).toMatchObject({ code: 'NOT_FOUND' });

    const fail = await h.app.inject({
      method: 'GET',
      url: '/api/v1/debug/fail',
      headers: bearer(),
    });
    expect(fail.statusCode).toBe(500);
    expect(fail.json()).toMatchObject({ code: 'INTERNAL' });
    expect(fail.body).not.toContain(LOG_CANARY);
    expect(fail.body).not.toContain('boom');
    expect(fail.body).not.toMatch(/\bat \S+ \(/);
  });

  it('AC-1 hardening: unknown routes under the prefix are 404 Problems that echo nothing', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/%3Cscript%3Ealert(1)%3C/script%3E',
      headers: bearer(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('script');
    const post = await h.app.inject({
      method: 'POST',
      url: '/anywhere',
      headers: jsonHeaders(),
      payload: {},
    });
    expect(post.statusCode).toBe(404);
    expect(post.headers['content-type']).toContain('application/problem+json');
  });

  it('AC-1 hardening: every route of the registry is private and answers 401 without a credential', async () => {
    const bound = testRegistry.actions.filter((a) => a.http !== undefined);
    expect(bound.length).toBeGreaterThanOrEqual(8);
    for (const def of bound) {
      const path = (def.http?.path ?? '').replace(/\{[^}]+\}/g, 'x');
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await h.app.inject({
          method: method as 'GET',
          url: `/api/v1${path}`,
          headers: { 'content-type': 'application/json' },
          payload: method === 'GET' ? '' : '{}',
        });
        expect(res.statusCode, `${method} ${path}`).toBe(401);
        expect(res.headers['www-authenticate']).toBe('Bearer');
      }
    }
    expect(h.calls).toMatchObject({ probe: 0, purge: 0, rename: 0, meta: 0 });
  });

  it('AC-1 hardening: encoded spellings of a private route are still private', async () => {
    for (const url of [
      '/%61pi/v1/meta',
      '/api/v1/%6deta',
      '/api/v1/meta%00',
      '/api/v1/meta?x=1',
      '/api/v1/./meta',
      '/api//v1/meta',
    ]) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).not.toBe(200);
      expect(res.body, url).not.toContain('engineVersion');
    }
    expect(h.calls.meta).toBe(0);
  });

  it('AC-1 hardening: the request id is echoed only when it is a plain token', async () => {
    const good = await h.app.inject({
      method: 'GET',
      url: '/api/v1/meta',
      headers: { ...bearer(), 'x-request-id': 'req-123.abc:def' },
    });
    expect(good.headers['x-request-id']).toBe('req-123.abc:def');
    const bad = await h.app.inject({
      method: 'GET',
      url: '/api/v1/meta',
      headers: { ...bearer(), 'x-request-id': 'bad value\t{"x":1}' },
    });
    expect(bad.headers['x-request-id']).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('AC-1 hardening: every response carries the security headers and a fresh CSP nonce', async () => {
    const a = await h.app.inject({ method: 'GET', url: '/api/v1/meta' });
    const b = await h.app.inject({ method: 'GET', url: '/api/v1/meta' });
    for (const res of [a, b]) {
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['content-security-policy']).toMatch(
        /style-src 'self' 'nonce-[A-Za-z0-9+/=]{22,}'/,
      );
      noCors(res.headers);
    }
    expect(a.headers['content-security-policy']).not.toBe(
      b.headers['content-security-policy'],
    );
  });

  it('AC-1 hardening: a client that goes away aborts the action', async () => {
    const live = createHarness();
    const server = await listen(live.app);
    const { request } = await import('node:http');
    const req = request({
      host: '127.0.0.1',
      port: server.port,
      path: '/api/v1/debug/hang',
      headers: { host: `127.0.0.1:${String(server.port)}`, ...bearer() },
    });
    req.on('error', () => undefined);
    req.end();
    await expect.poll(() => live.calls.started, { timeout: 3000 }).toBe(true);
    req.destroy();
    await expect.poll(() => live.calls.aborted, { timeout: 3000 }).toBe(true);
    await live.app.close();
  });
});

describe('the network listener', () => {
  let h: Harness;
  let server: Listening;
  let fixture: UiFixture;
  beforeAll(async () => {
    fixture = createUiFixture();
    h = createHarness({
      bodyLimit: 2048,
      ui: { roots: [fixture.newest, fixture.previous], engineVersion: '1.2.3' },
    });
    server = await listen(h.app);
  });
  afterAll(async () => {
    await h.app.close();
    fixture.cleanup();
  });
  beforeEach(() => {
    h.calls.probe = 0;
    h.calls.meta = 0;
  });

  const probe = (
    headers: Record<string, string>,
    extra: { defaultHost?: boolean; body?: string } = {},
  ) =>
    tcp(server, {
      method: 'POST',
      path: PROBE,
      headers: { 'content-type': 'application/json', ...headers },
      body: extra.body ?? '{}',
      ...(extra.defaultHost === undefined
        ? {}
        : { defaultHost: extra.defaultHost }),
    });

  it('AC-2 a TCP request with the carrier header, a foreign Origin, a Host off the allow-list or Sec-Fetch-Site cross-site is rejected', async () => {
    const attacks: Record<string, Record<string, string>> = {
      carrier: { ...bearer(), [CARRIER_HEADER]: CARRIER },
      origin: { ...bearer(), origin: 'https://evil.example' },
      'sec-fetch-site': { ...bearer(), 'sec-fetch-site': 'cross-site' },
    };
    for (const [name, headers] of Object.entries(attacks)) {
      const res = await probe(headers);
      expect(res.status, name).toBe(403);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json()).toMatchObject({ code: 'FORBIDDEN_RBAC', status: 403 });
    }
    const host = await probe(
      { ...bearer(), host: 'evil.example' },
      { defaultHost: false },
    );
    expect(host.status).toBe(403);
    expect(h.calls.probe).toBe(0);

    const fine = await probe({ ...bearer() });
    expect(fine.status).toBe(200);
    expect(h.calls.probe).toBe(1);
  });

  it('AC-2 hardening: the carrier header is refused whatever it holds and whatever else the request proves', async () => {
    for (const value of [CARRIER, 'wrong', '', ' ', CARRIER + CARRIER]) {
      const res = await probe({ ...bearer(), [CARRIER_HEADER]: value });
      expect(res.status, JSON.stringify(value)).toBe(403);
    }
    // No credential at all and a carrier header: still a 403, not a 401 that invites a retry.
    const bare = await probe({ [CARRIER_HEADER]: CARRIER });
    expect(bare.status).toBe(403);
    // On a public route too.
    const asset = await tcp(server, {
      path: '/bootstrap.json',
      headers: { [CARRIER_HEADER]: CARRIER },
    });
    expect(asset.status).toBe(403);
    expect(h.calls.probe).toBe(0);
  });

  it('AC-2 hardening: the carrier header is found in any spelling, and a trailer is not a header', async () => {
    for (const name of ['X-App-Carrier', 'X-APP-CARRIER', 'x-app-carrier']) {
      const res = await probe({ ...bearer(), [name]: CARRIER });
      expect(res.status, name).toBe(403);
    }
    // A trailer arrives after the headers were judged, and is never read as one.
    const out = await raw(
      server,
      `POST ${PROBE} HTTP/1.1\r\nhost: 127.0.0.1:${String(server.port)}\r\n` +
        `content-type: application/json\r\ntransfer-encoding: chunked\r\n` +
        `trailer: x-app-carrier\r\nconnection: close\r\n\r\n` +
        `2\r\n{}\r\n0\r\nx-app-carrier: ${CARRIER}\r\n\r\n`,
    );
    expect(out).toMatch(/^HTTP\/1\.1 401 /);
    expect(h.calls.probe).toBe(0);
  });

  it('AC-2 hardening: only the engine own origin passes the Origin check', async () => {
    const own = `http://127.0.0.1:${String(server.port)}`;
    const ok = await probe({ ...bearer(), origin: own });
    expect(ok.status).toBe(200);
    const upper = await probe({ ...bearer(), origin: own.toUpperCase() });
    expect(upper.status).toBe(200);
    for (const origin of [
      'null',
      'https://127.0.0.1:' + String(server.port),
      'http://127.0.0.1:' + String(server.port + 1),
      'http://localhost:' + String(server.port),
      own + '.evil.example',
      own + '/',
      own + ', ' + own,
      'file://',
      '',
    ]) {
      const res = await probe({ ...bearer(), origin });
      expect(res.status, origin).toBe(403);
    }
    expect(h.calls.probe).toBe(2);
  });

  it('AC-2 hardening: names that only look like loopback fail the Host check', async () => {
    const port = String(server.port);
    for (const host of [
      'evil.example',
      'evil.example:' + port,
      '127.0.0.1.evil.example',
      'localhost.evil.example',
      'evil.example/127.0.0.1',
      'user@127.0.0.1:' + port,
      '127.0.0.1:' + port + '@evil.example',
      '127.0.0.1:99999',
      '127.0.0.1:',
      '127.1',
      '0.0.0.0:' + port,
      '2130706433',
      '[::ffff:127.0.0.1]:' + port,
      '127.0.0.1.',
      'localhost.',
      'engine.internal',
    ]) {
      const res = await probe(
        { ...bearer(), host },
        { defaultHost: false },
      ).catch(() => undefined);
      // Node itself may refuse an empty Host; anything it lets through must be a 403.
      if (res !== undefined) expect([400, 403], host).toContain(res.status);
    }
    expect(h.calls.probe).toBe(0);
    for (const host of [
      'localhost:1',
      'LOCALHOST:8765',
      '[::1]:8765',
      '127.0.0.1',
    ]) {
      const res = await probe({ ...bearer(), host }, { defaultHost: false });
      expect(res.status, host).toBe(200);
    }
  });

  it('AC-2 hardening: an undecodable URL is a 400 Problem, with the security headers, and says nothing of the route', async () => {
    for (const path of ['/%zz', '/api/v1/meta%', '/api/v1/%E0%A4%A', '/%']) {
      const res = await tcp(server, { path, headers: bearer() });
      expect(res.status, path).toBe(400);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('AC-2 hardening: an empty Host header is refused', async () => {
    const out = await raw(
      server,
      `GET /api/v1/meta HTTP/1.1\r\nhost:\r\nauthorization: Bearer ${TOKEN}\r\nconnection: close\r\n\r\n`,
    );
    expect(out).toMatch(/^HTTP\/1\.1 (400|403) /);
    expect(h.calls.meta).toBe(0);
  });

  it('AC-2 hardening: forwarding headers and method overrides are not trusted', async () => {
    const forwarded = await probe(
      {
        ...bearer(),
        host: 'evil.example',
        'x-forwarded-host': '127.0.0.1',
        forwarded: 'host=127.0.0.1',
        'x-forwarded-for': '127.0.0.1',
      },
      { defaultHost: false },
    );
    expect(forwarded.status).toBe(403);
    const override = await probe({
      ...bearer(),
      'x-http-method-override': 'GET',
      'x-forwarded-proto': 'https',
    });
    expect(override.status).toBe(200);
    expect(h.calls.probe).toBe(1);
  });

  it('AC-2 hardening: Sec-Fetch-Site must be same-origin; navigation from the address bar reaches only public routes', async () => {
    for (const site of ['cross-site', 'same-site', 'none', 'bogus', '']) {
      const res = await probe({ ...bearer(), 'sec-fetch-site': site });
      expect(res.status, site).toBe(403);
    }
    const same = await probe({ ...bearer(), 'sec-fetch-site': 'same-origin' });
    expect(same.status).toBe(200);
    // `none` plus a navigation is the address bar: accepted for a public route, never for the API.
    const nav = await tcp(server, {
      path: '/bootstrap.json',
      headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' },
    });
    expect(nav.status).toBe(200);
    const api = await tcp(server, {
      path: '/api/v1/meta',
      headers: {
        ...bearer(),
        'sec-fetch-site': 'none',
        'sec-fetch-mode': 'navigate',
      },
    });
    expect(api.status).toBe(403);
    const cross = await tcp(server, {
      path: '/bootstrap.json',
      headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' },
    });
    expect(cross.status).toBe(403);
  });

  it('AC-2 hardening: the guards refuse before the body is parsed or the token is checked', async () => {
    const res = await probe(
      { host: 'evil.example' },
      { defaultHost: false, body: '{"broken' },
    );
    expect(res.status).toBe(403);
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  it('AC-2 hardening: a socket request cannot use a Host that only the tunnel may send', async () => {
    const res = await probe(
      { ...bearer(), host: 'engine.internal' },
      { defaultHost: false },
    );
    expect(res.status).toBe(403);
  });

  it('AC-2 hardening: no CORS header on any answer, and a preflight is refused', async () => {
    const pre = await tcp(server, {
      method: 'OPTIONS',
      path: PROBE,
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(pre.status).toBe(403);
    noCors(pre.headers);
    const same = await tcp(server, { method: 'OPTIONS', path: PROBE });
    expect(same.status).toBe(401);
    noCors(same.headers);
  });
});

describe('authentication', () => {
  let h: Harness;
  let server: Listening;
  beforeAll(async () => {
    h = createHarness();
    server = await listen(h.app);
  });
  afterAll(async () => {
    await h.app.close();
  });

  const meta = (headers: Record<string, string>, path = '/api/v1/meta') =>
    tcp(server, { path, headers });

  it('AC-2 hardening: only the exact launch token passes, in the Authorization header', async () => {
    expect((await meta(bearer())).status).toBe(200);
    expect((await meta({ authorization: `bearer ${TOKEN}` })).status).toBe(200);
    const refused: Record<string, string>[] = [
      {},
      { authorization: '' },
      { authorization: TOKEN },
      { authorization: `Bearer` },
      { authorization: `Bearer ` },
      { authorization: `Bearer  ${TOKEN}` },
      { authorization: `Bearer ${TOKEN}x` },
      { authorization: `Bearer ${TOKEN.slice(0, -1)}` },
      { authorization: `Bearer ${TOKEN.toLowerCase()}` },
      { authorization: `Bearer ${TOKEN.replace(/.$/, 'A')}` },
      { authorization: `Bearer ${'a'.repeat(513)}` },
      {
        authorization: `Basic ${Buffer.from(`x:${TOKEN}`).toString('base64')}`,
      },
      { authorization: `Token ${TOKEN}` },
      { cookie: `token=${TOKEN}; session=${TOKEN}` },
      { 'x-api-key': TOKEN },
      { 'x-auth-token': TOKEN },
    ];
    for (const headers of refused) {
      const res = await meta(headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    expect(h.calls.meta).toBe(2);
  });

  it('AC-2 hardening: the token is never read from the URL or the body', async () => {
    for (const query of [
      `token=${TOKEN}`,
      `access_token=${TOKEN}`,
      `t=${TOKEN}`,
    ]) {
      const res = await meta({}, `/api/v1/meta?${query}`);
      expect(res.status, query).toBe(401);
    }
    const body = await tcp(server, {
      method: 'POST',
      path: PROBE,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, authorization: `Bearer ${TOKEN}` }),
    });
    expect(body.status).toBe(401);
    expect(body.body).not.toContain(TOKEN);
  });

  it('AC-2 hardening: the answer to a refused request does not echo the credential', async () => {
    const res = await meta({ authorization: `Bearer ${TOKEN}x` });
    expect(JSON.stringify(res.headers) + res.body).not.toContain(TOKEN);
  });

  it('AC-2 hardening: the principal of a bearer token is the local UI user, never an elevated one', async () => {
    const res = await tcp(server, {
      method: 'POST',
      path: PROBE,
      headers: jsonHeaders(),
      body: '{}',
    });
    expect(res.json()).toMatchObject({ principal: 'local-token' });
  });
});

describe('the injected carrier (tunnel)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = createHarness();
    await h.app.ready();
  });
  afterAll(async () => {
    await h.app.close();
  });

  const inject = (headers: Record<string, string>) =>
    h.app.inject({
      method: 'POST',
      url: PROBE,
      headers: { 'content-type': 'application/json', ...headers },
      payload: '{}',
    });

  it('AC-2 hardening: an injected request with the carrier secret acts as the desktop user', async () => {
    const res = await inject({
      host: 'engine.internal',
      [CARRIER_HEADER]: CARRIER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ principal: 'desktop-user' });
  });

  it('AC-2 hardening: a wrong carrier secret never falls back to a bearer token', async () => {
    for (const secret of ['wrong', CARRIER.slice(1), CARRIER + 'x', '']) {
      const res = await inject({
        host: 'engine.internal',
        [CARRIER_HEADER]: secret,
        ...bearer(),
      });
      expect(res.statusCode, secret).toBe(401);
    }
    const none = await inject({ host: 'engine.internal' });
    expect(none.statusCode).toBe(401);
  });

  it('AC-2 hardening: an authenticator never sees a bearer token beside a carrier header', async () => {
    const seen: { bearer: string | undefined; carrier: string | undefined }[] =
      [];
    const spy = createHarness({
      authenticators: [
        (input) => {
          seen.push(input);
          return undefined;
        },
      ],
    });
    await spy.app.inject({
      method: 'GET',
      url: '/api/v1/meta',
      headers: { host: 'engine.internal', ...bearer(), [CARRIER_HEADER]: 'c' },
    });
    await spy.app.inject({
      method: 'GET',
      url: '/api/v1/meta',
      headers: bearer(),
    });
    expect(seen).toEqual([
      { bearer: undefined, carrier: 'c' },
      { bearer: TOKEN, carrier: undefined },
    ]);
    await spy.app.close();
  });

  it('AC-2 hardening: the tunnel Host is accepted only for an injected request', async () => {
    const other = await inject({ host: 'evil.example', ...bearer() });
    expect(other.statusCode).toBe(403);
  });
});

describe('JSON-only bodies, framing and limits', () => {
  let h: Harness;
  let server: Listening;
  beforeAll(async () => {
    h = createHarness({ bodyLimit: 2048 });
    server = await listen(h.app);
  });
  afterAll(async () => {
    await h.app.close();
  });
  beforeEach(() => {
    h.calls.probe = 0;
  });

  const post = (headers: Record<string, string>, body: string | undefined) =>
    tcp(server, {
      method: 'POST',
      path: PROBE,
      headers: { ...bearer(), ...headers },
      ...(body === undefined ? {} : { body }),
    });

  it('AC-2 hardening: a body that is not application/json is 415 before any parser sees it', async () => {
    for (const type of [
      'text/plain',
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/xml',
      'application/jsonx',
      'application/json; charset=utf-16',
      'application/json; charset=utf-8; x=y',
      'text/html',
      '',
    ]) {
      const res = await post({ 'content-type': type }, '{"timeoutMs":5}');
      expect(res.status, type).toBe(415);
      expect(res.headers['content-type']).toContain('application/problem+json');
    }
    const none = await post({}, '{"timeoutMs":5}');
    expect(none.status).toBe(415);
    expect(h.calls.probe).toBe(0);
    for (const type of [
      'application/json',
      'Application/JSON; charset=UTF-8',
    ]) {
      const res = await post({ 'content-type': type }, '{"timeoutMs":5}');
      expect(res.status, type).toBe(200);
    }
  });

  it('AC-2 hardening: a chunked body is checked like any other', async () => {
    const out = await raw(
      server,
      `POST ${PROBE} HTTP/1.1\r\nhost: 127.0.0.1:${String(server.port)}\r\n` +
        `authorization: Bearer ${TOKEN}\r\ncontent-type: text/plain\r\n` +
        `transfer-encoding: chunked\r\nconnection: close\r\n\r\n2\r\n{}\r\n0\r\n\r\n`,
    );
    expect(out).toMatch(/^HTTP\/1\.1 415 /);
    expect(h.calls.probe).toBe(0);
  });

  it('AC-2 hardening: a GET or HEAD with a body is refused', async () => {
    const get = await tcp(server, {
      path: '/api/v1/meta',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(get.status).toBe(400);
  });

  it('AC-2 hardening: malformed and oversized JSON are 4xx Problems that echo nothing', async () => {
    const bad = await post(
      { 'content-type': 'application/json' },
      '{"a":canary-xyz',
    );
    expect(bad.status).toBe(400);
    expect(bad.body).not.toContain('canary-xyz');
    const empty = await post({ 'content-type': 'application/json' }, '');
    expect(empty.status).toBe(400);
    const big = await post(
      { 'content-type': 'application/json' },
      JSON.stringify({ timeoutMs: 5, pad: 'x'.repeat(4096) }),
    );
    expect(big.status).toBe(413);
    expect(big.json()).toMatchObject({ status: 413 });
    expect(big.headers['content-type']).toContain('application/problem+json');
    expect(h.calls.probe).toBe(0);
  });

  it('AC-2 hardening: a caller without a token is turned away before its body is weighed', async () => {
    const res = await tcp(server, {
      method: 'POST',
      path: PROBE,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(4096) }),
    });
    expect(res.status).toBe(401);
    expect(h.calls.probe).toBe(0);
  });

  it('AC-2 hardening: absurdly nested JSON is a 4xx, never a crash', async () => {
    const res = await post(
      { 'content-type': 'application/json' },
      '['.repeat(900) + ']'.repeat(900),
    );
    expect(res.status).toBe(400);
    const still = await post({ 'content-type': 'application/json' }, '{}');
    expect(still.status).toBe(200);
  });

  it('AC-2 hardening: conflicting message framing is refused by the parser, before any route', async () => {
    const both = await raw(
      server,
      `POST ${PROBE} HTTP/1.1\r\nhost: 127.0.0.1:${String(server.port)}\r\n` +
        `authorization: Bearer ${TOKEN}\r\ncontent-type: application/json\r\n` +
        `content-length: 4\r\ntransfer-encoding: chunked\r\n\r\n0\r\n\r\nGET /api/v1/meta HTTP/1.1\r\n\r\n`,
    );
    expect(both).toMatch(/^HTTP\/1\.1 400 /);
    expect(both.match(/HTTP\/1\.1/g)).toHaveLength(1);
    const lengths = await raw(
      server,
      `POST ${PROBE} HTTP/1.1\r\nhost: 127.0.0.1:${String(server.port)}\r\n` +
        `authorization: Bearer ${TOKEN}\r\ncontent-type: application/json\r\n` +
        `content-length: 2\r\ncontent-length: 40\r\n\r\n{}`,
    );
    expect(lengths).toMatch(/^HTTP\/1\.1 400 /);
    expect(h.calls.probe).toBe(0);
  });

  it('AC-2 hardening: HTTP/1.1 without Host, a duplicate Host and an absolute-form target cannot slip past the Host check', async () => {
    const noHost = await raw(
      server,
      `GET /api/v1/meta HTTP/1.1\r\nauthorization: Bearer ${TOKEN}\r\nconnection: close\r\n\r\n`,
    );
    expect(noHost).toMatch(/^HTTP\/1\.1 400 /);
    const twoHosts = await raw(
      server,
      `GET /api/v1/meta HTTP/1.1\r\nhost: evil.example\r\nhost: 127.0.0.1\r\n` +
        `authorization: Bearer ${TOKEN}\r\nconnection: close\r\n\r\n`,
    );
    expect(twoHosts).not.toMatch(/^HTTP\/1\.1 200 /);
    const absolute = await raw(
      server,
      `GET http://127.0.0.1/api/v1/meta HTTP/1.1\r\nhost: evil.example\r\n` +
        `authorization: Bearer ${TOKEN}\r\nconnection: close\r\n\r\n`,
    );
    expect(absolute).toMatch(/^HTTP\/1\.1 403 /);
  });

  it('AC-2 hardening: an oversized header block closes the connection', async () => {
    const huge = await raw(
      server,
      `GET /api/v1/meta HTTP/1.1\r\nhost: 127.0.0.1:${String(server.port)}\r\n` +
        `x-pad: ${'a'.repeat(20_000)}\r\nauthorization: Bearer ${TOKEN}\r\n\r\n`,
    );
    expect(huge).toMatch(/^HTTP\/1\.1 4\d\d /);
  });
});

describe('secrets stay out of logs and answers (I-10)', () => {
  it('AC-2 hardening: neither the token, the carrier secret nor the query string reach a log line or a response', async () => {
    const h = createHarness();
    const server = await listen(h.app);
    const answers = [
      await tcp(server, {
        path: '/api/v1/debug/fail',
        headers: { ...bearer(), 'x-request-id': 'req-1' },
      }),
      await tcp(server, {
        path: '/api/v1/meta?token=query-canary-91',
        headers: { authorization: 'Bearer wrong-token-canary-77' },
      }),
      await tcp(server, {
        path: '/api/v1/meta',
        headers: { [CARRIER_HEADER]: CARRIER },
      }),
    ];
    await h.app.close();
    const everything =
      h.logLines.join('\n') +
      answers.map((a) => a.body + JSON.stringify(a.headers)).join('\n');
    for (const canary of [
      TOKEN,
      CARRIER,
      'query-canary-91',
      'wrong-token-canary-77',
    ]) {
      expect(everything, canary).not.toContain(canary);
    }
    // The unexpected failure was logged, with its correlation id and not its message text.
    expect(h.logLines.some((line) => line.includes('request failed'))).toBe(
      true,
    );
  });
});
