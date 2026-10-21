import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { EnvChrome } from '@app/ui-design';
import { TranslocoPipe } from '@jsverse/transloco';

import { ActiveConnection } from '../active-connection';
import { StatusSource } from './status-source';

/**
 * The status bar: the environment class (`<app-env-chrome>`), the connection, the broker version,
 * the era, the statistics mode, the lock and the engine's health. Names and values the engine sent
 * are rendered as text; every label is a key. While the answers are on their way it shows a neutral
 * loading text instead of values, and afterwards anything unknown is said to be unknown, never left
 * blank (AC-11, AC-12).
 */
@Component({
  selector: 'app-status-bar',
  imports: [EnvChrome, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (status.loading()) {
      <span class="segment" role="status">{{
        'status.loading' | transloco
      }}</span>
    } @else {
      <app-env-chrome
        [environment]="model().environment"
        [labels]="{
          prod: 'status.env.prod' | transloco,
          staging: 'status.env.staging' | transloco,
          test: 'status.env.test' | transloco,
          dev: 'status.env.dev' | transloco,
          local: 'status.env.local' | transloco,
        }"
      />
    }
    <span class="segment">
      <span class="label">{{ 'status.connection' | transloco }}</span>
      <span class="value">{{ model().profileName ?? cid() }}</span>
    </span>
    @if (!status.loading()) {
      <span class="segment version">
        <span class="label">{{ 'status.version' | transloco }}</span>
        <span class="value">{{
          model().brokerVersion ?? ('status.unknown' | transloco)
        }}</span>
      </span>
      <span class="segment era">
        <span class="label">{{ 'status.era' | transloco }}</span>
        @if (model().era; as era) {
          <span class="value badge">{{ era.value }}</span>
          @if (era.conservative) {
            <span class="note">{{ 'status.eraConservative' | transloco }}</span>
          }
        } @else {
          <span class="value">{{ 'status.unknown' | transloco }}</span>
        }
      </span>
      <span class="segment stats">
        <span class="label">{{ 'status.stats.label' | transloco }}</span>
        <span class="value">{{ statsKey() | transloco }}</span>
      </span>
    }
    <span class="segment lock" [attr.data-lock]="model().lock">
      <span class="label">{{ 'status.lock.label' | transloco }}</span>
      <span class="value">{{ lockKey() | transloco }}</span>
    </span>
    <span class="segment health" [attr.data-health]="model().health">
      <span class="label">{{ 'status.health.label' | transloco }}</span>
      <span class="value">{{ healthKey() | transloco }}</span>
    </span>
  `,
  styles: `
    :host {
      display: flex;
      gap: var(--ds-space-3);
      align-items: center;
      min-width: 0;
      height: 100%;
      overflow: hidden;
      white-space: nowrap;
    }
    app-env-chrome {
      flex: none;
      min-height: 0;
      height: 100%;
    }
    .segment {
      display: flex;
      flex: none;
      gap: var(--ds-space-1);
      align-items: baseline;
    }
    .label {
      color: var(--ds-color-text-muted);
    }
    .value {
      color: var(--ds-color-text);
    }
    .badge {
      padding: 0 var(--ds-space-1);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
    }
    .note {
      font-style: italic;
    }
    [data-lock='locked'] .value,
    [data-health='down'] .value {
      color: var(--ds-color-text-danger);
    }
  `,
})
export class StatusBar {
  protected readonly status = inject(StatusSource);
  readonly #connection = inject(ActiveConnection);
  protected readonly cid = this.#connection.cid;
  protected readonly model = this.status.model;

  protected readonly statsKey = computed(() => {
    switch (this.model().stats) {
      case 'on':
        return 'status.stats.on';
      case 'totals-only':
        return 'status.stats.totalsOnly';
      case 'off':
        return 'status.stats.off';
      case null:
        return 'status.unknown';
    }
  });

  protected readonly lockKey = computed(
    () => `status.lock.${this.model().lock}`,
  );
  protected readonly healthKey = computed(
    () => `status.health.${this.model().health}`,
  );
}
