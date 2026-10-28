// The send flow of the studio (R4, OQ-1515): plan, then execute. Nothing here decides whether the person may publish:
// the engine's plan says what it needs (gates, consents, a phrase, approvals) and this service only carries those
// answers to the dialog and the person's answers back. With a plan that needs nothing, the click on Send is the
// consent and the plan is executed at once. One request is in flight at a time; a second click while busy is ignored.
//
// The engine does not route `POST /actions/{id}/plans` and `POST /plans/{id}/execute` yet (OQ-191, OQ-282). When the
// plan call is answered "no such route", the flow calls the action directly: the engine still applies its guards
// (the prod lock, permissions, a plan where one is required, which it answers with 428 PLAN_REQUIRED) and the
// studio shows whatever it answers. Leaving the page cancels the request in flight and shows nothing stale.
import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ArmingStore, EngineApi, type EnginePlan } from '@app/ui-data';
import { Subscription } from 'rxjs';

import { PUBLISH_ACTION } from './contract-values';
import type { MessagesPublishInput } from './draft-to-input';
import { needsReview } from './plan-needs';
import {
  offersUnlock,
  planRouteMissing,
  problemView,
  type ProblemView,
} from './problem';
import type { PublishResult } from './outcome-text';

export type SendPhase =
  | 'idle'
  | 'planning'
  | 'review'
  | 'executing'
  | 'done'
  | 'failed';

@Injectable()
export class SendFlow {
  readonly #api = inject(EngineApi);
  readonly #arming = inject(ArmingStore);

  readonly #phase = signal<SendPhase>('idle');
  readonly #plan = signal<EnginePlan | null>(null);
  readonly #result = signal<PublishResult | null>(null);
  readonly #problem = signal<ProblemView | null>(null);
  /** Everything in flight; one container, so leaving the page ends them all, also an answer that arrived at once. */
  readonly #live = new Subscription();
  #cid = '';

  readonly phase = this.#phase.asReadonly();
  /** The plan under review, while the dialog is open. */
  readonly plan = this.#plan.asReadonly();
  readonly result = this.#result.asReadonly();
  /** The failure to show: on the page when `failed`, in the dialog when `review`. */
  readonly problem = this.#problem.asReadonly();
  /** A request is on its way: nothing else can be sent. */
  readonly busy = computed(
    () => this.#phase() === 'planning' || this.#phase() === 'executing',
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.#live.unsubscribe();
    });
  }

  /** Plans, then executes (at once when the plan asks nothing). Ignored while busy or while a plan is under review. */
  send(input: MessagesPublishInput): void {
    if (this.busy() || this.#phase() === 'review') return;
    this.#cid = input.cid;
    this.#result.set(null);
    this.#problem.set(null);
    this.#phase.set('planning');
    this.#live.add(
      this.#api.plan(PUBLISH_ACTION, input).subscribe({
        next: (plan) => {
          if (needsReview(plan)) {
            this.#plan.set(plan);
            this.#phase.set('review');
          } else {
            this.#execute(plan, [], undefined);
          }
        },
        error: (error: unknown) => {
          if (planRouteMissing(error)) this.#direct(input);
          else this.#fail(error);
        },
      }),
    );
  }

  /** The person answered the dialog: run the plan with their consents and phrase. */
  confirm(consents: readonly string[], confirmation: string | undefined): void {
    const plan = this.#plan();
    if (plan === null || this.#phase() !== 'review') return;
    this.#problem.set(null);
    this.#execute(plan, consents, confirmation);
  }

  /** The dialog was closed without running: the plan is left to expire on the engine. */
  cancel(): void {
    if (this.#phase() !== 'review') return;
    this.#plan.set(null);
    this.#problem.set(null);
    this.#phase.set('idle');
  }

  /** Forgets the result or the failure shown on the page. */
  dismiss(): void {
    if (this.#phase() !== 'done' && this.#phase() !== 'failed') return;
    this.#result.set(null);
    this.#problem.set(null);
    this.#phase.set('idle');
  }

  #execute(
    plan: EnginePlan,
    consents: readonly string[],
    confirmation: string | undefined,
  ): void {
    const fromReview = this.#plan() !== null;
    this.#phase.set('executing');
    this.#live.add(
      this.#api
        .execute(PUBLISH_ACTION, plan.id, {
          consents,
          ...(confirmation === undefined ? {} : { confirmation }),
        })
        .subscribe({
          next: (answer) => {
            this.#settle('output' in answer ? answer.output : null);
          },
          error: (error: unknown) => {
            this.#fail(error, fromReview);
          },
        }),
    );
  }

  /** The engine has no plan route: call the action itself and let the engine apply its guards. */
  #direct(input: MessagesPublishInput): void {
    this.#phase.set('executing');
    this.#live.add(
      this.#api.call(PUBLISH_ACTION, input).subscribe({
        next: (output) => {
          this.#settle(output);
        },
        error: (error: unknown) => {
          this.#fail(error);
        },
      }),
    );
  }

  #settle(output: PublishResult | null): void {
    this.#plan.set(null);
    if (output === null) {
      // A job id for a publish: nothing this page can show as an outcome, so it says so instead of a success.
      this.#problem.set(problemView(new Error('')));
      this.#phase.set('failed');
      return;
    }
    this.#result.set(output);
    this.#phase.set('done');
  }

  #fail(error: unknown, backToReview = false): void {
    const view = problemView(error);
    if (offersUnlock(view, this.#cid)) this.#arming.noteLocked(this.#cid);
    this.#problem.set(view);
    if (backToReview) {
      this.#phase.set('review');
    } else {
      this.#phase.set('failed');
    }
  }
}
