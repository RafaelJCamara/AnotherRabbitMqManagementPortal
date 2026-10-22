// The connections the person has (M0-52): one row per profile with its environment chrome, the management URL and
// the AMQP address, a link to the connection and a link that opens its explorer. The list is the shared directory
// (the list action, in windows of 100, at most 200 kept); a failed read says so and keeps what was read.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConnectionDirectory } from '@app/ui-data';
import { EnvChrome } from '@app/ui-design';
import { TranslocoDirective } from '@jsverse/transloco';

import { envLabels } from '../labels';
import { problemView } from '../problem';
import { ProblemAlert } from '../problem-alert.component';

@Component({
  selector: 'app-connection-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EnvChrome, ProblemAlert, RouterLink, TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      <header>
        <h1>{{ t('connections.title') }}</h1>
        <a class="button primary" routerLink="new">{{
          t('connections.list.add')
        }}</a>
      </header>
      @if (directory.status() === 'loading' && items().length === 0) {
        <p role="status">{{ t('connections.list.loading') }}</p>
      }
      @if (failure(); as problem) {
        <app-problem-alert [problem]="problem" />
        <button type="button" (click)="retry()">
          {{ t('connections.list.retry') }}
        </button>
      }
      @if (items().length > 0) {
        <table>
          <caption>
            {{
              t('connections.list.caption')
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">{{ t('connections.list.name') }}</th>
              <th scope="col">{{ t('connections.list.environment') }}</th>
              <th scope="col">{{ t('connections.list.management') }}</th>
              <th scope="col">{{ t('connections.list.amqp') }}</th>
              <th scope="col">{{ t('connections.list.open') }}</th>
            </tr>
          </thead>
          <tbody>
            @for (profile of items(); track profile.id) {
              <tr>
                <th scope="row">
                  <a [routerLink]="[profile.id]">{{ profile.name }}</a>
                </th>
                <td>
                  <app-env-chrome
                    [environment]="profile.envClass"
                    [labels]="envLabels(t)"
                  />
                </td>
                <td>{{ profile.http.url }}</td>
                <td>{{ profile.amqp.host }}:{{ profile.amqp.port }}</td>
                <td>
                  <a [routerLink]="['/c', profile.id, 'explorer']">{{
                    t('connections.list.openExplorer')
                  }}</a>
                </td>
              </tr>
            }
          </tbody>
        </table>
        @if (directory.hasMore()) {
          <button type="button" (click)="more()">
            {{ t('connections.list.more') }}
          </button>
        }
      } @else if (directory.status() === 'ready') {
        <p>{{ t('connections.list.empty') }}</p>
      }
    </ng-container>
  `,
  styles: `
    :host {
      display: block;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ds-space-3);
      align-items: center;
      justify-content: space-between;
    }
    h1 {
      margin: 0;
    }
    table {
      width: 100%;
      margin: var(--ds-space-3) 0;
      border-collapse: collapse;
    }
    caption {
      text-align: start;
      color: var(--ds-color-text-muted);
      padding-bottom: var(--ds-space-1);
    }
    th,
    td {
      padding: var(--ds-space-1) var(--ds-space-3);
      border-bottom: 1px solid var(--ds-color-border);
      text-align: start;
      vertical-align: middle;
      overflow-wrap: anywhere;
    }
    td app-env-chrome {
      display: inline-flex;
    }
    a {
      color: var(--ds-color-text-link);
    }
    a:focus-visible,
    button:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    .button,
    button {
      display: inline-flex;
      align-items: center;
      min-height: var(--ds-target-size);
      padding: 0 var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font: inherit;
      text-decoration: none;
      cursor: pointer;
    }
    .primary {
      background: var(--ds-color-accent);
      color: var(--ds-color-on-accent);
    }
  `,
})
export class ConnectionList {
  protected readonly directory = inject(ConnectionDirectory);
  protected readonly envLabels = envLabels;
  protected readonly items = this.directory.items;
  protected readonly failure = computed(() => {
    const error = this.directory.error();
    return error === null ? null : problemView(error);
  });

  constructor() {
    // The page shows the engine's current list when it opens, whatever an earlier visit read.
    void this.directory.refresh();
  }

  protected retry(): void {
    void this.directory.refresh();
  }

  protected more(): void {
    void this.directory.more();
  }
}
