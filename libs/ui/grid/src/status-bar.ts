// The grid's status bar (AC-13). AG Grid's is Enterprise. It tells the state in words, in a polite
// live region: the total (an unknown total is said to be unknown, never 0), the rows loaded and
// selected, a block loading or failed (with a retry), and what a copy or the selection cap left out
// (I-13: nothing is lost silently). Every word comes from `labels`.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';

import type { CopyOutcome } from './clipboard';

/**
 * The words of the status bar, already translated. `{count}` and `{omitted}` mark where a number goes.
 */
export interface GridStatusLabels {
  /** Known total, for example "{count} rows". */
  readonly total: string;
  /** The total is not known yet; never shown as 0. */
  readonly totalUnknown: string;
  /** Rows in the cache, for example "{count} loaded". */
  readonly loaded: string;
  /** For example "{count} selected". */
  readonly selected: string;
  /** A block is loading. */
  readonly loading: string;
  /** A block could not be loaded. */
  readonly error: string;
  /** The button that loads it again. */
  readonly retry: string;
  /** For example "{count} rows copied". */
  readonly copied: string;
  /** For example "{count} rows copied, {omitted} not copied". */
  readonly copyTruncated: string;
  /** The clipboard refused the text. */
  readonly copyFailed: string;
  /** For example "At most {count} rows can be selected". */
  readonly selectionCapped: string;
  /** For example "{count} live changes were not applied". */
  readonly dropped: string;
}

/** Puts numbers into a label: `fillLabel('{count} rows', { count: 3 })` is `3 rows`. */
export function fillLabel(
  template: string,
  values: Readonly<Record<string, number | string>>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

@Component({
  selector: 'app-grid-status-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar">
      <span class="live" role="status" aria-live="polite">
        <!-- A space between the parts, so a screen reader does not read them as one word. -->
        <span class="part total">{{ totalText() }}</span
        >&ngsp; <span class="part loaded">{{ loadedText() }}</span
        >&ngsp; <span class="part selected">{{ selectedText() }}</span
        >&ngsp;
        @if (loading()) {
          <span class="part loading">{{ labels().loading }}</span
          >&ngsp;
        }
        @if (failed()) {
          <span class="part problem error">{{ labels().error }}</span
          >&ngsp;
        }
        @if (copyText(); as copy) {
          <span class="part copy" [class.problem]="copy.problem">{{
            copy.text
          }}</span
          >&ngsp;
        }
        @if (capped()) {
          <span class="part problem capped">{{ cappedText() }}</span
          >&ngsp;
        }
        @if (dropped() > 0) {
          <span class="part dropped">{{ droppedText() }}</span
          >&ngsp;
        }
      </span>
      @if (failed()) {
        <button type="button" class="retry" (click)="retry.emit()">
          {{ labels().retry }}
        </button>
      }
    </div>
  `,
  styles: `
    .bar {
      display: flex;
      align-items: center;
      gap: var(--ds-space-3);
      min-height: var(--ds-target-size);
      padding: 0 var(--ds-space-3);
      border-top: 1px solid var(--ds-color-border);
      background: var(--ds-color-surface-raised);
      color: var(--ds-color-text);
      font-size: var(--ds-font-size);
    }
    .part + .part {
      margin-inline-start: var(--ds-space-3);
    }
    .problem {
      color: var(--ds-color-text-danger);
      font-weight: 600;
    }
    .retry {
      min-height: var(--ds-target-size);
      padding: 0 var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font: inherit;
      cursor: pointer;
    }
    .retry:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
  `,
})
export class GridStatusBar {
  readonly labels = input.required<GridStatusLabels>();
  /** `null` until the source says; shown as unknown, never as 0. */
  readonly total = input.required<number | null>();
  /** Rows in the cache. */
  readonly loaded = input.required<number>();
  readonly selected = input.required<number>();
  readonly loading = input.required<boolean>();
  /** A block failed and has not been retried. */
  readonly failed = input.required<boolean>();
  /** The last copy, if any. */
  readonly copy = input<CopyOutcome | null>(null);
  /** The selection cap stopped an addition. */
  readonly capped = input(false);
  readonly selectionCap = input(0);
  /** Live changes dropped because their rows are not shown. */
  readonly dropped = input(0);
  /** The user asks to load the failed block again. */
  readonly retry = output();

  protected readonly totalText = computed(() => {
    const total = this.total();
    return total === null
      ? this.labels().totalUnknown
      : fillLabel(this.labels().total, { count: total });
  });
  protected readonly loadedText = computed(() =>
    fillLabel(this.labels().loaded, { count: this.loaded() }),
  );
  protected readonly selectedText = computed(() =>
    fillLabel(this.labels().selected, { count: this.selected() }),
  );
  protected readonly cappedText = computed(() =>
    fillLabel(this.labels().selectionCapped, { count: this.selectionCap() }),
  );
  protected readonly droppedText = computed(() =>
    fillLabel(this.labels().dropped, { count: this.dropped() }),
  );
  protected readonly copyText = computed(() => {
    const outcome = this.copy();
    const labels = this.labels();
    if (outcome === null) return null;
    switch (outcome.kind) {
      case 'copied':
        return {
          text: fillLabel(labels.copied, { count: outcome.rows }),
          problem: false,
        };
      case 'truncated':
        return {
          text: fillLabel(labels.copyTruncated, {
            count: outcome.rows,
            omitted: outcome.omitted,
          }),
          problem: true,
        };
      case 'failed':
        return { text: labels.copyFailed, problem: true };
    }
  });
}
