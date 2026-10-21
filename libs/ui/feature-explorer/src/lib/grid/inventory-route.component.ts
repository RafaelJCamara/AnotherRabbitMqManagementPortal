// The routed side of an inventory page: the kind comes from the route's data, the vhost of a
// bindings page from `?vhost=`. This is the only file of the grid page that reads the router, and
// it is its own lazy chunk (the grid with its library is the heavy part of the explorer).
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
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
  template: `<app-inventory-page [kind]="kind()" [vhost]="vhost()" />`,
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
  protected readonly kind = toSignal(
    this.#route.data.pipe(map((data) => kindOf(data))),
    { requireSync: true },
  );
  protected readonly vhost = toSignal(
    this.#route.queryParamMap.pipe(map((params) => params.get('vhost'))),
    { initialValue: null },
  );
}
