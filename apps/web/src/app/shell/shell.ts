import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  ActivatedRoute,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { map } from 'rxjs';

import { ActiveConnection, parseConnectionParam } from './active-connection';
import { NoConnection } from './views/no-connection';

/**
 * The host of everything under `/c/:cid`: the regions of the IDE layout as landmarks. This slice
 * has the activity bar (the entries that have a route, OQ-536), the workspace outlet and the
 * status bar slot; the sidebar, panel, tabs and the status data arrive in later slices. An id
 * that fails validation leaves the connection unset and shows the no-connection view; the shell
 * never asks the engine anything for it.
 */
@Component({
  selector: 'app-shell',
  imports: [
    NoConnection,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    TranslocoPipe,
  ],
  templateUrl: './shell.html',
  styleUrl: './shell.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Shell {
  readonly #connection = inject(ActiveConnection);
  readonly #param = toSignal(
    inject(ActivatedRoute).paramMap.pipe(map((params) => params.get('cid'))),
    { initialValue: null },
  );
  protected readonly cid = computed(() => parseConnectionParam(this.#param()));

  constructor() {
    effect(() => {
      this.#connection.select(this.cid());
    });
    inject(DestroyRef).onDestroy(() => {
      this.#connection.select(null);
    });
  }
}
