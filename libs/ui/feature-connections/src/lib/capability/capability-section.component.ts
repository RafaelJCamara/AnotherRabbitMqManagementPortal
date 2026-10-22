// The capabilities of a connection (M0-52, R7): the cached BrokerProfile of the broker (`profile.get`), with a button
// that probes the broker again (`probe.run`) and lists the twelve steps. The card has one row per gate, as the
// engine sent it; the verification banner and the broker facts come from the same profile. Nothing here computes
// authorisation, and unknown is never "available": a connection that was never probed, a failed read and a profile
// that does not parse each say so in words. The probe reads the management API with the stored login and keeps its
// answer in the engine's cache; it changes nothing in the broker.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import {
  ConnectionIdSchema,
  type OutputOf,
  type probeRun,
} from '@app/contracts';
import { BrokerProfileSchema, type BrokerProfile } from '@app/domain-model';
import { VerificationBanner } from '@app/ui-design';
import { TranslocoDirective } from '@jsverse/transloco';

import { ConnectionsService } from '../connections.service';
import { problemView, type ProblemView } from '../problem';
import { ProblemAlert } from '../problem-alert.component';
import { capabilityRows } from './capability-model';

type Steps = OutputOf<typeof probeRun>['steps'];

type Read =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly raw: unknown;
      readonly parsed: BrokerProfile | null;
    }
  | { readonly kind: 'not-probed'; readonly problem: ProblemView }
  | { readonly kind: 'failed'; readonly problem: ProblemView };

@Component({
  selector: 'app-capability-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProblemAlert, TranslocoDirective, VerificationBanner],
  template: `
    <ng-container *transloco="let t">
      <section aria-labelledby="capabilities-title">
        <h2 id="capabilities-title">
          {{ t('connections.capabilities.title') }}
        </h2>
        <p class="hint">{{ t('connections.capabilities.hint') }}</p>
        <button
          type="button"
          [attr.aria-disabled]="probing() ? 'true' : null"
          (click)="check()"
        >
          {{
            probing()
              ? t('connections.capabilities.checking')
              : t('connections.capabilities.check')
          }}
        </button>
        <div aria-live="polite" role="status" class="status">
          @switch (read().kind) {
            @case ('loading') {
              <p>{{ t('connections.capabilities.loading') }}</p>
            }
            @case ('not-probed') {
              <p>{{ t('connections.capabilities.notProbed') }}</p>
            }
          }
        </div>
        @if (probeError(); as problem) {
          <app-problem-alert [problem]="problem" />
        }
        @if (failure(); as problem) {
          <p>{{ t('connections.capabilities.unknown') }}</p>
          <app-problem-alert [problem]="problem" />
        }
        @if (ready(); as ready) {
          <app-verification-banner
            [verification]="ready.parsed?.verification"
            [labels]="{
              'unverified-patch': t(
                'connections.capabilities.verification.unverifiedPatch'
              ),
              'unverified-minor': t(
                'connections.capabilities.verification.unverifiedMinor'
              ),
              'unknown-build': t(
                'connections.capabilities.verification.unknownBuild'
              ),
            }"
            [detail]="ready.parsed?.versions?.min?.raw"
          />
          @if (ready.parsed; as profile) {
            <dl class="facts">
              <dt>{{ t('connections.capabilities.product') }}</dt>
              <dd>{{ profile.product }}</dd>
              <dt>{{ t('connections.capabilities.version') }}</dt>
              <dd>
                {{
                  profile.versions.min?.raw ??
                    t('connections.capabilities.notReported')
                }}
              </dd>
              <dt>{{ t('connections.capabilities.era') }}</dt>
              <dd>
                {{ profile.era.value }}
                @if (profile.era.conservative) {
                  ({{ t('connections.capabilities.assumed') }})
                }
              </dd>
              <dt>{{ t('connections.capabilities.stats') }}</dt>
              <dd>{{ statsText(profile, t) }}</dd>
            </dl>
          } @else {
            <p>{{ t('connections.capabilities.unreadable') }}</p>
          }
          @if (rows(); as rows) {
            <table class="gates">
              <caption>
                {{
                  t('connections.capabilities.caption')
                }}
              </caption>
              <thead>
                <tr>
                  <th scope="col">
                    {{ t('connections.capabilities.featureColumn') }}
                  </th>
                  <th scope="col">{{ t('connections.capabilities.state') }}</th>
                  <th scope="col">{{ t('connections.capabilities.why') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (row of rows; track row.id) {
                  <tr>
                    <th scope="row">
                      {{
                        row.known
                          ? t('connections.capabilities.feature.' + row.id)
                          : row.id
                      }}
                    </th>
                    <td>
                      {{ t('connections.capabilities.states.' + row.state) }}
                    </td>
                    <td>
                      @if (row.state !== 'open') {
                        <span class="reason">{{
                          row.reason ?? t('connections.gate.noReason')
                        }}</span
                        >&ngsp;
                        @if (row.link; as link) {
                          <a
                            class="source"
                            [href]="link.href"
                            target="_blank"
                            rel="noopener noreferrer"
                            >{{ t('connections.gate.source') }}
                            {{ link.host }}</a
                          >
                        } @else if (row.source) {
                          <span class="source"
                            >{{ t('connections.gate.source') }}
                            {{ row.source }}</span
                          >
                        }
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p>{{ t('connections.capabilities.noGates') }}</p>
          }
        }
        @if (steps(); as steps) {
          <table class="steps">
            <caption>
              {{
                t('connections.capabilities.stepsCaption')
              }}
            </caption>
            <thead>
              <tr>
                <th scope="col">{{ t('connections.capabilities.step') }}</th>
                <th scope="col">{{ t('connections.capabilities.state') }}</th>
                <th scope="col">{{ t('connections.capabilities.detail') }}</th>
              </tr>
            </thead>
            <tbody>
              @for (step of steps; track step.id) {
                <tr>
                  <th scope="row">
                    {{ t('connections.capabilities.steps.' + step.id) }}
                  </th>
                  <td>
                    {{
                      t('connections.capabilities.stepStates.' + step.status)
                    }}
                  </td>
                  <td>{{ step.detail ?? '' }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      </section>
    </ng-container>
  `,
  styles: `
    :host {
      display: block;
    }
    h2 {
      margin: var(--ds-space-4) 0 var(--ds-space-2);
    }
    .hint {
      margin: 0 0 var(--ds-space-2);
      color: var(--ds-color-text-muted);
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
    button:focus-visible,
    a:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    .status p {
      margin: var(--ds-space-2) 0;
    }
    .facts {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: var(--ds-space-1) var(--ds-space-4);
      margin: var(--ds-space-3) 0;
    }
    .facts dt {
      color: var(--ds-color-text-muted);
    }
    .facts dd {
      margin: 0;
    }
    table {
      border-collapse: collapse;
      margin: var(--ds-space-3) 0;
      min-width: 30rem;
    }
    th,
    td {
      padding: var(--ds-space-1) var(--ds-space-3);
      border-bottom: 1px solid var(--ds-color-border);
      text-align: start;
      vertical-align: top;
    }
    caption {
      text-align: start;
      color: var(--ds-color-text-muted);
      padding-bottom: var(--ds-space-1);
    }
    a {
      color: var(--ds-color-text-link);
    }
    .source {
      margin-inline-start: var(--ds-space-2);
    }
  `,
})
export class CapabilitySection {
  readonly #service = inject(ConnectionsService);

  /** The connection whose capabilities this shows. */
  readonly cid = input.required<string>();

  protected readonly read = signal<Read>({ kind: 'loading' });
  protected readonly probing = signal(false);
  protected readonly steps = signal<Steps | null>(null);
  protected readonly probeError = signal<ProblemView | null>(null);

  protected readonly ready = computed(() => {
    const read = this.read();
    return read.kind === 'ready' ? read : null;
  });
  protected readonly failure = computed(() => {
    const read = this.read();
    return read.kind === 'failed' ? read.problem : null;
  });
  /** One row per gate as sent, or `null` when the profile has no readable gates (none is not "all open"). */
  protected readonly rows = computed(() => {
    const ready = this.ready();
    return ready === null ? null : capabilityRows(ready.raw);
  });

  constructor() {
    effect((onCleanup) => {
      const parsed = ConnectionIdSchema.safeParse(this.cid());
      let current = true;
      onCleanup(() => {
        current = false;
      });
      this.steps.set(null);
      this.probeError.set(null);
      if (!parsed.success) {
        this.read.set({
          kind: 'failed',
          problem: { title: '', detail: null, code: 'NOT_FOUND', gate: null },
        });
        return;
      }
      this.read.set({ kind: 'loading' });
      this.#service.profile(parsed.data).then(
        (out) => {
          if (current) this.read.set(this.#ready(out.profile));
        },
        (error: unknown) => {
          if (!current) return;
          const problem = problemView(error);
          this.read.set(
            problem.code === 'NOT_FOUND'
              ? { kind: 'not-probed', problem }
              : { kind: 'failed', problem },
          );
        },
      );
    });
  }

  protected statsText(
    profile: BrokerProfile,
    t: (key: string) => string,
  ): string {
    if (!profile.stats.disabled) return t('connections.capabilities.statsOn');
    return profile.stats.queueTotals
      ? t('connections.capabilities.statsTotals')
      : t('connections.capabilities.statsOff');
  }

  protected async check(): Promise<void> {
    const parsed = ConnectionIdSchema.safeParse(this.cid());
    if (!parsed.success || this.probing()) return;
    this.probing.set(true);
    this.probeError.set(null);
    try {
      const out = await this.#service.probe(parsed.data);
      this.steps.set(out.steps);
      this.read.set(this.#ready(out.profile));
    } catch (error) {
      this.probeError.set(problemView(error));
    } finally {
      this.probing.set(false);
    }
  }

  #ready(raw: unknown): Read {
    const parsed = BrokerProfileSchema.safeParse(raw);
    return {
      kind: 'ready',
      raw,
      parsed: parsed.success ? parsed.data : null,
    };
  }
}
