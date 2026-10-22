import { describe, expect, it } from 'vitest';

import { credentialHeaders, isEngineUrl } from './credentials';

describe('credentialHeaders', () => {
  it('sends the bearer token on every method', () => {
    for (const method of ['GET', 'POST', 'delete']) {
      expect(credentialHeaders({ bearer: 't' }, method)).toEqual({
        authorization: 'Bearer t',
      });
    }
  });

  it('sends the CSRF token on unsafe methods only', () => {
    expect(credentialHeaders({ csrf: 'c' }, 'GET')).toEqual({});
    expect(credentialHeaders({ csrf: 'c' }, 'head')).toEqual({});
    expect(credentialHeaders({ csrf: 'c' }, 'OPTIONS')).toEqual({});
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(credentialHeaders({ csrf: 'c' }, method)).toEqual({
        'x-csrf-token': 'c',
      });
    }
  });

  it('sends nothing for empty credentials', () => {
    expect(credentialHeaders({}, 'POST')).toEqual({});
    expect(credentialHeaders({ bearer: '', csrf: '' }, 'POST')).toEqual({});
  });
});

describe('isEngineUrl', () => {
  it('accepts same-origin paths only', () => {
    expect(isEngineUrl('/api/v1/meta')).toBe(true);
    expect(isEngineUrl('//evil.example/api')).toBe(false);
    expect(isEngineUrl('https://evil.example/api')).toBe(false);
    expect(isEngineUrl('api/v1/meta')).toBe(false);
  });

  it('SEC-N12 accepts /api/ paths with a query or fragment, and nothing outside /api/', () => {
    expect(isEngineUrl('/api/x')).toBe(true);
    expect(isEngineUrl('/api/v1/connections?cursor=a%2Fb')).toBe(true);
    expect(isEngineUrl('/api')).toBe(false);
    expect(isEngineUrl('/apix/y')).toBe(false);
    expect(isEngineUrl('/assets/i18n/en.json')).toBe(false);
    expect(isEngineUrl('/')).toBe(false);
  });

  it('SEC-N12 rejects a backslash: the browser reads /\\host as //host', () => {
    expect(isEngineUrl('/\\evil.example')).toBe(false);
    expect(isEngineUrl('/\\evil.example/api/x')).toBe(false);
    expect(isEngineUrl('/api/x\\..\\..\\y')).toBe(false);
    expect(isEngineUrl('/\\/evil.example')).toBe(false);
  });

  it('SEC-N12 rejects control characters, which the URL parser would strip into //host', () => {
    expect(isEngineUrl('/\t/evil.example')).toBe(false);
    expect(isEngineUrl('/\n/evil.example')).toBe(false);
    expect(isEngineUrl('/\r/evil.example/api/')).toBe(false);
    expect(isEngineUrl('/api/x\u0000y')).toBe(false);
    expect(isEngineUrl('/api/x\u007fy')).toBe(false);
  });

  it('SEC-N12 rejects protocol-relative and absolute other-origin forms, however written', () => {
    expect(isEngineUrl('//evil')).toBe(false);
    expect(isEngineUrl('//evil.example/api/x')).toBe(false);
    expect(isEngineUrl('https://evil.example/api/x')).toBe(false);
    expect(isEngineUrl('http:/evil.example/api/x')).toBe(false);
    expect(isEngineUrl('javascript:/api/x')).toBe(false);
    expect(isEngineUrl(`${location.origin}/api/x`)).toBe(false);
    expect(isEngineUrl('')).toBe(false);
  });

  it('SEC-N12 resolves the path as the browser does: encoded dot segments and encoded slashes', () => {
    // %2e%2e is a dot segment to the URL parser, so this leaves /api/.
    expect(isEngineUrl('/api/%2e%2e/secret')).toBe(false);
    expect(isEngineUrl('/api/../secret')).toBe(false);
    expect(isEngineUrl('/api/%2E%2E/%2e%2e/secret')).toBe(false);
    // An encoded backslash or slash right after the first one is just path text.
    expect(isEngineUrl('/%5Cevil.example')).toBe(false);
    expect(isEngineUrl('/%2Fevil.example')).toBe(false);
    expect(isEngineUrl('/api/%5Cevil.example')).toBe(true);
    expect(isEngineUrl('/api/a%2Fb')).toBe(true);
  });
});
