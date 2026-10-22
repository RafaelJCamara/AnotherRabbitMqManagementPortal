import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ConnectionDirectory, isEngineProblem } from '@app/ui-data';
import { TranslocoPipe } from '@jsverse/transloco';

import { ActiveConnection, parseConnectionParam } from '../active-connection';
import { ADDRESS_EXISTS, resolveSwitchTarget } from './switch-target';

const ENV_ORDER = ['prod', 'staging', 'test', 'dev', 'local'] as const;

/**
 * The connection switcher (M0-52, R9): a native `<select>` of the connections the person has, with the active one
 * selected, a link to the page that manages them, and, when a switch could not carry the page over, a notice that
 * names the address it left behind. The list is the shared directory (`connections.list`); choosing another
 * connection navigates with `resolveSwitchTarget`. The connections are grouped by class, production first, so the class is read before the name.
 */
@Component({
  selector: 'app-connection-switcher',
  imports: [RouterLink, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="switcher">
      <label for="connection-switcher">{{
        'shell.switcher.label' | transloco
      }}</label>
      <select id="connection-switcher" (change)="choose($event)">
        @if (!listed()) {
          <option [value]="active() ?? ''" selected>{{ active() }}</option>
        }
        @for (group of groups(); track group.env) {
          <optgroup [label]="'status.env.' + group.env | transloco">
            @for (profile of group.profiles; track profile.id) {
              <option [value]="profile.id" [selected]="profile.id === active()">
                {{ profile.name }}
              </option>
            }
          </optgroup>
        }
      </select>
      <a routerLink="/connections">{{ 'shell.switcher.manage' | transloco }}</a>
      @if (failure(); as title) {
        <p class="problem" role="status">
          <span>{{ 'shell.switcher.failed' | transloco }}</span>
          @if (title) {
            <span class="title">{{ title }}</span>
          }
        </p>
      }
      @if (notice(); as missing) {
        <p class="notice" role="status">
          {{
            'shell.switcher.missing'
              | transloco: { address: missing.address, name: missing.name }
          }}
          <button type="button" (click)="dismiss()">
            {{ 'shell.switcher.dismiss' | transloco }}
          </button>
        </p>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      margin-bottom: var(--ds-space-3);
    }
    .switcher {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-1);
    }
    label {
      color: var(--ds-color-text-muted);
    }
    select {
      min-height: var(--ds-target-size);
      max-width: 100%;
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font: inherit;
    }
    a {
      color: var(--ds-color-text-link);
    }
    select:focus-visible,
    a:focus-visible,
    button:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    p {
      margin: 0;
    }
    .notice {
      padding: var(--ds-space-1) var(--ds-space-2);
      border-inline-start: 4px solid var(--ds-color-warning);
      background: var(--ds-color-surface);
    }
    button {
      min-height: var(--ds-target-size);
      margin-inline-start: var(--ds-space-2);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font: inherit;
      cursor: pointer;
    }
  `,
})
export class ConnectionSwitcher {
  readonly #directory = inject(ConnectionDirectory);
  readonly #router = inject(Router);
  readonly #connection = inject(ActiveConnection);
  readonly #exists = inject(ADDRESS_EXISTS);

  protected readonly active = this.#connection.cid;
  protected readonly items = this.#directory.items;
  /** The active connection is among those read (otherwise its id stands in until the list has it). */
  protected readonly listed = computed(() => {
    const cid = this.active();
    return cid !== null && this.items().some((profile) => profile.id === cid);
  });
  /** The connections by class, in the order of the strip (production first), a class with none left out. */
  protected readonly groups = computed(() =>
    ENV_ORDER.map((env) => ({
      env,
      profiles: this.items().filter((profile) => profile.envClass === env),
    })).filter((group) => group.profiles.length > 0),
  );
  protected readonly failure = computed(() => {
    const error = this.#directory.error();
    if (error === null) return null;
    return isEngineProblem(error) ? error.problem.title : '';
  });
  protected readonly notice = signal<{
    readonly address: string;
    readonly name: string;
  } | null>(null);

  constructor() {
    this.#directory.ensureLoaded();
  }

  protected async choose(event: Event): Promise<void> {
    const value = (event.target as HTMLSelectElement | null)?.value;
    const to = parseConnectionParam(value);
    if (to === null || to === this.active()) return;
    const target = await resolveSwitchTarget({
      currentUrl: this.#router.url,
      toCid: to,
      exists: this.#exists,
    });
    this.notice.set(
      target.missing === null
        ? null
        : {
            address: target.missing,
            name: this.#directory.find(to)?.name ?? to,
          },
    );
    await this.#router.navigateByUrl(target.url);
  }

  protected dismiss(): void {
    this.notice.set(null);
  }
}
