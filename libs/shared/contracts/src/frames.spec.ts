import { describe, expect, it } from 'vitest';
import { AppInfoSchema, BRIDGE_VERSION } from './bridge.ts';
import { ConnectionIdSchema, PermissionSchema } from './brands.ts';
import { EnvClassSchema, EngineModeSchema, RiskSchema } from './config/env.ts';
import { CtlFrameSchema } from './ctl-frames.ts';
import { ErrorCodeSchema, ProblemSchema } from './errors.ts';
import { ClientFrameSchema, ServerFrameSchema } from './live-frames.ts';
import { PortFrameSchema } from './port-frames.ts';

const problem = {
  type: 'about:blank',
  title: 'Plan is stale',
  status: 409,
  code: 'PLAN_STALE',
  correlationId: 'c-1',
  retryable: false,
};

describe('Problem', () => {
  it('accepts a minimal problem and the optional blocks', () => {
    expect(ProblemSchema.parse(problem)).toEqual(problem);
    const full = {
      ...problem,
      detail: 'The queue changed',
      gate: {
        enabled: false,
        mode: 'degraded',
        reason: 'era',
        fix: { actionId: 'x.y', input: { a: 1 } },
      },
      warnings: [
        {
          id: 'W-DESTRUCTIVE',
          severity: 'consent',
          textKey: 'w.d',
          textVersion: 1,
        },
      ],
      missingPermission: 'messages.purge',
      broker: {
        protocol: 'amqp091',
        classId: 50,
        code: 404,
        text: 'NOT_FOUND',
      },
    };
    expect(ProblemSchema.parse(full)).toEqual(full);
  });

  it('rejects unknown codes, unknown keys and bad statuses', () => {
    expect(ProblemSchema.safeParse({ ...problem, code: 'OOPS' }).success).toBe(
      false,
    );
    expect(
      ProblemSchema.safeParse({ ...problem, stack: 'at ...' }).success,
    ).toBe(false);
    expect(ProblemSchema.safeParse({ ...problem, status: 99 }).success).toBe(
      false,
    );
    expect(
      ProblemSchema.safeParse({ ...problem, missingPermission: 'nodot' })
        .success,
    ).toBe(false);
  });

  it('keeps the 27 documented error codes', () => {
    expect(ErrorCodeSchema.options).toHaveLength(27);
    expect(ErrorCodeSchema.options).toContain('SEMANTICS_GAP');
  });
});

describe('live frames', () => {
  it('parses every client frame', () => {
    for (const frame of [
      { t: 'hello', v: 1 },
      { t: 'hello', v: 1, resume: { session: 's', lastSeq: { 1: 4 } } },
      {
        t: 'sub',
        sid: 1,
        topic: 'queues.depth',
        params: { cid: 'a' },
        credit: 8,
      },
      { t: 'credit', sid: 1, n: 4 },
      { t: 'unsub', sid: 1 },
      { t: 'ping', ts: 1 },
    ]) {
      expect(ClientFrameSchema.parse(frame)).toEqual(frame);
    }
  });

  it('parses every server frame', () => {
    for (const frame of [
      {
        t: 'welcome',
        v: 1,
        session: 's',
        engineVersion: '0.1.0',
        limits: { maxSubs: 64, outboxBytes: 1, maxFrameBytes: 1 },
      },
      { t: 'subok', sid: 1, qos: 'lossless' },
      {
        t: 'data',
        sid: 1,
        seq: 2,
        items: [{ a: 1 }],
        dropped: 3,
        sampledEvery: 2,
      },
      { t: 'snapshot', sid: 1, seq: 0, items: [] },
      { t: 'delta', sid: 1, seq: 1, upserts: [], removes: ['k'] },
      { t: 'status', sid: 1, state: 'stale' },
      { t: 'gap', sid: 1, fromSeq: 3, toSeq: 9, reason: 'overflow' },
      { t: 'end', sid: 1, reason: 'error', problem },
      { t: 'goaway', reason: 'drain', reconnectAfterMs: 500 },
      { t: 'pong', ts: 1 },
    ]) {
      expect(ServerFrameSchema.parse(frame)).toEqual(frame);
    }
  });

  it('rejects unknown tags, missing fields, unknown keys and wrong versions', () => {
    expect(ClientFrameSchema.safeParse({ t: 'nope' }).success).toBe(false);
    expect(ClientFrameSchema.safeParse({ t: 'sub', sid: 1 }).success).toBe(
      false,
    );
    expect(
      ClientFrameSchema.safeParse({ t: 'ping', ts: 1, extra: 1 }).success,
    ).toBe(false);
    expect(ClientFrameSchema.safeParse({ t: 'hello', v: 2 }).success).toBe(
      false,
    );
    expect(
      ClientFrameSchema.safeParse({ t: 'credit', sid: 1, n: 0 }).success,
    ).toBe(false);
    expect(
      ServerFrameSchema.safeParse({
        t: 'gap',
        sid: 1,
        fromSeq: 1,
        toSeq: 2,
        reason: 'x',
      }).success,
    ).toBe(false);
  });
});

describe('port, ctl and bridge', () => {
  it('parses the MessagePort envelope, including a tunnelled live frame', () => {
    for (const frame of [
      {
        t: 'http.req',
        id: 1,
        method: 'GET',
        url: '/api/v1/meta',
        headers: { a: 'b' },
      },
      {
        t: 'http.res',
        id: 1,
        status: 200,
        headers: {},
        body: '{}',
        streamed: false,
      },
      { t: 'http.chunk', id: 1, body: new ArrayBuffer(2), last: true },
      { t: 'http.abort', id: 1 },
      { t: 'live', frame: { t: 'ping', ts: 1 } },
      { t: 'live', frame: { t: 'pong', ts: 1 } },
    ]) {
      expect(PortFrameSchema.safeParse(frame).success).toBe(true);
    }
    expect(
      PortFrameSchema.safeParse({ t: 'live', frame: { t: 'nope' } }).success,
    ).toBe(false);
    expect(
      PortFrameSchema.safeParse({
        t: 'http.chunk',
        id: 1,
        body: 'text',
        last: true,
      }).success,
    ).toBe(false);
  });

  it('validates the control channel and rejects anything else', () => {
    for (const frame of [
      {
        t: 'init',
        paths: { data: '/d', logs: '/l' },
        dek: new Uint8Array(32),
        settings: {},
      },
      { t: 'ready', contract: 'v1', schemaHash: 'abc' },
      { t: 'attach', windowId: 3 },
      { t: 'shutdown', deadlineMs: 2000 },
      { t: 'suspend', deadlineMs: 500 },
      { t: 'resume' },
      { t: 'notify', title: 't', body: 'b' },
      { t: 'save', fileToken: 'tok', artifactId: 'a' },
    ]) {
      expect(CtlFrameSchema.safeParse(frame).success).toBe(true);
    }
    expect(
      CtlFrameSchema.safeParse({ t: 'shutdown', deadlineMs: 0 }).success,
    ).toBe(false);
    expect(CtlFrameSchema.safeParse({ t: 'exec', cmd: 'rm' }).success).toBe(
      false,
    );
    expect(
      CtlFrameSchema.safeParse({
        t: 'init',
        paths: { data: '/d', logs: '/l' },
        dek: 'secret',
        settings: {},
      }).success,
    ).toBe(false);
  });

  it('pins PlatformBridge v1 and the shared vocabularies', () => {
    expect(BRIDGE_VERSION).toBe(1);
    expect(AppInfoSchema.parse({ version: '0.1.0', mode: 'local' }).mode).toBe(
      'local',
    );
    expect(EngineModeSchema.options).toEqual(['desktop', 'local', 'team']);
    expect(EnvClassSchema.options).toEqual([
      'prod',
      'staging',
      'test',
      'dev',
      'local',
    ]);
    expect(RiskSchema.options).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'critical',
    ]);
    expect(ConnectionIdSchema.safeParse('').success).toBe(false);
    expect(PermissionSchema.safeParse('messages.purge').success).toBe(true);
  });
});
