// The routed side of an entity page (M1-42): the kind comes from the route's data, the key and the tab from the
// address (`/c/:cid/queues/:key[/:tab]`). Choosing a tab navigates to the entity's address with that tab; the
// same component is reused across tabs and keys, so the entity is not read again for a tab.
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import {
  entityUrl,
  EXPLORER_KINDS,
  type EntityTabId,
  type ExplorerKind,
} from '@app/explorer-model';
import { map } from 'rxjs';

import { EXPLORER_CONNECTION } from '../connection';
import { EntityPage } from './entity-page.component';

function kindOf(data: unknown): ExplorerKind {
  const kind = (data as { kind?: unknown }).kind;
  const known = EXPLORER_KINDS.find((candidate) => candidate === kind);
  if (known === undefined) {
    throw new Error('An entity route needs a kind in its data.');
  }
  return known;
}

@Component({
  selector: 'app-entity-route',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EntityPage],
  template: `<app-entity-page
    [kind]="kind()"
    [entityKey]="entityKey()"
    [tab]="tab()"
    (tabChange)="selectTab($event)"
  />`,
  styles: `
    :host {
      display: block;
    }
  `,
})
export class EntityRoute {
  readonly #route = inject(ActivatedRoute);
  readonly #router = inject(Router);
  readonly #connection = inject(EXPLORER_CONNECTION);

  protected readonly kind = toSignal(
    this.#route.data.pipe(map((data) => kindOf(data))),
    { requireSync: true },
  );
  protected readonly entityKey = toSignal(
    this.#route.paramMap.pipe(map((params) => params.get('key') ?? '')),
    { initialValue: '' },
  );
  protected readonly tab = toSignal(
    this.#route.paramMap.pipe(map((params) => params.get('tab'))),
    { initialValue: null },
  );

  protected selectTab(tab: EntityTabId): void {
    const cid = this.#connection();
    if (cid === null) return;
    void this.#router.navigateByUrl(
      entityUrl(cid, { kind: this.kind(), key: this.entityKey() }, tab),
    );
  }
}
