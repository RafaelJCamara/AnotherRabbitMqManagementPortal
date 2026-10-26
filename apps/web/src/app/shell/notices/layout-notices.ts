import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import type { LayoutRefusal } from '../layout/layout-ops';
import { ShellLayoutStore } from '../layout/shell-layout-store';
import type { LayoutNotice } from '../layout/shell-layout';

/** The message of each layout notice. Records, so a new notice cannot be left without text. */
export const NOTICE_KEYS: Readonly<Record<LayoutNotice, string>> = {
  absent: 'shell.notice.absent',
  invalid: 'shell.notice.invalid',
  'newer-version': 'shell.notice.newerVersion',
  'tabs-dropped': 'shell.notice.tabsDropped',
  'over-limit': 'shell.notice.overLimit',
  'load-failed': 'shell.notice.loadFailed',
};

export const REFUSAL_KEYS: Readonly<Record<LayoutRefusal, string>> = {
  groups: 'shell.refusal.groups',
  'tabs-per-group': 'shell.refusal.tabsPerGroup',
  'tabs-total': 'shell.refusal.tabsTotal',
  'url-too-long': 'shell.refusal.urlTooLong',
  'label-too-long': 'shell.refusal.labelTooLong',
  'unsafe-url': 'shell.refusal.unsafeUrl',
  'document-too-large': 'shell.refusal.documentTooLarge',
};

/**
 * What the shell says about the layout: why a stored one was not used, which change was refused
 * for a cap, and, as sent by the engine, why a save failed (AC-6, AC-7, AC-8). The engine's title,
 * reason and gate source are engine data and are rendered as text. Nothing here takes focus.
 */
@Component({
  selector: 'app-layout-notices',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (noticeKey(); as key) {
      <div class="notice" role="status">
        <span>{{ key | transloco }}</span>
        <button type="button" (click)="store.dismissNotice()">
          {{ 'shell.notice.dismiss' | transloco }}
        </button>
      </div>
    }
    @if (refusalKey(); as key) {
      <div class="notice" role="status">
        <span>{{ key | transloco }}</span>
        <button type="button" (click)="store.dismissRefusal()">
          {{ 'shell.notice.dismiss' | transloco }}
        </button>
      </div>
    }
    @if (store.saveProblem(); as problem) {
      <div class="notice problem" role="alert">
        <span class="headline">{{
          (store.problemOrigin() === 'save'
            ? 'shell.saveFailed.title'
            : 'shell.saveFailed.loadTitle'
          ) | transloco
        }}</span>
        @if (problem.synthetic) {
          <span>{{ 'shell.saveFailed.unreachable' | transloco }}</span>
        } @else {
          <span class="title">{{ problem.problem.title }}</span>
          @if (problem.problem.detail) {
            <span>{{ problem.problem.detail }}</span>
          }
          @if (problem.gate?.reason; as reason) {
            <span>{{ reason }}</span>
          }
          @if (problem.gate?.source; as source) {
            <span class="source">{{ source }}</span>
          }
        }
        @if (store.problemOrigin() === 'save') {
          <button
            type="button"
            [disabled]="store.saveState() === 'saving'"
            (click)="retry()"
          >
            {{ 'shell.saveFailed.retry' | transloco }}
          </button>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .notice {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ds-space-2) var(--ds-space-3);
      align-items: center;
      padding: var(--ds-space-1) var(--ds-space-3);
      background: var(--ds-color-info);
      color: var(--ds-color-on-info);
      border-block-end: 1px solid var(--ds-color-border);
    }
    .notice.problem {
      background: var(--ds-color-warning);
      color: var(--ds-color-on-warning);
    }
    .headline,
    .title {
      font-weight: 600;
    }
    button {
      min-height: var(--ds-target-size);
      font: inherit;
    }
    button:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
    }
  `,
})
export class LayoutNotices {
  protected readonly store = inject(ShellLayoutStore);
  protected readonly noticeKey = computed(() => {
    const notice = this.store.notice();
    return notice === null ? null : NOTICE_KEYS[notice];
  });
  protected readonly refusalKey = computed(() => {
    const refusal = this.store.refusal();
    return refusal === null ? null : REFUSAL_KEYS[refusal];
  });

  protected retry(): void {
    void this.store.retrySave();
  }
}
