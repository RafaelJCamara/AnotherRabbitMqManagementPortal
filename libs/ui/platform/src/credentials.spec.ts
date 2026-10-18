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
});
