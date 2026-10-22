// The entity pages' specs: a fake inventory with the rows a spec names, the page mounted on one of them, and
// small readers for what the page shows. Never part of the library build.
import type { Provider } from '@angular/core';
import { encodeObjectKey } from '@app/contracts';
import type {
  ExplorerKind,
  Freshness,
  InventoryRow,
} from '@app/explorer-model';
import {
  createFakeExplorerData,
  type FakeExplorerData,
} from '@app/explorer-model/testing';
import { GRID_CLIPBOARD } from '@app/ui-grid';

import { EntityPage } from '../entity/entity-page.component';
import { FakeWorkspace } from './fake-workspace';
import { mountPage, type PageBed } from './page-testbed';

export { PAGE_TEST_TIMEOUT_MS } from './dom';

export function queueRow(
  name: string,
  patch: Record<string, unknown> = {},
  vhost = '/',
): InventoryRow {
  return {
    key: encodeObjectKey(vhost, name),
    vhost,
    name,
    ...patch,
  };
}

export function keyOf(row: InventoryRow): string {
  return row.key;
}

export interface EntityBed extends PageBed<EntityPage> {
  readonly written: string[];
}

/** A clipboard that records what it is given, or refuses. */
export function clipboard(refuse = false): {
  provider: Provider;
  written: string[];
} {
  const written: string[] = [];
  return {
    written,
    provider: {
      provide: GRID_CLIPBOARD,
      useValue: {
        writeText: (text: string) => {
          if (refuse) return Promise.reject(new Error('refused'));
          written.push(text);
          return Promise.resolve();
        },
      },
    },
  };
}

export interface EntityOptions {
  readonly kind?: ExplorerKind;
  /** The rows the fake inventory holds for the kind (replacing its own). */
  readonly rows?: readonly InventoryRow[];
  /** The key the page is opened on; default the first row. */
  readonly key?: string;
  readonly tab?: string | null;
  readonly fake?: FakeExplorerData;
  readonly workspace?: FakeWorkspace;
  readonly cid?: string | null;
  readonly refuseClipboard?: boolean;
  readonly providers?: readonly Provider[];
  /** The topic answers at once (default); false leaves the page waiting for `fake.emit`. */
  readonly autoSnapshot?: boolean;
  /** What the index says about itself from the first read on (default: live and complete). */
  readonly freshness?: Partial<Freshness>;
  /** Read through the real engine-backed data port and live client over the fake engine (every request is recorded). */
  readonly engineBacked?: boolean;
}

export async function mountEntity(
  options: EntityOptions = {},
): Promise<EntityBed> {
  const kind = options.kind ?? 'queues';
  const fake =
    options.fake ??
    createFakeExplorerData({
      rows: { queues: 0, exchanges: 0, connections: 0, bindings: 0 },
      vhosts: ['/'],
      autoSnapshot: options.autoSnapshot ?? true,
    });
  if (options.freshness !== undefined) fake.setFreshness(options.freshness);
  const { rows } = options;
  if (rows !== undefined) {
    fake.bump((all) => {
      (all as unknown as Record<string, unknown[]>)[kind] = [...rows];
    });
  }
  const key = options.key ?? options.rows?.[0]?.key ?? 'missing';
  const pad = clipboard(options.refuseClipboard === true);
  const bed = await mountPage(EntityPage, {
    fake,
    ...(options.workspace === undefined
      ? {}
      : { workspace: options.workspace }),
    ...(options.cid === undefined ? {} : { cid: options.cid }),
    ...(options.engineBacked === true ? { engineBacked: true } : {}),
    inputs: { kind, entityKey: key, tab: options.tab ?? null },
    providers: [pad.provider, ...(options.providers ?? [])],
  });
  return { ...bed, written: pad.written };
}

/** The term and description pairs of the page's field list, in order. */
export function fieldPairs(el: Element): [string, string][] {
  const dl = el.querySelector('dl.fields');
  if (dl === null) return [];
  const terms = [...dl.querySelectorAll('dt')].map((n) => n.textContent.trim());
  const values = [...dl.querySelectorAll('dd')].map((n) =>
    n.textContent.trim(),
  );
  return terms.map((term, i) => [term, values[i] ?? ''] as [string, string]);
}

export function tabIds(el: Element): string[] {
  return [...el.querySelectorAll<HTMLElement>('[role="tab"]')].map(
    (tab) => tab.dataset.tab ?? '',
  );
}

/** The follower of the topic at a position, or a failure that says there is none. */
export function followerAt(
  fake: FakeExplorerData,
  at = 0,
): FakeExplorerData['followers'][number] {
  const found = fake.followers[at];
  if (found === undefined) throw new Error(`no follower at ${String(at)}`);
  return found;
}

/** The first element matching a selector, or a failure. */
export function must(root: Element, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
}
