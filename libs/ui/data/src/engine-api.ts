// EngineApi: the typed way to call the engine (ADR-003, no client codegen). Types come from the
// zod schemas of the contracts. In dev and test builds each answer is parsed against the action's
// output schema; the UI never parses a response by hand.
import { HttpClient, type HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  ActionDef,
  GateDecision,
  InputOf,
  OutputOf,
  WarningRef,
} from '@app/contracts';
import { API_PREFIX } from '@app/ui-platform';
import { map, throwError, type Observable } from 'rxjs';

import { buildEngineRequest } from './engine-request';
import { randomId } from './ids';
import { ENGINE_PARSE } from './parse-mode';

/** A gate of a plan: why it blocks, and the action that fixes it. */
export interface PlanGate {
  readonly id: string;
  readonly blocking: boolean;
  readonly reason: string;
  readonly source?: string;
  readonly fix?: NonNullable<GateDecision['fix']>;
}

/**
 * What `POST /actions/{actionId}/plans` returns (the engine's `Plan`, blueprint 5.1, without the
 * input it was made from). The contract for it lands with the executor; until then this is the
 * UI's view (OQ-191).
 */
export interface EnginePlan<Preview = unknown> {
  readonly id: string;
  readonly actionId: string;
  readonly risk: string;
  readonly env: string;
  readonly gates: readonly PlanGate[];
  readonly warnings: readonly WarningRef[];
  readonly consentsRequired: readonly string[];
  readonly confirmationPhrase?: string;
  readonly approvals: {
    readonly required: number;
    readonly granted: readonly {
      readonly by: string;
      readonly at: number;
      readonly decision: 'approve' | 'reject';
    }[];
  };
  readonly preview: Preview;
  readonly expiresAt: number;
  readonly state:
    | 'open'
    | 'awaiting-approval'
    | 'approved'
    | 'executing'
    | 'executed'
    | 'expired'
    | 'rejected';
}

export interface ExecuteRequest {
  /** The consents the user gave: the ids in `plan.consentsRequired`. */
  readonly consents: readonly string[];
  /** The typed phrase, when `plan.confirmationPhrase` is set. */
  readonly confirmation?: string;
  /** Generated when omitted; a retry of the same Observable reuses it. */
  readonly idempotencyKey?: string;
}

export type ExecuteResult<Output> =
  | { readonly output: Output; readonly receipt?: unknown }
  | { readonly jobId: string };

type Params = Record<
  string,
  string | number | boolean | readonly (string | number | boolean)[]
>;

@Injectable({ providedIn: 'root' })
export class EngineApi {
  readonly #http = inject(HttpClient);
  readonly #parse = inject(ENGINE_PARSE);

  /** Runs an action: `query` actions read, the others change things (after a plan, when required). */
  call<A extends ActionDef>(
    action: A,
    input: InputOf<A>,
  ): Observable<OutputOf<A>> {
    let request;
    try {
      request = buildEngineRequest(action, input);
    } catch (error) {
      return throwError(() => error);
    }
    // The engine refuses a command, peek or job without an idempotency key (`VALIDATION_FAILED`). The key is made
    // here, once per call, so a retry of the same Observable repeats the same key and is not run twice.
    const headers =
      action.kind === 'query' ? {} : { 'Idempotency-Key': randomId() };
    return this.#http
      .request<unknown>(request.method, request.url, {
        headers,
        ...(request.params === undefined
          ? {}
          : { params: request.params as Params as HttpParams | Params }),
        ...(request.body === undefined ? {} : { body: request.body }),
      })
      .pipe(map((body) => this.#output(action, body)));
  }

  /** Asks the engine to plan an action: gates, warnings, consents, preview. Changes nothing. */
  plan<A extends ActionDef>(
    action: A,
    input: InputOf<A>,
  ): Observable<EnginePlan> {
    return this.#http.post<EnginePlan>(
      `${API_PREFIX}/actions/${encodeURIComponent(action.id)}/plans`,
      input,
    );
  }

  /** Executes a plan. The result is the action's output, or a job to follow. */
  execute<A extends ActionDef>(
    action: A,
    planId: string,
    request: ExecuteRequest,
  ): Observable<ExecuteResult<OutputOf<A>>> {
    const body = {
      consents: request.consents,
      ...(request.confirmation === undefined
        ? {}
        : { confirmation: request.confirmation }),
      idempotencyKey: request.idempotencyKey ?? randomId(),
    };
    return this.#http
      .post<
        ExecuteResult<unknown>
      >(`${API_PREFIX}/plans/${encodeURIComponent(planId)}/execute`, body)
      .pipe(
        map((result) =>
          'output' in result
            ? {
                ...result,
                output: this.#output(action, result.output),
              }
            : result,
        ),
      );
  }

  #output<A extends ActionDef>(action: A, body: unknown): OutputOf<A> {
    return (this.#parse ? action.output.parse(body) : body) as OutputOf<A>;
  }
}
