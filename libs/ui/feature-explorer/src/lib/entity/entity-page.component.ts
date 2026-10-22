// The page of one entity (M1-42): a queue, an exchange, a connection or one binding, with the tabs of its kind.
// It shows the fields the inventory already carries, says in words what it knows and does not (loading, stale,
// not found, removed, failed, ended), and links to the entities it relates to. It reads the inventory only: no
// message, and no action that changes the broker. The tabs that are not built, or whose gate the engine closed,
// are listed disabled with their reason.
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import {
  entityLabel,
  isStreamRow,
  parseEntityPath,
  resolveTab,
  tabSetFor,
  type EntityRef,
  type EntityTabId,
  type EntityTabSpec,
  type ExplorerKind,
} from '@app/explorer-model';
import { GRID_CLIPBOARD } from '@app/ui-grid';
import { TranslocoDirective } from '@jsverse/transloco';

import { EXPLORER_CONNECTION } from '../connection';
import { FreshnessBanner } from '../grid/freshness-banner.component';
import {
  absoluteAddress,
  EXPLORER_NAVIGATION,
  isPlainClick,
  rowLabel,
  type NavigationTarget,
} from '../navigation';
import { ProbePrompt } from '../profile/probe-prompt.component';
import { ProfileStore } from '../profile/profile-store';
import { hintKey, problemView } from '../problem';
import type { Translate } from '../translate';
import {
  fieldLabel,
  fieldsOf,
  formatField,
  type FieldTab,
} from './entity-fields';
import { injectEntityRead } from './entity-store';
import { tabUnavailable, unavailableText } from './entity-tab-state';
import { EntityTabs, type StripTab } from './entity-tabs.component';
import { entityText } from './entity-text';

type Notice = 'copied' | 'copyFailed' | 'linkCopied' | 'linkCopyFailed';

const NOTICE_KEYS: Readonly<Record<Notice, string>> = {
  copied: 'explorer.entity.copied',
  copyFailed: 'explorer.entity.copyFailed',
  linkCopied: 'explorer.entity.linkCopied',
  linkCopyFailed: 'explorer.entity.linkCopyFailed',
};

interface FieldRow {
  readonly id: string;
  readonly label: string;
  readonly text: string;
}

const FIELD_TABS: readonly EntityTabId[] = ['overview', 'config', 'consumers'];
const OVERVIEW_TAB: EntityTabSpec = { id: 'overview', built: true, gate: null };

@Component({
  selector: 'app-entity-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EntityTabs, FreshnessBanner, ProbePrompt, TranslocoDirective],
  providers: [ProfileStore],
  template: `
    <ng-container *transloco="let t">
      @if (connection(); as cid) {
        <article class="entity" aria-labelledby="entity-title">
          @if (address(); as a) {
            <nav
              class="crumbs"
              [attr.aria-label]="t('explorer.breadcrumb.label')"
            >
              <ol>
                <li>
                  <a
                    [attr.href]="href(cid, { page: 'overview' })"
                    (click)="
                      goPage(
                        $event,
                        cid,
                        'overview',
                        t('explorer.overview.title')
                      )
                    "
                    >{{ t('explorer.breadcrumb.explorer') }}</a
                  >
                </li>
                <li>
                  <a
                    [attr.href]="href(cid, listTarget(a.vhost))"
                    (click)="
                      goPage(
                        $event,
                        cid,
                        kind(),
                        t('explorer.kinds.' + kind()),
                        a.vhost
                      )
                    "
                    >{{ t('explorer.kinds.' + kind()) }}</a
                  >
                </li>
                @if (a.vhost !== '') {
                  <li class="vhost">
                    {{ t('explorer.breadcrumb.vhost', { vhost: a.vhost }) }}
                  </li>
                }
                <li aria-current="page">{{ label() }}</li>
              </ol>
            </nav>
            <header class="head">
              <h1 id="entity-title">{{ label() }}</h1>
              <span class="kind">{{ t(kindKey()) }}</span>
            </header>
            @if (needsProbe(); as need) {
              <section class="not-probed" aria-labelledby="not-probed-title">
                <h2 id="not-probed-title">{{ t('explorer.probe.title') }}</h2>
                <app-probe-prompt [need]="need" />
              </section>
            } @else {
              @if (row()) {
                <div class="actions">
                  <button type="button" (click)="copyText(t)">
                    {{ t('explorer.entity.copyText') }}
                  </button>
                  <button type="button" (click)="copyLink()">
                    {{ t('explorer.entity.copyLink') }}
                  </button>
                  <button type="button" (click)="read.refresh()">
                    {{ t('explorer.entity.refresh') }}
                  </button>
                </div>
              }
              @if (notice(); as shown) {
                <p class="notice" role="status">{{ t(noticeKey(shown)) }}</p>
              }
              <app-freshness-banner
                [kind]="kind()"
                [freshness]="state()?.freshness ?? null"
                [state]="null"
              />
              <div class="state" role="status">
                @switch (phase()) {
                  @case ('loading') {
                    <p>
                      {{
                        t('explorer.entity.loading', {
                          noun: t(nounKey()),
                          name: label(),
                        })
                      }}
                    </p>
                  }
                  @case ('missing') {
                    <p>
                      {{
                        t(
                          state()?.certain
                            ? 'explorer.entity.missing.certain'
                            : 'explorer.entity.missing.uncertain',
                          { noun: t(nounKey()), name: label(), vhost: a.vhost }
                        )
                      }}
                    </p>
                  }
                  @case ('vanished') {
                    <p class="warn">
                      {{
                        t('explorer.entity.vanished', { noun: t(nounKey()) })
                      }}
                    </p>
                  }
                }
                @if (state(); as s) {
                  @if (s.live === 'ended' && s.row) {
                    <p class="warn">
                      {{
                        t('explorer.entity.liveEnded', { noun: t(nounKey()) })
                      }}
                      @if (problem(s.problem); as ended) {
                        <span class="problem">{{ ended.title }}</span>
                        @if (ended.detail) {
                          <span class="problem">{{ ended.detail }}</span>
                        }
                      }
                    </p>
                  }
                }
              </div>
              @if (phase() === 'error') {
                <div class="failure" role="alert">
                  <p>
                    {{ t('explorer.entity.failed', { noun: t(nounKey()) }) }}
                  </p>
                  @if (problem(state()?.problem); as failure) {
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
                  <button type="button" (click)="read.retry()">
                    {{ t('explorer.entity.retry') }}
                  </button>
                </div>
              }
              @if (row()) {
                @if (tabSet().length > 1) {
                  <app-entity-tabs
                    [tabs]="strip()"
                    [selected]="current().id"
                    [label]="t('explorer.entity.tabsLabel')"
                    (chosen)="tabChange.emit($event)"
                  />
                }
                @if (unknownTab()) {
                  <p class="notice" role="status">
                    {{
                      t('explorer.entity.unknownTab', {
                        noun: t(nounKey()),
                        tab: tab() ?? '',
                      })
                    }}
                  </p>
                }
                <section
                  id="entity-panel"
                  class="panel"
                  [attr.role]="tabSet().length > 1 ? 'tabpanel' : 'region'"
                  [attr.aria-labelledby]="
                    tabSet().length > 1
                      ? 'entity-tab-' + current().id
                      : 'entity-title'
                  "
                >
                  @if (unavailable(); as why) {
                    <p class="why">{{ unavailableText(why, t) }}</p>
                  } @else {
                    <dl class="fields">
                      @for (
                        field of fieldRows(current().id, t);
                        track field.id
                      ) {
                        <dt>{{ field.label }}</dt>
                        <dd>{{ field.text }}</dd>
                      }
                    </dl>
                    @if (current().id === 'config') {
                      <p class="note">
                        {{ t('explorer.entity.notes.config') }}
                      </p>
                    }
                    @if (current().id === 'consumers') {
                      <p class="note">
                        {{ t('explorer.entity.notes.consumers') }}
                      </p>
                    }
                  }
                </section>
              }
            }
          } @else {
            <header class="head">
              <h1 id="entity-title">{{ t('explorer.kinds.' + kind()) }}</h1>
            </header>
            <p class="state" role="status">
              {{ t('explorer.entity.invalid', { noun: t(nounKey()) }) }}
            </p>
          }
        </article>
      }
    </ng-container>
  `,
  styles: `
    :host {
      display: block;
    }
    .entity {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-2);
    }
    ol {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ds-space-2);
      margin: 0;
      padding: 0;
      list-style: none;
      color: var(--ds-color-text-muted);
    }
    li + li::before {
      content: '/';
      margin-inline-end: var(--ds-space-2);
    }
    a {
      color: var(--ds-color-text-link);
    }
    .head {
      display: flex;
      align-items: baseline;
      gap: var(--ds-space-3);
    }
    h1 {
      margin: 0;
      font-size: var(--ds-font-size-lg, 1.25em);
      overflow-wrap: anywhere;
    }
    .kind {
      color: var(--ds-color-text-muted);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ds-space-2);
    }
    button {
      min-height: var(--ds-target-size);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font: inherit;
      cursor: pointer;
    }
    a:focus-visible,
    button:focus-visible,
    .panel:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    p {
      margin: 0;
    }
    .notice,
    .note,
    .why {
      color: var(--ds-color-text-muted);
    }
    .warn,
    .failure {
      padding: var(--ds-space-1) var(--ds-space-2);
      border-inline-start: 4px solid var(--ds-color-warning);
    }
    .state:empty {
      display: none;
    }
    .panel {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-2);
      padding-block: var(--ds-space-2);
    }
    dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: var(--ds-space-1) var(--ds-space-4);
      margin: 0;
    }
    dt {
      color: var(--ds-color-text-muted);
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
  `,
})
export class EntityPage {
  readonly kind = input.required<ExplorerKind>();
  /** The object key of the address. */
  readonly entityKey = input.required<string>();
  /** The tab segment of the address, or `null` (the Overview). */
  readonly tab = input<string | null>(null);
  /** A tab that can be used was chosen. */
  readonly tabChange = output<EntityTabId>();

  protected readonly connection = inject(EXPLORER_CONNECTION);
  readonly #navigation = inject(EXPLORER_NAVIGATION);
  readonly #clipboard = inject(GRID_CLIPBOARD);
  readonly #document = inject(DOCUMENT);
  readonly #profile = inject(ProfileStore);

  protected readonly address = computed(() =>
    parseEntityPath(`/${this.kind()}/${this.entityKey()}`),
  );
  readonly #ref = computed<EntityRef | null>(() => this.address()?.ref ?? null);
  protected readonly needsProbe = this.#profile.needsProbe;
  /** Nothing is read while the profile is being read (a read before the first probe can only fail). */
  readonly #enabled = computed(
    () =>
      this.#profile.state().status !== 'loading' && this.needsProbe() === null,
  );
  protected readonly read = injectEntityRead(this.#ref, this.#enabled);
  protected readonly state = this.read.state;
  protected readonly phase = computed(() => this.state()?.phase ?? 'loading');
  protected readonly row = computed(() => this.state()?.row ?? null);
  protected readonly notice = signal<Notice | null>(null);

  protected readonly label = computed(() => {
    const row = this.row();
    if (row !== null) return rowLabel(row);
    const address = this.address();
    return address === null ? '' : entityLabel(address);
  });
  /** A queue whose type is `stream` is named a stream. */
  readonly #noun = computed(() =>
    this.kind() === 'queues' && isStreamRow(this.row())
      ? 'stream'
      : this.kind(),
  );
  protected readonly nounKey = computed(
    () => `explorer.entity.noun.${this.#noun()}`,
  );
  protected readonly kindKey = computed(
    () => `explorer.entity.kind.${this.#noun()}`,
  );

  protected readonly tabSet = computed(() =>
    tabSetFor(this.kind(), this.row()),
  );
  readonly #selected = computed(() => resolveTab(this.tabSet(), this.tab()));
  /** The address names a tab this entity does not have: the Overview is shown, and the page says so. */
  protected readonly unknownTab = computed(
    () => this.tab() !== null && this.#selected() === null,
  );
  protected readonly current = computed(() => this.#selected() ?? OVERVIEW_TAB);
  protected readonly unavailable = computed(() =>
    tabUnavailable(this.current(), this.#profile.state().raw),
  );
  protected readonly strip = computed<readonly StripTab[]>(() =>
    this.tabSet().map((spec) => ({
      id: spec.id,
      unavailable: tabUnavailable(spec, this.#profile.state().raw),
    })),
  );

  protected readonly unavailableText = unavailableText;
  protected readonly problem = problemView;
  protected readonly hint = hintKey;
  protected noticeKey(notice: Notice): string {
    return NOTICE_KEYS[notice];
  }

  protected href(cid: string, target: NavigationTarget): string {
    return this.#navigation.href(cid, target);
  }

  protected listTarget(vhost: string): NavigationTarget {
    return { page: this.kind(), vhost };
  }

  /** A plain click opens the page the way the shell opens pages; any other click is the browser's. */
  protected goPage(
    event: MouseEvent,
    cid: string,
    page: 'overview' | ExplorerKind,
    label: string,
    vhost?: string,
  ): void {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    this.#navigation.open(
      cid,
      vhost === undefined ? { page } : { page, vhost },
      label,
    );
  }

  /** The fields of one tab as label and text, in the words of the page. */
  protected fieldRows(tab: EntityTabId, t: Translate): FieldRow[] {
    const row = this.row();
    if (row === null || !FIELD_TABS.includes(tab)) return [];
    return fieldsOf(this.kind(), tab as FieldTab, row).map(({ id, value }) => ({
      id,
      label: fieldLabel(id, t),
      text: formatField(id, value, t),
    }));
  }

  protected async copyText(t: Translate): Promise<void> {
    const row = this.row();
    const cid = this.connection();
    if (row === null || cid === null) return;
    const address = this.#absolute(cid);
    try {
      await this.#clipboard.writeText(entityText(this.kind(), row, address, t));
      this.notice.set('copied');
    } catch {
      this.notice.set('copyFailed');
    }
  }

  protected async copyLink(): Promise<void> {
    const cid = this.connection();
    if (cid === null) return;
    try {
      await this.#clipboard.writeText(this.#absolute(cid));
      this.notice.set('linkCopied');
    } catch {
      this.notice.set('linkCopyFailed');
    }
  }

  #absolute(cid: string): string {
    return absoluteAddress(
      this.#document,
      this.#navigation.href(cid, { kind: this.kind(), key: this.entityKey() }),
    );
  }
}
