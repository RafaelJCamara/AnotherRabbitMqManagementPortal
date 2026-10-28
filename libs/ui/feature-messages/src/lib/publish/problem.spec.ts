import type { Problem } from '@app/contracts';
import { EngineProblemError } from '@app/ui-data';
import { describe, expect, it } from 'vitest';

import {
  hintKey,
  offersUnlock,
  planRouteMissing,
  problemView,
  type ProblemView,
} from './problem';

const problem = (over: Partial<Problem> = {}): Problem => ({
  type: 'about:blank',
  title: 'Title',
  status: 412,
  code: 'CAPABILITY_MISSING',
  correlationId: 'x',
  retryable: false,
  ...over,
});

describe('the view of a failure', () => {
  it('shows an engine Problem as sent, with its gate', () => {
    const view = problemView(
      new EngineProblemError(
        problem({
          detail: 'Detail',
          code: 'GATE_BLOCKED',
          gate: {
            enabled: false,
            reason: 'Locked',
            source: 'prod-lock',
            fix: {
              actionId: 'ops.arm' as never,
              input: { connectionId: 'c1' },
            },
          },
        }),
      ),
    );
    expect(view).toEqual({
      title: 'Title',
      detail: 'Detail',
      code: 'GATE_BLOCKED',
      gate: {
        reason: 'Locked',
        source: 'prod-lock',
        fixAction: 'ops.arm',
        fixConnection: 'c1',
      },
    });
  });

  it('shows nothing of a gate that is not there, and reads a fix without a connection as none', () => {
    expect(problemView(new EngineProblemError(problem())).gate).toBeNull();
    expect(problemView(new EngineProblemError(problem())).detail).toBeNull();
    const view = problemView(
      new EngineProblemError(
        problem({
          gate: {
            enabled: false,
            fix: { actionId: 'ops.arm' as never, input: 'c1' },
          },
        }),
      ),
    );
    expect(view.gate).toEqual({
      reason: null,
      source: null,
      fixAction: 'ops.arm',
      fixConnection: null,
    });
    const other = problemView(
      new EngineProblemError(
        problem({
          gate: {
            enabled: false,
            fix: { actionId: 'ops.arm' as never, input: { connectionId: 7 } },
          },
        }),
      ),
    );
    expect(other.gate?.fixConnection).toBeNull();
    const nothing = problemView(
      new EngineProblemError(
        problem({
          gate: {
            enabled: false,
            fix: { actionId: 'ops.arm' as never, input: null },
          },
        }),
      ),
    );
    expect(nothing.gate?.fixConnection).toBeNull();
  });

  it('shows the message of any other failure, and an empty title for what is not an error', () => {
    expect(problemView(new Error('offline'))).toEqual({
      title: 'offline',
      detail: null,
      code: null,
      gate: null,
    });
    expect(problemView('boom')).toEqual({
      title: '',
      detail: null,
      code: null,
      gate: null,
    });
  });

  it('offers the unlock only for a lock refusal that names this connection', () => {
    const view = (over: Partial<ProblemView> = {}): ProblemView => ({
      title: '',
      detail: null,
      code: 'GATE_BLOCKED',
      gate: {
        reason: null,
        source: null,
        fixAction: 'ops.arm',
        fixConnection: 'c1',
      },
      ...over,
    });
    expect(offersUnlock(view(), 'c1')).toBe(true);
    expect(offersUnlock(view(), 'c2')).toBe(false);
    expect(offersUnlock(null, 'c1')).toBe(false);
    expect(offersUnlock(view({ code: 'NOT_FOUND' }), 'c1')).toBe(false);
    expect(offersUnlock(view({ gate: null }), 'c1')).toBe(false);
    expect(
      offersUnlock(
        view({
          gate: {
            reason: null,
            source: null,
            fixAction: 'ops.disarm',
            fixConnection: 'c1',
          },
        }),
        'c1',
      ),
    ).toBe(false);
  });

  it('takes a 404 not found for a plan route the engine does not serve, and nothing else', () => {
    const error = (status: number, code: Problem['code']) =>
      new EngineProblemError(problem({ status, code }));
    expect(planRouteMissing(error(404, 'NOT_FOUND'))).toBe(true);
    expect(planRouteMissing(error(404, 'INTERNAL'))).toBe(false);
    expect(planRouteMissing(error(412, 'NOT_FOUND'))).toBe(false);
    expect(planRouteMissing(new Error('x'))).toBe(false);
  });

  it('has a fixed hint for the codes it knows and none for the rest', () => {
    for (const code of [
      'CAPABILITY_MISSING',
      'PLAN_REQUIRED',
      'PLAN_EXPIRED',
      'PLAN_STALE',
      'GATE_BLOCKED',
      'FORBIDDEN_RBAC',
      'FORBIDDEN_BROKER',
      'NOT_FOUND',
      'BROKER_UNREACHABLE',
      'VALIDATION_FAILED',
    ]) {
      expect(hintKey(code), code).toMatch(/^publish\.hint\./);
    }
    expect(hintKey('PLAN_STALE')).toBe(hintKey('PLAN_EXPIRED'));
    expect(hintKey('INTERNAL')).toBeNull();
    expect(hintKey('constructor')).toBeNull();
    expect(hintKey(null)).toBeNull();
  });

  it('keeps an empty text of the engine as sent and reads a gate without a fix as no fix', () => {
    const view = problemView(
      new EngineProblemError(
        problem({
          detail: '',
          gate: { enabled: false, reason: '', source: '' },
        }),
      ),
    );
    expect(view.detail).toBe('');
    expect(view.gate).toStrictEqual({
      reason: '',
      source: '',
      fixAction: null,
      fixConnection: null,
    });
  });
});
