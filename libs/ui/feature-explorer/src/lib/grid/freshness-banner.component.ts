// The one banner region above a grid (M0-54, R4): what the last answer said about its freshness and
// what the live feed is doing, in words, never colour alone. The lines are plain text; a screen
// reader hears a separate, count-free announcement of the state (a polite live region), so a count
// that moves while the inventory loads does not read out again.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import type {
  ExplorerKind,
  Freshness,
  WindowSourceState,
} from '@app/explorer-model';
import { TranslocoDirective } from '@jsverse/transloco';

import type { Translate } from '../translate';
import { announcementKeys, freshnessLines, liveLines } from './freshness-model';

const DEFAULT_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

@Component({
  selector: 'app-freshness-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      <section
        class="banner"
        [attr.aria-label]="t('explorer.freshness.region')"
      >
        <p class="sr-only" role="status" aria-live="polite">
          {{ announcement(t) }}
        </p>
        <ul class="lines">
          @for (line of lines(); track line.id) {
            <li class="line" [class.warn]="line.tone === 'warn'">
              <span class="tag">{{
                t(
                  line.tone === 'warn'
                    ? 'explorer.freshness.tag.warn'
                    : 'explorer.freshness.tag.info'
                )
              }}</span>
              {{ t(line.key, line.params) }}
              @if (line.engine) {
                <span class="engine">{{ line.engine }}</span>
              }
            </li>
          }
          @for (line of live(); track line.id) {
            <li class="line live" [class.warn]="line.tone === 'warn'">
              <span class="tag">{{
                t(
                  line.tone === 'warn'
                    ? 'explorer.freshness.tag.warn'
                    : 'explorer.freshness.tag.info'
                )
              }}</span>
              {{ t(line.key, line.params) }}
              @if (line.problem; as problem) {
                <span class="problem">{{ problem.title }}</span
                >&ngsp;
                @if (problem.detail) {
                  <span class="problem">{{ problem.detail }}</span>
                }
              }
            </li>
          }
        </ul>
      </section>
    </ng-container>
  `,
  styles: `
    .lines {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .line {
      padding: var(--ds-space-1) var(--ds-space-3);
      font-size: var(--ds-font-size);
      color: var(--ds-color-text);
    }
    .line.warn {
      border-inline-start: 3px solid var(--ds-color-text-danger);
    }
    .tag {
      margin-inline-end: var(--ds-space-2);
      font-weight: 600;
    }
    .engine,
    .problem {
      margin-inline-start: var(--ds-space-2);
      color: var(--ds-color-text-muted);
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `,
})
export class FreshnessBanner {
  readonly kind = input.required<ExplorerKind>();
  /** The freshness of the last answer; `null` before the first. */
  readonly freshness = input.required<Freshness | null>();
  /** The source's state: the live feed and the count of version changes. */
  readonly state = input.required<WindowSourceState | null>();
  /** Formats the time of a sweep; the document language by default. */
  readonly time = input<(epochMs: number) => string>((ms) =>
    DEFAULT_TIME.format(ms),
  );

  protected readonly lines = computed(() => {
    const freshness = this.freshness();
    return freshness === null
      ? []
      : freshnessLines(freshness, this.kind(), {
          versionChanges: this.state()?.counters.versionChanges ?? 0,
          time: this.time(),
        });
  });
  protected readonly live = computed(() =>
    liveLines(this.kind(), this.state()),
  );

  protected announcement(t: Translate): string {
    return announcementKeys(this.freshness(), this.live())
      .map((key) => t(key))
      .join(' ');
  }
}
