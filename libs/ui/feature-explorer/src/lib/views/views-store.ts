// The saved views of the person, for one grid kind (M0-54, R8). A view is not bound to a connection, so the
// list is the same on every connection. This store is the only place the explorer sends the two commands it
// has (`views.create`, `views.delete`); each failure is kept as received, so the page shows the engine's
// Problem as it was sent. Replacing a view creates the new one first and deletes the old one second: a
// failure between the two leaves a duplicate and never a loss.
import { inject, Injectable, signal, type Signal } from '@angular/core';
import {
  viewsCreate,
  viewsDelete,
  viewsList,
  type SavedView,
} from '@app/contracts';
import type { ExplorerKind } from '@app/explorer-model';
import { EngineApi } from '@app/ui-data';
import { firstValueFrom } from 'rxjs';

/** How many views one list asks for: the contract's page. */
export const VIEWS_LIST_LIMIT = 200;

export type ViewsStatus = 'idle' | 'loading' | 'ready' | 'error';

export type ReplaceOutcome = 'replaced' | 'created-only' | 'failed';

@Injectable()
export class ViewsStore {
  readonly #api = inject(EngineApi);
  readonly #views = signal<readonly SavedView[]>([]);
  readonly #status = signal<ViewsStatus>('idle');
  readonly #truncated = signal(false);
  readonly #error = signal<unknown>(null);
  readonly #busy = signal(false);

  readonly views: Signal<readonly SavedView[]> = this.#views.asReadonly();
  readonly status: Signal<ViewsStatus> = this.#status.asReadonly();
  /** There are more views than the list shows (only the first page is read). */
  readonly truncated: Signal<boolean> = this.#truncated.asReadonly();
  /** The last failure of a list, create or delete, as received; `null` after a success. */
  readonly error: Signal<unknown> = this.#error.asReadonly();
  readonly busy: Signal<boolean> = this.#busy.asReadonly();

  async load(kind: ExplorerKind): Promise<void> {
    this.#status.set('loading');
    try {
      const out = await firstValueFrom(
        this.#api.call(viewsList, { kind, limit: VIEWS_LIST_LIMIT }),
      );
      this.#views.set(out.items);
      this.#truncated.set(out.nextCursor !== undefined);
      this.#status.set('ready');
      this.#error.set(null);
    } catch (error) {
      this.#status.set('error');
      this.#error.set(error);
    }
  }

  /** Saves a view; `true` when the engine accepted it. */
  async create(
    name: string,
    kind: ExplorerKind,
    definition: Record<string, unknown>,
  ): Promise<boolean> {
    this.#busy.set(true);
    try {
      await firstValueFrom(
        this.#api.call(viewsCreate, { name, kind, definition }),
      );
      this.#error.set(null);
      await this.load(kind);
      return true;
    } catch (error) {
      this.#error.set(error);
      return false;
    } finally {
      this.#busy.set(false);
    }
  }

  async remove(id: string, kind: ExplorerKind): Promise<boolean> {
    this.#busy.set(true);
    try {
      await firstValueFrom(this.#api.call(viewsDelete, { viewId: id }));
      this.#error.set(null);
      await this.load(kind);
      return true;
    } catch (error) {
      this.#error.set(error);
      return false;
    } finally {
      this.#busy.set(false);
    }
  }

  /** Create first, delete second: a failed delete leaves both views, listed. */
  async replace(
    oldId: string,
    name: string,
    kind: ExplorerKind,
    definition: Record<string, unknown>,
  ): Promise<ReplaceOutcome> {
    if (!(await this.create(name, kind, definition))) return 'failed';
    return (await this.remove(oldId, kind)) ? 'replaced' : 'created-only';
  }
}
