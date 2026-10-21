// The saved-views control of an inventory page (M0-54, R8, R13): a disclosure that lists the person's views
// of this kind, applies one, saves the current filters and columns under a name, replaces one (create, then
// delete) and deletes one after an inline confirmation. Save and Delete are `<app-gated>`: closed, with a
// stated reason, unless the engine's `allowedActions` names the command. What a view names and this kind
// cannot apply is listed, never applied silently; an engine refusal is shown as it was sent, and the
// filters and columns in force stay as they are.
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  VIEW_DEFINITION_MAX_CHARS,
  type GateDecision,
  type SavedView,
} from '@app/contracts';
import {
  parseViewDefinition,
  serializeView,
  type ExplorerKind,
  type ExplorerViewDefinition,
  type ParsedView,
} from '@app/explorer-model';
import { Gated, type GatedLabels } from '@app/ui-design';
import { TranslocoDirective } from '@jsverse/transloco';

import { problemView, type ProblemView } from '../problem';
import { ProfileStore, type ProfileState } from '../profile/profile-store';
import type { Translate } from '../translate';
import { gateFor, type ViewCommand } from './allowed';
import { ViewsStore } from './views-store';

export interface ViewApplied {
  /** The view applied, or `null` when the address named a view that could not be applied. */
  readonly id: string | null;
  readonly parsed: ParsedView | null;
}

interface Notice {
  readonly id: string;
  readonly tone: 'warn' | 'info';
  readonly key: string;
  readonly params?: Record<string, string | number>;
  readonly problem?: ProblemView;
}

let nextControl = 0;

@Component({
  selector: 'app-views-control',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Gated, TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      <div class="views">
        <button
          #toggle
          type="button"
          class="views-toggle"
          [attr.aria-expanded]="open()"
          [attr.aria-controls]="panelId"
          (click)="open.set(!open())"
        >
          {{ t('explorer.views.button') }}
        </button>
        @if (open()) {
          <div
            class="panel"
            role="group"
            [id]="panelId"
            [attr.aria-label]="t('explorer.views.title')"
            (keydown.escape)="close()"
          >
            @if (store.status() === 'loading') {
              <p class="hint" role="status">
                {{ t('explorer.views.loading') }}
              </p>
            }
            @if (store.truncated()) {
              <p class="hint">{{ t('explorer.views.truncated') }}</p>
            }
            @if (store.views().length === 0 && store.status() === 'ready') {
              <p class="hint">{{ t('explorer.views.empty') }}</p>
            }
            <ul class="list" [attr.aria-label]="t('explorer.views.list')">
              @for (view of store.views(); track view.id) {
                <li class="item">
                  <button
                    type="button"
                    class="apply"
                    [attr.aria-current]="view.id === viewId() ? 'true' : null"
                    (click)="apply(view)"
                  >
                    {{ view.name }}
                  </button>
                  <button
                    type="button"
                    class="replace-ask"
                    [attr.aria-label]="
                      t('explorer.views.replaceNamed', { name: view.name })
                    "
                    (click)="ask(view.id, 'replace')"
                  >
                    {{ t('explorer.views.replace') }}
                  </button>
                  <button
                    type="button"
                    class="delete-ask"
                    [attr.aria-label]="
                      t('explorer.views.deleteNamed', { name: view.name })
                    "
                    (click)="ask(view.id, 'delete')"
                  >
                    {{ t('explorer.views.delete') }}
                  </button>
                  @if (confirming(); as asking) {
                    @if (asking.id === view.id) {
                      <div
                        class="confirm"
                        role="group"
                        [attr.aria-label]="t('explorer.views.confirm')"
                      >
                        <span>{{
                          t(
                            asking.mode === 'delete'
                              ? 'explorer.views.confirmDelete'
                              : 'explorer.views.confirmReplace',
                            { name: view.name }
                          )
                        }}</span>
                        <app-gated
                          [gate]="
                            asking.mode === 'delete'
                              ? gate(t, ['views.delete'])
                              : gate(t, ['views.create', 'views.delete'])
                          "
                          [labels]="gatedLabels(t)"
                          (activated)="confirm(view)"
                        >
                          {{ t('explorer.views.confirmYes') }}
                        </app-gated>
                        <button type="button" class="cancel" (click)="cancel()">
                          {{ t('explorer.views.cancel') }}
                        </button>
                      </div>
                    }
                  }
                </li>
              }
            </ul>
            <form class="save" (submit)="$event.preventDefault()">
              <label>
                <span>{{ t('explorer.views.name') }}</span>
                <input
                  #name
                  type="text"
                  class="name-input"
                  maxlength="80"
                  (keydown.enter)="onEnter($event, name.value, t)"
                />
              </label>
              <app-gated
                [gate]="gate(t, ['views.create'])"
                [labels]="gatedLabels(t)"
                (activated)="save(name)"
              >
                {{ t('explorer.views.save') }}
              </app-gated>
            </form>
          </div>
        }
        @if (notices().length > 0) {
          <ul class="notices" role="status" aria-live="polite">
            @for (notice of notices(); track notice.id) {
              <li class="notice" [class.warn]="notice.tone === 'warn'">
                {{ t(notice.key, notice.params) }}
                @if (notice.problem; as problem) {
                  <span class="problem">{{ problem.title }}</span
                  >&ngsp;
                  @if (problem.detail) {
                    <span class="problem">{{ problem.detail }}</span>
                  }
                }
              </li>
            }
          </ul>
        }
      </div>
    </ng-container>
  `,
  styles: `
    .views {
      position: relative;
      display: inline-flex;
      flex-direction: column;
      gap: var(--ds-space-1);
    }
    .views-toggle,
    .apply,
    .replace-ask,
    .delete-ask,
    .cancel {
      min-height: var(--ds-target-size);
      padding: 0 var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font: inherit;
      cursor: pointer;
    }
    button:focus-visible,
    input:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    .panel {
      position: absolute;
      top: 100%;
      z-index: 6;
      min-width: 22rem;
      max-height: 60vh;
      overflow: auto;
      padding: var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface-raised);
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-2);
    }
    .list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-2);
    }
    .item,
    .confirm,
    .save {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--ds-space-2);
    }
    .hint,
    .notice {
      margin: 0;
      color: var(--ds-color-text-muted);
    }
    .notices {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .notice.warn {
      border-inline-start: 3px solid var(--ds-color-text-danger);
      padding-inline-start: var(--ds-space-2);
    }
    .problem {
      margin-inline-start: var(--ds-space-2);
    }
  `,
})
export class ViewsControl {
  readonly kind = input.required<ExplorerKind>();
  /** What a save would store: the filter and the columns in force. */
  readonly current = input.required<ExplorerViewDefinition>();
  /** The view named in the address (`?view=`), applied once the list is read. */
  readonly viewId = input<string | null>(null);
  readonly applied = output<ViewApplied>();

  protected readonly store = inject(ViewsStore);
  readonly #profile = inject(ProfileStore);
  readonly #injector = inject(Injector);
  private readonly toggle =
    viewChild.required<ElementRef<HTMLButtonElement>>('toggle');

  protected readonly open = signal(false);
  protected readonly notices = signal<readonly Notice[]>([]);
  protected readonly confirming = signal<{
    readonly id: string;
    readonly mode: 'delete' | 'replace';
  } | null>(null);
  protected readonly panelId = `app-views-panel-${String(nextControl++)}`;
  #resolved: string | null = null;

  constructor() {
    // The list of this kind, read when the page opens and when the kind changes.
    effect(() => {
      const kind = this.kind();
      untracked(() => {
        void this.store.load(kind);
      });
    });
    // A view named in the address is applied once the list is in (or said not to be there).
    effect(() => {
      const id = this.viewId();
      const status = this.store.status();
      if (id === null || (status !== 'ready' && status !== 'error')) return;
      untracked(() => {
        this.#resolve(id, status);
      });
    });
  }

  // The template reads these on every pass: the same object comes back until the profile or the
  // translate function changes, or Angular would see a new input value each time.
  readonly #gates = new Map<
    string,
    { t: Translate; state: ProfileState; gate: GateDecision }
  >();
  #labels: { t: Translate; labels: GatedLabels } | null = null;

  protected gate(t: Translate, commands: readonly ViewCommand[]): GateDecision {
    const state = this.#profile.state();
    const key = commands.join('+');
    const kept = this.#gates.get(key);
    if (kept?.t === t && kept.state === state) return kept.gate;
    const gate = gateFor(commands, state, t);
    this.#gates.set(key, { t, state, gate });
    return gate;
  }

  protected gatedLabels(t: Translate): GatedLabels {
    if (this.#labels?.t !== t) {
      this.#labels = {
        t,
        labels: {
          whyDisabled: t('explorer.views.gate.whyDisabled'),
          degraded: t('explorer.views.gate.degraded'),
          source: t('explorer.views.gate.source'),
          noReason: t('explorer.views.gate.noReason'),
        },
      };
    }
    return this.#labels.labels;
  }

  #resolve(id: string, status: 'ready' | 'error'): void {
    if (this.#resolved === id) return;
    this.#resolved = id;
    const view = this.store.views().find((v) => v.id === id);
    if (status === 'error') {
      this.#notify([
        {
          id: 'list',
          tone: 'warn',
          key: 'explorer.views.listFailed',
          problem: problemView(this.store.error()),
        },
      ]);
      this.applied.emit({ id: null, parsed: null });
    } else if (view === undefined) {
      this.#notify([
        { id: 'missing', tone: 'warn', key: 'explorer.views.notFound' },
      ]);
      this.applied.emit({ id: null, parsed: null });
    } else {
      this.#applyView(view);
    }
  }

  protected apply(view: SavedView): void {
    this.#resolved = view.id;
    this.#applyView(view);
    this.open.set(false);
    // Focus goes back to the button that opened the list.
    afterNextRender(
      () => {
        this.toggle().nativeElement.focus();
      },
      { injector: this.#injector },
    );
  }

  #applyView(view: SavedView): void {
    const parsed = parseViewDefinition(view.definition, this.kind());
    const notices: Notice[] = [];
    if (parsed.appliesNothing) {
      notices.push({
        id: 'nothing',
        tone: 'warn',
        key: 'explorer.views.nothingApplied',
      });
    }
    parsed.dropped.forEach((drop, index) => {
      notices.push({
        id: `drop:${String(index)}`,
        tone: 'warn',
        key: `explorer.views.drop.${drop.what}`,
        params: { detail: drop.detail ?? '' },
      });
    });
    this.#notify(notices);
    this.applied.emit({ id: view.id, parsed });
  }

  protected close(): void {
    this.open.set(false);
    this.toggle().nativeElement.focus();
  }

  protected ask(id: string, mode: 'delete' | 'replace'): void {
    this.confirming.set({ id, mode });
  }

  protected cancel(): void {
    this.confirming.set(null);
  }

  protected onEnter(event: Event, value: string, t: Translate): void {
    event.preventDefault();
    // Enter saves only when the gate is open, exactly as the button does.
    if (this.gate(t, ['views.create']).enabled) void this.#save(value);
  }

  protected save(field: HTMLInputElement): void {
    void this.#save(field.value).then((saved) => {
      if (saved) field.value = '';
    });
  }

  async #save(raw: string): Promise<boolean> {
    const name = raw.trim();
    if (name === '') return false;
    const serialized = serializeView(this.current());
    if (!serialized.ok) {
      this.#notify([
        {
          id: 'size',
          tone: 'warn',
          key: 'explorer.views.tooLarge',
          params: { max: VIEW_DEFINITION_MAX_CHARS },
        },
      ]);
      return false;
    }
    const saved = await this.store.create(
      name,
      this.kind(),
      serialized.definition,
    );
    this.#notify(
      saved
        ? [{ id: 'saved', tone: 'info', key: 'explorer.views.saved' }]
        : [
            {
              id: 'save',
              tone: 'warn',
              key: 'explorer.views.saveFailed',
              problem: problemView(this.store.error()),
            },
          ],
    );
    return saved;
  }

  protected async confirm(view: SavedView): Promise<void> {
    const asking = this.confirming();
    if (asking?.id !== view.id) return;
    this.confirming.set(null);
    if (asking.mode === 'delete') {
      const deleted = await this.store.remove(view.id, this.kind());
      this.#notify(
        deleted
          ? [{ id: 'deleted', tone: 'info', key: 'explorer.views.deleted' }]
          : [
              {
                id: 'delete',
                tone: 'warn',
                key: 'explorer.views.deleteFailed',
                problem: problemView(this.store.error()),
              },
            ],
      );
      return;
    }
    const serialized = serializeView(this.current());
    if (!serialized.ok) {
      this.#notify([
        {
          id: 'size',
          tone: 'warn',
          key: 'explorer.views.tooLarge',
          params: { max: VIEW_DEFINITION_MAX_CHARS },
        },
      ]);
      return;
    }
    const outcome = await this.store.replace(
      view.id,
      view.name,
      this.kind(),
      serialized.definition,
    );
    if (outcome === 'replaced') {
      this.#notify([
        { id: 'replaced', tone: 'info', key: 'explorer.views.replaced' },
      ]);
    } else {
      this.#notify([
        {
          id: 'replace',
          tone: 'warn',
          key:
            outcome === 'failed'
              ? 'explorer.views.saveFailed'
              : 'explorer.views.replaceHalf',
          problem: problemView(this.store.error()),
        },
      ]);
    }
  }

  #notify(notices: readonly Notice[]): void {
    this.notices.set(notices);
  }
}
