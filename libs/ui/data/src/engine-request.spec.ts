import { describe, expect, it } from 'vitest';

import { buildEngineRequest } from './engine-request';
import {
  inventoryQuery,
  jobsCancel,
  queuesGet,
  queuesPurge,
  settingsPut,
  unbound,
} from './test-fixtures';

describe('buildEngineRequest', () => {
  describe('path parameters', () => {
    it('fills them in below /api/v1, encoded', () => {
      expect(
        buildEngineRequest(queuesGet, { cid: 'c 1', qkey: 'a/b?c' }),
      ).toEqual({
        method: 'GET',
        url: '/api/v1/connections/c%201/queues/a%2Fb%3Fc',
      });
    });

    it('accepts a number', () => {
      expect(
        buildEngineRequest(jobsCancel, { jobId: 7 as unknown as string }).url,
      ).toBe('/api/v1/jobs/7/cancel');
    });

    it('refuses a missing or non-scalar path parameter', () => {
      expect(() => buildEngineRequest(queuesGet, { cid: 'c1' })).toThrow(
        /path parameter 'qkey'/,
      );
      expect(() =>
        buildEngineRequest(queuesGet, { cid: 'c1', qkey: { a: 1 } }),
      ).toThrow(TypeError);
    });
  });

  describe('GET', () => {
    it('sends the other fields as query parameters', () => {
      expect(
        buildEngineRequest(queuesGet, {
          cid: 'c1',
          qkey: 'q1',
          verbose: true,
          fields: ['a', 'b'],
        }),
      ).toEqual({
        method: 'GET',
        url: '/api/v1/connections/c1/queues/q1',
        params: { verbose: true, fields: ['a', 'b'] },
      });
    });

    it('leaves out undefined and null fields', () => {
      const request = buildEngineRequest(queuesGet, {
        cid: 'c1',
        qkey: 'q1',
        verbose: undefined,
        fields: null,
      });
      expect(request).not.toHaveProperty('params');
      expect(request).not.toHaveProperty('body');
    });

    it('refuses a field that is not flat', () => {
      expect(() =>
        buildEngineRequest(queuesGet, {
          cid: 'c1',
          qkey: 'q1',
          verbose: { a: 1 },
        }),
      ).toThrow(/must be a scalar or an array of scalars/);
      expect(() =>
        buildEngineRequest(queuesGet, { cid: 'c1', qkey: 'q1', fields: [[1]] }),
      ).toThrow(TypeError);
    });
  });

  describe('other methods', () => {
    it('sends the fields that are not in the path as the JSON body', () => {
      expect(
        buildEngineRequest(queuesPurge, {
          cid: 'c1',
          qkey: 'q1',
          reason: 'test',
        }),
      ).toEqual({
        method: 'POST',
        url: '/api/v1/connections/c1/queues/q1/purge',
        body: { reason: 'test' },
      });
    });

    it('keeps a structured field as it is', () => {
      const request = buildEngineRequest(inventoryQuery, {
        cid: 'c1',
        filter: { text: 'x' },
        window: { offset: 0, limit: 50 },
      });
      expect(request.body).toEqual({
        filter: { text: 'x' },
        window: { offset: 0, limit: 50 },
      });
    });

    it('sends no body when the input is only path parameters', () => {
      const request = buildEngineRequest(jobsCancel, { jobId: 'j1' });
      expect(request).toEqual({
        method: 'POST',
        url: '/api/v1/jobs/j1/cancel',
      });
    });

    it('still sends an empty body when the schema has body fields and none is set', () => {
      expect(buildEngineRequest(settingsPut, { name: 'theme' })).toEqual({
        method: 'PUT',
        url: '/api/v1/settings/theme',
        body: {},
      });
    });
  });

  describe('bad calls', () => {
    it('refuses an action with no HTTP binding', () => {
      expect(() => buildEngineRequest(unbound, {})).toThrow(
        'meta.ping has no HTTP binding.',
      );
    });

    it('refuses an input that is not an object, and treats undefined as empty', () => {
      expect(() => buildEngineRequest(jobsCancel, 'j1')).toThrow(TypeError);
      expect(() => buildEngineRequest(jobsCancel, [])).toThrow(TypeError);
      expect(() => buildEngineRequest(jobsCancel, undefined)).toThrow(
        /path parameter 'jobId'/,
      );
    });
  });
});
