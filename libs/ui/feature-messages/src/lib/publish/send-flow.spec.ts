import { TestBed } from '@angular/core/testing';
import { ConnectionIdSchema, type Problem } from '@app/contracts';
import { ArmingStore, EngineProblemError } from '@app/ui-data';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';

import type { MessagesPublishInput } from './draft-to-input';
import {
  FakeApi,
  confirmedResult,
  openPlan,
  provideFakeApi,
  type FakeApiHandlers,
} from './fake-api';
import { SendFlow } from './send-flow';

const CID = ConnectionIdSchema.parse('c1');
const INPUT: MessagesPublishInput = {
  cid: CID,
  vhost: '/',
  exchange: '',
  routingKey: 'orders',
  props: {},
  body: { encoding: 'utf8', data: 'hello' },
  copies: 1,
  mandatory: true,
  confirm: true,
  timeoutMs: 5000,
};

const problem = (over: Partial<Problem> = {}): EngineProblemError =>
  new EngineProblemError({
    type: 'about:blank',
    title: 'Refused',
    status: 400,
    code: 'VALIDATION_FAILED',
    correlationId: 'x',
    retryable: false,
    ...over,
  });

function flowOver(handlers: FakeApiHandlers) {
  const api = new FakeApi(handlers);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideFakeApi(api), SendFlow],
  });
  return {
    api,
    flow: TestBed.inject(SendFlow),
    arming: TestBed.inject(ArmingStore),
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('the send flow', () => {
  it('plans, then executes once when the plan asks nothing, and ignores a second send while busy', () => {
    const plan = new Subject<ReturnType<typeof openPlan>>();
    const done = new Subject<{ output: ReturnType<typeof confirmedResult> }>();
    const { api, flow } = flowOver({
      plan: () => plan,
      execute: () => done,
    });
    expect(flow.phase()).toBe('idle');
    flow.send(INPUT);
    expect(flow.phase()).toBe('planning');
    expect(flow.busy()).toBe(true);
    flow.send(INPUT); // a second click while the plan is on its way
    expect(api.calls.map((c) => c.kind)).toEqual(['plan']);

    plan.next(openPlan({ id: 'p9' }));
    expect(flow.phase()).toBe('executing');
    expect(flow.busy()).toBe(true);
    flow.send(INPUT); // and while it executes
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]).toEqual({
      kind: 'execute',
      id: 'messages.publish',
      planId: 'p9',
      request: { consents: [] },
    });
    expect(api.calls[0]).toMatchObject({
      kind: 'plan',
      id: 'messages.publish',
      input: INPUT,
    });

    done.next({ output: confirmedResult(2) });
    expect(flow.phase()).toBe('done');
    expect(flow.busy()).toBe(false);
    expect(flow.result()?.copies).toHaveLength(2);
    expect(flow.problem()).toBeNull();
    expect(flow.plan()).toBeNull();
  });

  it('works with answers that arrive at once', () => {
    const { api, flow } = flowOver({
      plan: () => of(openPlan()),
      execute: () => of({ output: confirmedResult() }),
    });
    flow.send(INPUT);
    expect(flow.phase()).toBe('done');
    expect(api.calls.map((c) => c.kind)).toEqual(['plan', 'execute']);
  });

  it('shows the dialog for a plan that asks, runs nothing until it is answered, and sends the answers', () => {
    const { api, flow } = flowOver({
      plan: () =>
        of(
          openPlan({
            consentsRequired: ['consent.a'],
            confirmationPhrase: 'publish',
          }),
        ),
      execute: () => of({ output: confirmedResult() }),
    });
    flow.send(INPUT);
    expect(flow.phase()).toBe('review');
    expect(flow.busy()).toBe(false);
    expect(flow.plan()?.id).toBe('plan-1');
    expect(api.calls.map((c) => c.kind)).toEqual(['plan']);
    flow.send(INPUT); // not while a plan is under review
    expect(api.calls).toHaveLength(1);

    flow.confirm(['consent.a'], 'publish');
    expect(api.calls[1]).toMatchObject({
      kind: 'execute',
      planId: 'plan-1',
      request: { consents: ['consent.a'], confirmation: 'publish' },
    });
    expect(flow.phase()).toBe('done');
    expect(flow.plan()).toBeNull();
  });

  it('leaves the plan to expire when the dialog is cancelled, and runs nothing', () => {
    const { api, flow } = flowOver({
      plan: () => of(openPlan({ consentsRequired: ['consent.a'] })),
    });
    flow.cancel(); // nothing to cancel
    expect(flow.phase()).toBe('idle');
    flow.send(INPUT);
    flow.cancel();
    expect(flow.phase()).toBe('idle');
    expect(flow.plan()).toBeNull();
    expect(api.calls.map((c) => c.kind)).toEqual(['plan']);
    flow.confirm([], undefined); // nothing under review any more
    expect(api.calls).toHaveLength(1);
  });

  it('keeps the dialog open with the failure when the execute of a reviewed plan is refused, and can run again', () => {
    let attempt = 0;
    const { flow } = flowOver({
      plan: () => of(openPlan({ confirmationPhrase: 'publish' })),
      execute: () => {
        attempt += 1;
        return attempt === 1
          ? throwError(() => problem({ code: 'CONFIRMATION_MISMATCH' }))
          : of({ output: confirmedResult() });
      },
    });
    flow.send(INPUT);
    flow.confirm([], 'publisH');
    expect(flow.phase()).toBe('review');
    expect(flow.plan()).not.toBeNull();
    expect(flow.problem()?.code).toBe('CONFIRMATION_MISMATCH');
    flow.confirm([], 'publish');
    expect(flow.phase()).toBe('done');
    expect(flow.problem()).toBeNull();
  });

  it('shows a failure before any outcome as sent, runs nothing, and clears on dismiss', () => {
    const { api, flow } = flowOver({
      plan: () =>
        throwError(() =>
          problem({ code: 'FORBIDDEN_BROKER', status: 403, title: 'No' }),
        ),
    });
    flow.send(INPUT);
    expect(flow.phase()).toBe('failed');
    expect(flow.problem()).toMatchObject({
      code: 'FORBIDDEN_BROKER',
      title: 'No',
    });
    expect(flow.result()).toBeNull();
    expect(api.calls.map((c) => c.kind)).toEqual(['plan']);
    flow.dismiss();
    expect(flow.phase()).toBe('idle');
    expect(flow.problem()).toBeNull();
    flow.dismiss(); // nothing to clear
    expect(flow.phase()).toBe('idle');
  });

  it('does not clear a send in flight or a plan under review on dismiss', () => {
    const plan = new Subject<ReturnType<typeof openPlan>>();
    const { flow } = flowOver({ plan: () => plan });
    flow.send(INPUT);
    flow.dismiss();
    expect(flow.phase()).toBe('planning');
    plan.next(openPlan({ consentsRequired: ['c'] }));
    flow.dismiss();
    expect(flow.phase()).toBe('review');
  });

  it('forgets the result of the last send when another starts', () => {
    const { flow } = flowOver({
      plan: () => of(openPlan()),
      execute: () => of({ output: confirmedResult() }),
    });
    flow.send(INPUT);
    expect(flow.result()).not.toBeNull();
    flow.dismiss();
    expect(flow.result()).toBeNull();
    flow.send(INPUT);
    flow.send(INPUT);
    expect(flow.phase()).toBe('done');
  });

  it('shows a failure of the execute of a plan that asked nothing on the page, and forgets the plan', () => {
    const { flow } = flowOver({
      plan: () => of(openPlan()),
      execute: () => throwError(() => problem({ code: 'BROKER_UNREACHABLE' })),
    });
    flow.send(INPUT);
    expect(flow.phase()).toBe('failed');
    expect(flow.plan()).toBeNull();
    expect(flow.problem()?.code).toBe('BROKER_UNREACHABLE');
  });

  it('tells the arming store the connection is locked when the engine refuses with the lock and names the unlock', async () => {
    const lock = problem({
      code: 'GATE_BLOCKED',
      status: 403,
      gate: {
        enabled: false,
        reason: 'locked',
        source: 'prod-lock',
        fix: {
          actionId: 'ops.arm' as never,
          input: { connectionId: 'c1' },
        },
      },
    });
    const { flow, arming } = flowOver({
      plan: () => throwError(() => lock),
    });
    await arming.arm('c1');
    expect(arming.armed('c1')()).toBe(true);
    flow.send(INPUT);
    expect(flow.phase()).toBe('failed');
    expect(arming.armed('c1')()).toBe(false);

    // A refusal that names another connection's unlock says nothing about this one.
    const other = flowOver({
      plan: () =>
        throwError(() =>
          problem({
            code: 'GATE_BLOCKED',
            gate: {
              enabled: false,
              fix: {
                actionId: 'ops.arm' as never,
                input: { connectionId: 'c2' },
              },
            },
          }),
        ),
    });
    await other.arming.arm('c1');
    other.flow.send(INPUT);
    expect(other.arming.armed('c1')()).toBe(true);
  });

  it('calls the action itself when the engine has no plan route, and shows what the engine answers', () => {
    const noRoute = () =>
      throwError(() => problem({ status: 404, code: 'NOT_FOUND' }));
    const direct = flowOver({
      plan: noRoute,
      call: () => of(confirmedResult()),
    });
    direct.flow.send(INPUT);
    expect(direct.api.calls.map((c) => [c.kind, c.id])).toEqual([
      ['plan', 'messages.publish'],
      ['call', 'messages.publish'],
    ]);
    expect(direct.api.calls[1]).toMatchObject({ input: INPUT });
    expect(direct.flow.phase()).toBe('done');

    const refused = flowOver({
      plan: noRoute,
      call: () =>
        throwError(() =>
          problem({
            status: 412,
            code: 'CAPABILITY_MISSING',
            title: 'No lease',
          }),
        ),
    });
    refused.flow.send(INPUT);
    expect(refused.flow.phase()).toBe('failed');
    expect(refused.flow.result()).toBeNull();
    expect(refused.flow.problem()).toMatchObject({
      code: 'CAPABILITY_MISSING',
      title: 'No lease',
    });

    // Any other failure of the plan is shown, not worked around.
    const other = flowOver({
      plan: () =>
        throwError(() => problem({ status: 403, code: 'FORBIDDEN_RBAC' })),
      call: () => of(confirmedResult()),
    });
    other.flow.send(INPUT);
    expect(other.api.calls.map((c) => c.kind)).toEqual(['plan']);
    expect(other.flow.phase()).toBe('failed');
  });

  it('says it cannot show a job as an outcome, instead of a success', () => {
    const { flow } = flowOver({
      plan: () => of(openPlan()),
      execute: () => of({ jobId: 'j1' }),
    });
    flow.send(INPUT);
    expect(flow.phase()).toBe('failed');
    expect(flow.result()).toBeNull();
    expect(flow.problem()).toEqual({
      title: '',
      detail: null,
      code: null,
      gate: null,
    });
  });

  it('stops listening when the page is left: a late answer shows nothing and nothing more is sent', () => {
    const plan = new Subject<ReturnType<typeof openPlan>>();
    const { api, flow } = flowOver({
      plan: () => plan,
      execute: () => of({ output: confirmedResult() }),
    });
    flow.send(INPUT);
    expect(plan.observed).toBe(true);
    TestBed.resetTestingModule(); // the page is destroyed
    expect(plan.observed).toBe(false);
    plan.next(openPlan());
    expect(api.calls.map((c) => c.kind)).toEqual(['plan']);
    expect(flow.result()).toBeNull();
    expect(flow.phase()).toBe('planning');
  });

  it('starts a new send from a shown result or failure with both cleared', () => {
    let attempt = 0;
    const plan = new Subject<ReturnType<typeof openPlan>>();
    const { flow } = flowOver({
      plan: () => {
        attempt += 1;
        return attempt === 1
          ? throwError(() => problem({ code: 'FORBIDDEN_RBAC', status: 403 }))
          : attempt === 2
            ? of(openPlan())
            : plan;
      },
      execute: () => of({ output: confirmedResult() }),
    });
    flow.send(INPUT);
    expect(flow.problem()).not.toBeNull();
    flow.send(INPUT); // from a failure, without clearing it first
    expect(flow.phase()).toBe('done');
    expect(flow.problem()).toBeNull();
    expect(flow.result()).not.toBeNull();
    flow.send(INPUT); // from a result
    expect(flow.phase()).toBe('planning');
    expect(flow.result()).toBeNull();
    expect(flow.problem()).toBeNull();
  });

  it('closes only a plan under review: cancel leaves a send in flight and a shown result alone', () => {
    const plan = new Subject<ReturnType<typeof openPlan>>();
    const first = flowOver({ plan: () => plan });
    first.flow.send(INPUT);
    first.flow.cancel();
    expect(first.flow.phase()).toBe('planning');
    const second = flowOver({
      plan: () => of(openPlan()),
      execute: () => of({ output: confirmedResult() }),
    });
    second.flow.send(INPUT);
    second.flow.cancel();
    expect(second.flow.phase()).toBe('done');
    expect(second.flow.result()).not.toBeNull();
  });

  it('forgets a refusal shown in the dialog when the dialog is closed', () => {
    const { flow } = flowOver({
      plan: () => of(openPlan({ consentsRequired: ['c'] })),
      execute: () => throwError(() => problem({ code: 'CONSENT_REQUIRED' })),
    });
    flow.send(INPUT);
    flow.confirm([], undefined);
    expect(flow.problem()?.code).toBe('CONSENT_REQUIRED');
    flow.cancel();
    expect(flow.problem()).toBeNull();
    expect(flow.phase()).toBe('idle');
  });

  it('is executing, not planning, while the direct call is on its way', () => {
    const answer = new Subject<ReturnType<typeof confirmedResult>>();
    const { flow } = flowOver({
      plan: () => throwError(() => problem({ status: 404, code: 'NOT_FOUND' })),
      call: () => answer,
    });
    flow.send(INPUT);
    expect(flow.phase()).toBe('executing');
    expect(flow.busy()).toBe(true);
    answer.next(confirmedResult());
    expect(flow.phase()).toBe('done');
  });

  it('runs a reviewed plan once: an answer given again while it executes is ignored', () => {
    const done = new Subject<{ output: ReturnType<typeof confirmedResult> }>();
    const { api, flow } = flowOver({
      plan: () => of(openPlan({ consentsRequired: ['c'] })),
      execute: () => done,
    });
    flow.send(INPUT);
    flow.confirm(['c'], undefined);
    flow.confirm(['c'], undefined);
    expect(api.calls.filter((call) => call.kind === 'execute')).toHaveLength(1);
    expect(flow.phase()).toBe('executing');
    expect(flow.plan()).not.toBeNull();
  });
});
