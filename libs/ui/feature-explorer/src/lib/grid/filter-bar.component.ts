// The filter bar of an explorer page (M0-54, R5): a search form with the name text and the facets of
// the kind, and the active filters as removable chips. A change of the text applies after 200 ms
// without typing or at once on Enter; any other change applies at once. What it emits is the
// contract's filter, with only the facets that apply to the kind; no pattern is ever interpreted.
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import {
  FILTER_CAPS,
  FILTER_DEBOUNCE_MS,
  facetApplies,
  sanitizeFilter,
  type ExplorerFilter,
  type ExplorerKind,
} from '@app/explorer-model';
import { TranslocoDirective } from '@jsverse/transloco';

import type { Translate } from '../translate';
import { EXPLORER_TIMER } from '../timer';
import { FacetPicker } from './facet-picker.component';
import {
  capOf,
  filterChips,
  LIST_FACETS,
  suggestionsOf,
  withConsumers,
  withMinMessages,
  withoutValue,
  withText,
  withValue,
  type EditRefusal,
  type FilterChip,
  type ListFacet,
} from './filter-model';

@Component({
  selector: 'app-filter-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FacetPicker, TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      <form
        class="bar"
        role="search"
        [attr.aria-label]="t('explorer.filters.label')"
        (submit)="$event.preventDefault()"
      >
        <label class="text">
          <span>{{
            t(
              kind() === 'bindings'
                ? 'explorer.filters.textBindings'
                : 'explorer.filters.text'
            )
          }}</span>
          <input
            #text
            type="text"
            class="text-input"
            [attr.maxlength]="textMax"
            [attr.placeholder]="t('explorer.filters.textPlaceholder')"
            [value]="draft()"
            (input)="onInput($event)"
            (keydown.enter)="applyNow($event)"
          />
        </label>
        @if (kind() === 'bindings') {
          <label class="vhost">
            <span>{{ t('explorer.filters.vhostChoose') }}</span>
            <input
              #vhostField
              type="text"
              class="vhost-input"
              maxlength="255"
              [value]="vhost() ?? ''"
              (keydown.enter)="chooseVhost($event, vhostField.value)"
            />
          </label>
          <button
            type="button"
            class="vhost-open"
            (click)="vhostChange.emit(vhostField.value)"
          >
            {{ t('explorer.filters.vhostOpen') }}
          </button>
        }
        @for (facet of facets(); track facet) {
          <app-facet-picker
            [label]="
              t(
                facet === 'types'
                  ? 'explorer.filters.facet.types.' + kind()
                  : 'explorer.filters.facet.' + facet
              )
            "
            [options]="suggestions(facet)"
            [selected]="filter()[facet] ?? []"
            [addLabel]="t('explorer.filters.addLabel')"
            [addButton]="t('explorer.filters.addButton')"
            [reason]="
              refusal() === facet
                ? t('explorer.filters.limit.' + facet, { max: cap(facet) })
                : null
            "
            (add)="onAdd(facet, $event)"
            (remove)="onRemove(facet, $event)"
          />
        }
        @if (consumers()) {
          <label class="consumers">
            <span>{{ t('explorer.filters.consumers.label') }}</span>
            <select (change)="onConsumers($event)">
              <option
                value="any"
                [selected]="filter().hasConsumers === undefined"
              >
                {{ t('explorer.filters.consumers.any') }}
              </option>
              <option value="yes" [selected]="filter().hasConsumers === true">
                {{ t('explorer.filters.consumers.yes') }}
              </option>
              <option value="no" [selected]="filter().hasConsumers === false">
                {{ t('explorer.filters.consumers.no') }}
              </option>
            </select>
          </label>
          <label class="min">
            <span>{{ t('explorer.filters.minMessages') }}</span>
            <input
              type="number"
              min="0"
              step="1"
              [value]="filter().minMessages ?? ''"
              (change)="onMin($event)"
            />
          </label>
        }
        @if (refusal() === 'text') {
          <p class="reason" role="status">
            {{ t('explorer.filters.limit.text', { max: textMax }) }}
          </p>
        }
      </form>
      @if (chipsOf(t); as chips) {
        @if (chips.length > 0) {
          <ul class="chips" [attr.aria-label]="t('explorer.filters.chips')">
            @for (chip of chips; track chip.id; let i = $index) {
              <li class="chip">
                <span>{{ chip.text }}</span>
                <button
                  type="button"
                  class="chip-remove"
                  [attr.aria-label]="
                    t('explorer.filters.remove', { filter: chip.text })
                  "
                  (click)="removeChip(chip, i)"
                >
                  {{ t('explorer.filters.removeMark') }}
                </button>
              </li>
            }
          </ul>
        }
      }
    </ng-container>
  `,
  styles: `
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: var(--ds-space-3);
      padding: var(--ds-space-2) var(--ds-space-3);
    }
    label {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-1);
      font-size: var(--ds-font-size);
    }
    input,
    select,
    .vhost-open,
    .chip-remove {
      min-height: var(--ds-target-size);
      font: inherit;
      color: var(--ds-color-text);
      background: var(--ds-color-surface);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
    }
    input:focus-visible,
    select:focus-visible,
    button:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ds-space-2);
      margin: 0;
      padding: 0 var(--ds-space-3) var(--ds-space-2);
      list-style: none;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: var(--ds-space-1);
      padding-inline-start: var(--ds-space-2);
      border: 1px solid var(--ds-color-border);
      border-radius: var(--ds-radius);
    }
    .reason {
      margin: 0;
      color: var(--ds-color-text-danger);
    }
  `,
})
export class FilterBar {
  readonly kind = input.required<ExplorerKind>();
  /** The filter in force (what the engine is asked); the bar edits copies of it. */
  readonly filter = input.required<ExplorerFilter>();
  /** The vhost of a bindings page, which the engine requires. */
  readonly vhost = input<string | null>(null);
  readonly filterChange = output<ExplorerFilter>();
  readonly vhostChange = output<string>();

  protected readonly textMax = FILTER_CAPS.text;
  /** What is typed in the text field, before it applies. */
  protected readonly draft = signal('');
  protected readonly refusal = signal<EditRefusal | null>(null);

  readonly #timer = inject(EXPLORER_TIMER);
  readonly #host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly #injector = inject(Injector);
  #cancel: (() => void) | null = null;
  #chips: {
    t: Translate;
    kind: ExplorerKind;
    filter: ExplorerFilter;
    chips: FilterChip[];
  } | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.#cancel?.(); // a pause that was running does not apply a filter to a page that is gone
    });
    // A filter that changed from outside (a chip, a saved view) replaces what was typed.
    effect(() => {
      const text = this.filter().text ?? '';
      untracked(() => {
        this.#cancel?.();
        this.#cancel = null;
        this.draft.set(text);
      });
    });
  }

  /** Puts focus on the name text field, for a command (M1-41). */
  focus(): void {
    this.#host.nativeElement
      .querySelector<HTMLInputElement>('.text-input')
      ?.focus();
  }

  /** The list facets of the kind; the vhost of a bindings page is chosen apart, not filtered. */
  protected facets(): readonly ListFacet[] {
    const kind = this.kind();
    return LIST_FACETS.filter(
      (facet) =>
        facetApplies(kind, facet) &&
        !(kind === 'bindings' && facet === 'vhosts'),
    );
  }

  protected consumers(): boolean {
    return facetApplies(this.kind(), 'hasConsumers');
  }

  protected suggestions(facet: ListFacet): string[] {
    return suggestionsOf(this.kind(), facet);
  }

  protected cap(facet: ListFacet): number {
    return capOf(facet);
  }

  protected chipsOf(t: Translate): FilterChip[] {
    const kind = this.kind();
    const filter = this.filter();
    if (
      this.#chips?.t !== t ||
      this.#chips.kind !== kind ||
      this.#chips.filter !== filter
    ) {
      this.#chips = { t, kind, filter, chips: filterChips(kind, filter, t) };
    }
    return this.#chips.chips;
  }

  protected onInput(event: Event): void {
    const value =
      event.target instanceof HTMLInputElement ? event.target.value : '';
    this.#cancel?.();
    if (value.length > FILTER_CAPS.text) {
      this.refusal.set('text');
      this.draft.set(value.slice(0, FILTER_CAPS.text));
    } else {
      this.refusal.set(null);
      this.draft.set(value);
    }
    this.#cancel = this.#timer.set(() => {
      this.#cancel = null;
      this.#applyText();
    }, FILTER_DEBOUNCE_MS);
  }

  protected applyNow(event: Event): void {
    event.preventDefault();
    this.#cancel?.();
    this.#cancel = null;
    this.#applyText();
  }

  #applyText(): void {
    const edit = withText(this.filter(), this.draft());
    this.#emit(edit.filter);
  }

  protected onAdd(facet: ListFacet, value: string): void {
    const edit = withValue(this.filter(), facet, value);
    this.refusal.set(edit.refused ?? null);
    if (edit.refused === undefined) this.#emit(edit.filter);
  }

  protected onRemove(facet: ListFacet, value: string): void {
    this.refusal.set(null);
    this.#emit(withoutValue(this.filter(), facet, value));
  }

  protected onConsumers(event: Event): void {
    const value =
      event.target instanceof HTMLSelectElement ? event.target.value : 'any';
    this.#emit(
      withConsumers(
        this.filter(),
        value === 'yes' || value === 'no' ? value : 'any',
      ),
    );
  }

  protected onMin(event: Event): void {
    const raw =
      event.target instanceof HTMLInputElement ? event.target.value : '';
    this.#emit(withMinMessages(this.filter(), raw === '' ? null : Number(raw)));
  }

  protected chooseVhost(event: Event, value: string): void {
    event.preventDefault();
    this.vhostChange.emit(value);
  }

  protected removeChip(chip: FilterChip, index: number): void {
    this.refusal.set(null);
    this.#emit(chip.without);
    // Focus goes to the chip that took this one's place, else the one before it, else the text field.
    afterNextRender(
      () => {
        const buttons =
          this.#host.nativeElement.querySelectorAll<HTMLElement>(
            '.chip-remove',
          );
        (
          buttons[index] ??
          buttons[index - 1] ??
          this.#host.nativeElement.querySelector<HTMLElement>('.text-input')
        )?.focus();
      },
      { injector: this.#injector },
    );
  }

  /** Emits the filter once, as the contract's, and only when it differs from the one in force. */
  #emit(next: ExplorerFilter): void {
    const kind = this.kind();
    const clean = sanitizeFilter(kind, next);
    if (
      JSON.stringify(clean) ===
      JSON.stringify(sanitizeFilter(kind, this.filter()))
    ) {
      return;
    }
    this.filterChange.emit(clean);
  }
}
