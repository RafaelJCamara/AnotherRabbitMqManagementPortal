// The Routing tab of a queue or an exchange (M1-42, R5 and R6): the bindings that feed it and, for an exchange,
// the bindings that leave it, each name a link to the entity it names. The engine reads bindings of one vhost
// and matches text as a substring, so the panel keeps the rows that match exactly and says what it did not
// read (the scan stops at five windows of 200) and what it did not show (a list stops at 200 rows). A window
// that failed keeps the rows read before it and shows the Problem as sent.
import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import {
  DEFAULT_EXCHANGE_LABEL,
  loadRelatedBindings,
  type BindingRow,
  type RelatedBindings,
} from '@app/explorer-model';
import { encodeObjectKey } from '@app/contracts';
import { TranslocoDirective } from '@jsverse/transloco';

import { EXPLORER_CONNECTION } from '../connection';
import { EXPLORER_DATA } from '../data/explorer-data';
import { FreshnessBanner } from '../grid/freshness-banner.component';
import { hintKey, problemView } from '../problem';
import type { NavigationTarget } from '../navigation';
import { EntityLink } from './entity-link.component';

/** Where a binding's two ends and the binding itself are, as targets. */
export function bindingTargets(row: BindingRow): {
  readonly source: NavigationTarget;
  readonly destination: NavigationTarget;
  readonly binding: NavigationTarget;
} {
  return {
    source: {
      kind: 'exchanges',
      key: encodeObjectKey(row.vhost, row.source),
    },
    destination: {
      kind: row.destinationType === 'exchange' ? 'exchanges' : 'queues',
      key: encodeObjectKey(row.vhost, row.destination),
    },
    binding: { kind: 'bindings', key: row.key },
  };
}

/** The name of an exchange as a link says it: the default exchange has none. */
export const exchangeName = (name: string): string =>
  name === '' ? DEFAULT_EXCHANGE_LABEL : name;

/** A binding row with the targets of its links, made once per read (a link's input is stable). */
interface RowView {
  readonly row: BindingRow;
  readonly source: NavigationTarget;
  readonly destination: NavigationTarget;
  readonly binding: NavigationTarget;
  readonly label: string;
}

type Loaded =
  | { readonly status: 'loading' }
  | {
      readonly status: 'done';
      readonly result: RelatedBindings;
      readonly ins: readonly RowView[];
      readonly outs: readonly RowView[];
    };

const rowView = (row: BindingRow): RowView => ({
  row,
  ...bindingTargets(row),
  label: `${exchangeName(row.source)} -> ${row.destination}`,
});

const done = (result: RelatedBindings): Loaded => ({
  status: 'done',
  result,
  ins: result.bindingsIn.map(rowView),
  outs: result.bindingsOut.map(rowView),
});

@Component({
  selector: 'app-routing-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EntityLink, FreshnessBanner, TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      @if (connection(); as cid) {
        <div class="routing">
          @if (loaded(); as shown) {
            @if (shown.status === 'loading') {
              <p role="status">
                {{ t('explorer.entity.routing.loading', { vhost: vhost() }) }}
              </p>
            } @else {
              @if (shown.result.skipped) {
                <p class="note">
                  {{ t('explorer.entity.routing.defaultExchange') }}
                </p>
              } @else {
                <app-freshness-banner
                  kind="bindings"
                  [freshness]="shown.result.freshness"
                  [state]="null"
                />
                @if (shown.result.problem !== null) {
                  <div class="failure" role="alert">
                    <p>{{ t('explorer.entity.routing.failed') }}</p>
                    @if (problem(shown.result.problem); as failure) {
                      <p>
                        <span class="problem">{{ failure.title }}</span>
                        @if (failure.detail) {
                          <span class="problem">{{ failure.detail }}</span>
                        }
                      </p>
                      @if (hint(failure.code); as key) {
                        <p class="hint">{{ t(key) }}</p>
                      }
                    }
                  </div>
                }
                @if (shown.result.truncated) {
                  <p class="warn" role="status">
                    {{
                      t('explorer.entity.routing.truncated', {
                        scanned: shown.result.scanned,
                        matched: shown.result.matched ?? shown.result.scanned,
                      })
                    }}
                  </p>
                }

                <section [attr.aria-labelledby]="'routing-in'">
                  <h2 id="routing-in">
                    {{
                      t('explorer.entity.routing.in', {
                        count:
                          shown.result.bindingsIn.length + shown.result.moreIn,
                      })
                    }}
                  </h2>
                  @if (shown.result.bindingsIn.length === 0) {
                    <p class="note">
                      {{
                        t('explorer.entity.routing.noneIn', {
                          noun: t(nounKey()),
                        })
                      }}
                    </p>
                  } @else {
                    <table>
                      <caption class="sr-only">
                        {{
                          t('explorer.entity.routing.in', {
                            count:
                              shown.result.bindingsIn.length +
                              shown.result.moreIn,
                          })
                        }}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">
                            {{ t('explorer.columns.source') }}
                          </th>
                          <th scope="col">
                            {{ t('explorer.columns.routingKey') }}
                          </th>
                          <th scope="col">
                            {{ t('explorer.entity.routing.binding') }}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (item of shown.ins; track item.row.key) {
                          <tr>
                            <td>
                              <app-entity-link
                                [cid]="cid"
                                [target]="item.source"
                                [text]="exchangeName(item.row.source)"
                              />
                            </td>
                            <td>{{ routingKey(item.row, t) }}</td>
                            <td>
                              <app-entity-link
                                [cid]="cid"
                                [target]="item.binding"
                                [text]="t('explorer.entity.routing.open')"
                                [tabLabel]="item.label"
                                [accessibleName]="
                                  t('explorer.entity.routing.openNamed', {
                                    name: item.label,
                                  })
                                "
                              />
                            </td>
                          </tr>
                        }
                      </tbody>
                    </table>
                    @if (shown.result.moreIn > 0) {
                      <p class="note">
                        {{
                          t('explorer.entity.routing.more', {
                            count: shown.result.moreIn,
                          })
                        }}
                      </p>
                    }
                  }
                </section>

                @if (kind() === 'exchanges') {
                  <section [attr.aria-labelledby]="'routing-out'">
                    <h2 id="routing-out">
                      {{
                        t('explorer.entity.routing.out', {
                          count:
                            shown.result.bindingsOut.length +
                            shown.result.moreOut,
                        })
                      }}
                    </h2>
                    @if (shown.result.bindingsOut.length === 0) {
                      <p class="note">
                        {{ t('explorer.entity.routing.noneOut') }}
                      </p>
                    } @else {
                      <table>
                        <caption class="sr-only">
                          {{
                            t('explorer.entity.routing.out', {
                              count:
                                shown.result.bindingsOut.length +
                                shown.result.moreOut,
                            })
                          }}
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col">
                              {{ t('explorer.columns.destination') }}
                            </th>
                            <th scope="col">
                              {{ t('explorer.columns.destinationType') }}
                            </th>
                            <th scope="col">
                              {{ t('explorer.columns.routingKey') }}
                            </th>
                            <th scope="col">
                              {{ t('explorer.entity.routing.binding') }}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (item of shown.outs; track item.row.key) {
                            <tr>
                              <td>
                                <app-entity-link
                                  [cid]="cid"
                                  [target]="item.destination"
                                  [text]="item.row.destination"
                                />
                              </td>
                              <td>{{ item.row.destinationType }}</td>
                              <td>{{ routingKey(item.row, t) }}</td>
                              <td>
                                <app-entity-link
                                  [cid]="cid"
                                  [target]="item.binding"
                                  [text]="t('explorer.entity.routing.open')"
                                  [tabLabel]="item.label"
                                  [accessibleName]="
                                    t('explorer.entity.routing.openNamed', {
                                      name: item.label,
                                    })
                                  "
                                />
                              </td>
                            </tr>
                          }
                        </tbody>
                      </table>
                      @if (shown.result.moreOut > 0) {
                        <p class="note">
                          {{
                            t('explorer.entity.routing.more', {
                              count: shown.result.moreOut,
                            })
                          }}
                        </p>
                      }
                    }
                  </section>
                }
                <button type="button" class="reload" (click)="reload()">
                  {{ t('explorer.entity.routing.reload') }}
                </button>
              }
            }
          }
        </div>
      }
    </ng-container>
  `,
  styles: `
    :host {
      display: block;
    }
    .routing {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-3);
    }
    h2 {
      margin: 0 0 var(--ds-space-1);
      font-size: var(--ds-font-size-md, 1.05em);
    }
    p {
      margin: 0;
    }
    .note {
      color: var(--ds-color-text-muted);
    }
    .warn,
    .failure {
      padding: var(--ds-space-1) var(--ds-space-2);
      border-inline-start: 4px solid var(--ds-color-warning);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th,
    td {
      padding: var(--ds-space-1) var(--ds-space-2);
      text-align: start;
      border-block-end: 1px solid var(--ds-color-border);
      overflow-wrap: anywhere;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .reload {
      align-self: start;
      min-height: var(--ds-target-size);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font: inherit;
      cursor: pointer;
    }
    .reload:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
  `,
})
export class RoutingPanel {
  readonly kind = input.required<'queues' | 'exchanges'>();
  readonly vhost = input.required<string>();
  readonly name = input.required<string>();

  protected readonly connection = inject(EXPLORER_CONNECTION);
  readonly #data = inject(EXPLORER_DATA);
  protected readonly loaded = signal<Loaded | null>(null);
  readonly #attempt = signal(0);

  protected readonly problem = problemView;
  protected readonly hint = hintKey;
  protected readonly exchangeName = exchangeName;

  constructor() {
    effect((onCleanup) => {
      const cid = this.connection();
      const kind = this.kind();
      const vhost = this.vhost();
      const name = this.name();
      this.#attempt();
      if (cid === null) {
        this.loaded.set(null);
        return;
      }
      const controller = new AbortController();
      onCleanup(() => {
        controller.abort();
      });
      untracked(() => {
        this.loaded.set({ status: 'loading' });
        loadRelatedBindings(
          this.#data,
          { cid, vhost, name, as: kind === 'queues' ? 'queue' : 'exchange' },
          controller.signal,
        ).then(
          (result) => {
            if (!controller.signal.aborted) {
              this.loaded.set(done(result));
            }
          },
          (error: unknown) => {
            if (controller.signal.aborted) return;
            this.loaded.set(
              done({
                bindingsIn: [],
                bindingsOut: [],
                moreIn: 0,
                moreOut: 0,
                scanned: 0,
                matched: null,
                truncated: false,
                freshness: null,
                problem: error,
                skipped: null,
              }),
            );
          },
        );
      });
    });
  }

  protected nounKey(): string {
    return this.kind() === 'queues'
      ? 'explorer.entity.noun.queues'
      : 'explorer.entity.noun.exchanges';
  }

  /** An empty routing key is a key, not a missing one. */
  protected routingKey(row: BindingRow, t: (key: string) => string): string {
    if (row.routingKey === undefined) return t('explorer.cell.notReported');
    return row.routingKey === '' ? t('explorer.entity.empty') : row.routingKey;
  }

  protected reload(): void {
    this.#attempt.update((n) => n + 1);
  }
}
