// A stand-in for `EngineApi` in the studio's specs: it records every call, answers `connections.list` with the
// profiles it is given, and answers plan, execute and the direct publish call through handlers the spec sets. A call
// nobody expected is an error, never a made-up answer. Never part of the library build.
import type { ActionDef, ConnectionProfile } from '@app/contracts';
import {
  EngineApi,
  type EnginePlan,
  type ExecuteRequest,
  type ExecuteResult,
} from '@app/ui-data';
import { NEVER, Observable, of, throwError } from 'rxjs';

import type { MessagesPublishInput } from './draft-to-input';
import type { PublishResult } from './outcome-text';

export type Recorded =
  | { readonly kind: 'call'; readonly id: string; readonly input: unknown }
  | { readonly kind: 'plan'; readonly id: string; readonly input: unknown }
  | {
      readonly kind: 'execute';
      readonly id: string;
      readonly planId: string;
      readonly request: ExecuteRequest;
    };

export interface FakeApiHandlers {
  readonly profiles?: readonly ConnectionProfile[];
  /** The answer of `connections.list`, when a spec needs it to arrive late; otherwise `profiles` answers at once. */
  readonly list?: () => Observable<{ items: readonly ConnectionProfile[] }>;
  readonly plan?: (input: MessagesPublishInput) => Observable<EnginePlan>;
  readonly execute?: (
    planId: string,
    request: ExecuteRequest,
  ) => Observable<ExecuteResult<PublishResult>>;
  readonly call?: (input: MessagesPublishInput) => Observable<PublishResult>;
  /** The answer of `ops.arm`. */
  readonly arm?: () => Observable<{ armedAt: number; expiresAt: number }>;
  /** The answer of `ops.disarm`. */
  readonly disarm?: () => Observable<{ wasArmed: boolean }>;
}

export class FakeApi {
  readonly calls: Recorded[] = [];
  handlers: FakeApiHandlers;

  constructor(handlers: FakeApiHandlers = {}) {
    this.handlers = handlers;
  }

  call(action: ActionDef, input: unknown): Observable<unknown> {
    this.calls.push({ kind: 'call', id: action.id, input });
    if (action.id === 'connections.list') {
      return (
        this.handlers.list?.() ?? of({ items: this.handlers.profiles ?? [] })
      );
    }
    if (action.id === 'ops.arm') {
      const arm = this.handlers.arm;
      if (arm !== undefined) return arm();
      const now = Date.now();
      return of({ armedAt: now, expiresAt: now + 900_000 });
    }
    if (action.id === 'ops.disarm') {
      return this.handlers.disarm?.() ?? of({ wasArmed: true });
    }
    if (action.id === 'messages.publish' && this.handlers.call !== undefined) {
      return this.handlers.call(input as MessagesPublishInput);
    }
    return throwError(() => new Error(`unexpected call ${action.id}`));
  }

  plan(action: ActionDef, input: unknown): Observable<EnginePlan> {
    this.calls.push({ kind: 'plan', id: action.id, input });
    const plan = this.handlers.plan;
    return plan === undefined
      ? throwError(() => new Error('unexpected plan'))
      : plan(input as MessagesPublishInput);
  }

  execute(
    action: ActionDef,
    planId: string,
    request: ExecuteRequest,
  ): Observable<ExecuteResult<unknown>> {
    this.calls.push({ kind: 'execute', id: action.id, planId, request });
    const execute = this.handlers.execute;
    return execute === undefined
      ? throwError(() => new Error('unexpected execute'))
      : execute(planId, request);
  }
}

/** An answer that never arrives: the request stays in flight. */
export const pending = NEVER;

/** `provide: EngineApi` for a spec. */
export const provideFakeApi = (api: FakeApi) => ({
  provide: EngineApi,
  useValue: api as unknown as EngineApi,
});

/** A plan that asks for nothing. */
export function openPlan(overrides: Partial<EnginePlan> = {}): EnginePlan {
  return {
    id: 'plan-1',
    actionId: 'messages.publish',
    risk: 'medium',
    env: 'dev',
    gates: [],
    warnings: [],
    consentsRequired: [],
    approvals: { required: 0, granted: [] },
    preview: {
      exchange: '',
      routingKey: 'orders',
      copies: 1,
      bodyBytes: 5,
      headerCount: 0,
    },
    expiresAt: 4_000_000_000_000,
    state: 'open',
    ...overrides,
  };
}

export function confirmedResult(copies = 1): PublishResult {
  return {
    copies: Array.from({ length: copies }, (_, index) => ({
      index,
      outcome: 'confirmed' as const,
    })),
    summary: {
      confirmed: copies,
      nacked: 0,
      returned: 0,
      blocked: 0,
      timeout: 0,
      failed: 0,
      'not-sent': 0,
    },
    allConfirmed: true,
    historyId: 'h1',
    historyRecorded: true,
  };
}
