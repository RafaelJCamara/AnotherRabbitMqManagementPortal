// The routed side of an inventory page: the kind comes from the route's data, the vhost of a
// bindings page from `?vhost=`. This is the only file of the grid page that reads the router, and
// it is its own lazy chunk (the grid with its library is the heavy part of the explorer).
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { EXPLORER_KINDS, type ExplorerKind } from '@app/explorer-model';
import { map } from 'rxjs';

import { InventoryPage } from './inventory-page.component';

function kindOf(data: unknown): ExplorerKind {
  const kind = (data as { kind?: unknown }).kind;
  const known = EXPLORER_KINDS.find((candidate) => candidate === kind);
  if (known === undefined) {
    throw new Error('An inventory route needs a kind in its data.');
  }
  return known;
}

@Component({
  selector: 'app-inventory-route',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [InventoryPage],
  template: `<app-inventory-page
    [kind]="kind()"
    [vhost]="vhost()"
    [viewId]="viewId()"
    (vhostChange)="openVhost($event)"
    (viewChange)="openView($event)"
  />`,
  styles: `
    :host {
      display: block;
      height: 100%;
      min-height: 0;
    }
  `,
})
export class InventoryRoute {
  readonly #route = inject(ActivatedRoute);
  readonly #router = inject(Router);
  protected readonly kind = toSignal(
    this.#route.data.pipe(map((data) => kindOf(data))),
    { requireSync: true },
  );
  protected readonly vhost = toSignal(
    this.#route.queryParamMap.pipe(map((params) => params.get('vhost'))),
    { initialValue: null },
  );

  protected readonly viewId = toSignal(
    this.#route.queryParamMap.pipe(map((params) => params.get('view'))),
    { initialValue: null },
  );

  /** Parameters waiting for the next navigation: one navigation carries all that were asked in a turn. */
  #pending: Record<string, string | null> = {};
  #scheduled = false;

  /** The vhost of a bindings page lives in the address (`?vhost=`), so a tab can keep it. */
  protected openVhost(vhost: string): void {
    this.#navigate({ vhost: vhost === '' ? null : vhost });
  }

  /** The saved view in force lives in the address (`?view=`). */
  protected openView(id: string | null): void {
    this.#navigate({ view: id });
  }

  #navigate(params: Record<string, string | null>): void {
    Object.assign(this.#pending, params);
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      const queryParams = this.#pending;
      this.#pending = {};
      this.#scheduled = false;
      void this.#router.navigate([], {
        relativeTo: this.#route,
        queryParams,
        queryParamsHandling: 'merge',
      });
    });
  }
}
