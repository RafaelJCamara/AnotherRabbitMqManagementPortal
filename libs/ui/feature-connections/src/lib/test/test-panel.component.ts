// The two tests of a connection (M0-52, R4): the management API and AMQP, each on its own, of the form's draft or of
// the saved connection. A failed test is an answer with a specific cause, so each cause has its own words (the
// engine's fixed `message` is shown as sent beside them); a Problem (validation, transport) is shown as sent. Each
// test has its own polite live region and its own busy state, and one result never overwrites the other.
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import {
  AmqpTestFailureCodeSchema,
  HttpTestFailureCodeSchema,
  type GateDecision,
  type InputOf,
  type OutputOf,
  type connectionsTestAmqp,
  type connectionsTestHttp,
} from '@app/contracts';
import { TranslocoDirective } from '@jsverse/transloco';

import { ConnectionsService } from '../connections.service';
import { problemView, type ProblemView } from '../problem';
import { ProblemAlert } from '../problem-alert.component';

type HttpResult = OutputOf<typeof connectionsTestHttp>;
type AmqpResult = OutputOf<typeof connectionsTestAmqp>;

/** What a test is aimed at: a saved connection (its stored login) or the form's draft. */
export type TestTarget = InputOf<typeof connectionsTestHttp>;

export interface AmqpPorts {
  readonly plain: number | null;
  readonly tls: number | null;
}

type Run<R> =
  | { readonly state: 'idle' }
  | { readonly state: 'running' }
  | { readonly state: 'done'; readonly result: R }
  | { readonly state: 'failed'; readonly problem: ProblemView };

const IDLE = { state: 'idle' } as const;

@Component({
  selector: 'app-test-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProblemAlert, TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      <section class="tests" [attr.aria-labelledby]="'tests-title'">
        <h2 id="tests-title">{{ t('connections.test.title') }}</h2>
        <p class="hint">
          {{
            source() === 'saved'
              ? t('connections.test.hintSaved')
              : t('connections.test.hintDraft')
          }}
        </p>
        @if (target() === null) {
          <p class="hint">{{ t('connections.test.needAddress') }}</p>
        }
        <div class="pair">
          <div class="one">
            <h3 id="test-http-title">
              {{ t('connections.test.headingHttp') }}
            </h3>
            <button
              type="button"
              [attr.aria-disabled]="
                target() === null || http().state === 'running' ? 'true' : null
              "
              (click)="runHttp()"
            >
              {{
                http().state === 'running'
                  ? t('connections.test.running')
                  : t('connections.test.run')
              }}
            </button>
            <div
              class="result"
              aria-live="polite"
              aria-labelledby="test-http-title"
              role="status"
            >
              @switch (http().state) {
                @case ('done') {
                  @if (httpResult(); as r) {
                    @if (r.ok) {
                      <p class="ok">
                        {{
                          t('connections.test.okHttp', {
                            ms: r.tookMs,
                            product: r.broker?.product ?? '',
                            version: r.broker?.version ?? '',
                          })
                        }}
                      </p>
                      <dl>
                        @if (r.broker?.clusterName; as cluster) {
                          <dt>{{ t('connections.test.cluster') }}</dt>
                          <dd>{{ cluster }}</dd>
                        }
                        @if (r.broker?.user; as user) {
                          <dt>{{ t('connections.test.user') }}</dt>
                          <dd>{{ user }}</dd>
                        }
                        @if (r.broker?.tags.length) {
                          <dt>{{ t('connections.test.tags') }}</dt>
                          <dd>{{ r.broker.tags.join(', ') }}</dd>
                        }
                        <dt>{{ t('connections.test.target') }}</dt>
                        <dd>{{ r.target.url }}</dd>
                      </dl>
                      @if (portsOffered(r); as ports) {
                        <p>
                          {{
                            t('connections.test.ports', {
                              plain:
                                ports.plain ?? t('connections.test.noPort'),
                              tls: ports.tls ?? t('connections.test.noPort'),
                            })
                          }}
                          <button type="button" (click)="amqpPorts.emit(ports)">
                            {{ t('connections.test.usePorts') }}
                          </button>
                        </p>
                      }
                    } @else if (r.failure; as failure) {
                      <p class="bad">
                        {{ failureTitle(failure.code, t) }}
                      </p>
                      <p>{{ failureHint(failure.code, t) }}</p>
                      <p class="engine">
                        <span class="key">{{
                          t('connections.test.engineSaid')
                        }}</span>
                        {{ failure.message }}
                      </p>
                    }
                  }
                }
                @case ('failed') {
                  @if (httpProblem(); as problem) {
                    <app-problem-alert [problem]="problem" />
                  }
                }
              }
            </div>
          </div>
          <div class="one">
            <h3 id="test-amqp-title">
              {{ t('connections.test.headingAmqp') }}
            </h3>
            <button
              type="button"
              [attr.aria-disabled]="
                target() === null || amqp().state === 'running' ? 'true' : null
              "
              (click)="runAmqp()"
            >
              {{
                amqp().state === 'running'
                  ? t('connections.test.running')
                  : t('connections.test.run')
              }}
            </button>
            <div
              class="result"
              aria-live="polite"
              aria-labelledby="test-amqp-title"
              role="status"
            >
              @switch (amqp().state) {
                @case ('done') {
                  @if (amqpResult(); as r) {
                    @if (r.ok) {
                      <p class="ok">
                        {{
                          t('connections.test.okAmqp', {
                            ms: r.tookMs,
                            host: r.target.host,
                            port: r.target.port,
                            vhost: r.target.vhost,
                          })
                        }}
                      </p>
                    } @else if (r.failure; as failure) {
                      <p class="bad">
                        {{ failureTitle(failure.code, t) }}
                      </p>
                      <p>{{ failureHint(failure.code, t) }}</p>
                      <p class="engine">
                        <span class="key">{{
                          t('connections.test.engineSaid')
                        }}</span>
                        {{ failure.message }}
                      </p>
                    }
                    @if (gateRows(r.gates); as rows) {
                      @if (rows.length > 0) {
                        <table>
                          <caption>
                            {{
                              t('connections.test.gates')
                            }}
                          </caption>
                          <thead>
                            <tr>
                              <th scope="col">
                                {{ t('connections.test.feature') }}
                              </th>
                              <th scope="col">
                                {{ t('connections.test.state') }}
                              </th>
                              <th scope="col">
                                {{ t('connections.test.why') }}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            @for (row of rows; track row.id) {
                              <tr>
                                <th scope="row">{{ row.id }}</th>
                                <td>
                                  {{
                                    row.gate.enabled === true
                                      ? t('connections.test.open')
                                      : t('connections.test.closed')
                                  }}
                                </td>
                                <td>
                                  {{
                                    row.gate.enabled === true
                                      ? ''
                                      : (row.gate.reason ??
                                        t('connections.gate.noReason'))
                                  }}
                                </td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      }
                    }
                  }
                }
                @case ('failed') {
                  @if (amqpProblem(); as problem) {
                    <app-problem-alert [problem]="problem" />
                  }
                }
              }
            </div>
          </div>
        </div>
      </section>
    </ng-container>
  `,
  styles: `
    :host {
      display: block;
    }
    .pair {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
      gap: var(--ds-space-4);
    }
    h2,
    h3 {
      margin: var(--ds-space-3) 0 var(--ds-space-2);
    }
    .hint {
      color: var(--ds-color-text-muted);
      margin: 0 0 var(--ds-space-2);
    }
    button {
      min-height: var(--ds-target-size);
      padding: 0 var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font: inherit;
      cursor: pointer;
    }
    button[aria-disabled='true'] {
      cursor: not-allowed;
      border-style: dashed;
    }
    button:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    .result {
      margin-top: var(--ds-space-2);
      min-height: 1.5em;
    }
    .ok {
      color: var(--ds-color-text-success);
      font-weight: 600;
    }
    .bad {
      color: var(--ds-color-text-danger);
      font-weight: 600;
    }
    p {
      margin: 0 0 var(--ds-space-1);
    }
    .key {
      color: var(--ds-color-text-muted);
      margin-inline-end: var(--ds-space-1);
    }
    dl {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: var(--ds-space-1) var(--ds-space-3);
      margin: var(--ds-space-1) 0;
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    table {
      border-collapse: collapse;
      margin-top: var(--ds-space-2);
    }
    caption {
      text-align: start;
      color: var(--ds-color-text-muted);
    }
    th,
    td {
      padding: var(--ds-space-1) var(--ds-space-3);
      border-bottom: 1px solid var(--ds-color-border);
      text-align: start;
      vertical-align: top;
    }
  `,
})
export class TestPanel {
  readonly #service = inject(ConnectionsService);

  /** What to test, or `null` when there is nothing to aim at yet (the buttons stay closed and say why). */
  readonly target = input.required<TestTarget | null>();
  /** Whether the target is a saved connection or the form's draft (only the words differ). */
  readonly source = input<'saved' | 'draft'>('saved');
  /** The AMQP ports the management test reported; the form may offer to use them. */
  readonly amqpPorts = output<AmqpPorts>();

  protected readonly http = signal<Run<HttpResult>>(IDLE);
  protected readonly amqp = signal<Run<AmqpResult>>(IDLE);

  protected httpResult(): HttpResult | null {
    const run = this.http();
    return run.state === 'done' ? run.result : null;
  }

  protected httpProblem(): ProblemView | null {
    const run = this.http();
    return run.state === 'failed' ? run.problem : null;
  }

  protected amqpResult(): AmqpResult | null {
    const run = this.amqp();
    return run.state === 'done' ? run.result : null;
  }

  protected amqpProblem(): ProblemView | null {
    const run = this.amqp();
    return run.state === 'failed' ? run.problem : null;
  }

  protected portsOffered(result: HttpResult): AmqpPorts | null {
    const ports = result.amqpPorts;
    return ports === undefined || (ports.plain === null && ports.tls === null)
      ? null
      : ports;
  }

  protected gateRows(
    gates: Readonly<Record<string, GateDecision>>,
  ): readonly { readonly id: string; readonly gate: GateDecision }[] {
    return Object.entries(gates)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, gate]) => ({ id, gate }));
  }

  protected failureTitle(
    code: string,
    t: (key: string, params?: Record<string, string | number>) => string,
  ): string {
    return this.#known(code)
      ? t(`connections.test.failure.${code}.title`)
      : code;
  }

  protected failureHint(
    code: string,
    t: (key: string, params?: Record<string, string | number>) => string,
  ): string {
    return this.#known(code) ? t(`connections.test.failure.${code}.hint`) : '';
  }

  protected async runHttp(): Promise<void> {
    const target = this.target();
    if (target === null || this.http().state === 'running') return;
    this.http.set({ state: 'running' });
    try {
      const result = await this.#service.testHttp(target);
      this.http.set({ state: 'done', result });
    } catch (error) {
      this.http.set({ state: 'failed', problem: problemView(error) });
    }
  }

  protected async runAmqp(): Promise<void> {
    const target = this.target();
    if (target === null || this.amqp().state === 'running') return;
    this.amqp.set({ state: 'running' });
    try {
      const result = await this.#service.testAmqp(target);
      this.amqp.set({ state: 'done', result });
    } catch (error) {
      this.amqp.set({ state: 'failed', problem: problemView(error) });
    }
  }

  #known(code: string): boolean {
    return (
      HttpTestFailureCodeSchema.safeParse(code).success ||
      AmqpTestFailureCodeSchema.safeParse(code).success
    );
  }
}
