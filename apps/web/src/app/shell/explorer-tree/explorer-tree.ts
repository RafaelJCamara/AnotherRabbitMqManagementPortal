import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ActiveConnection } from '../active-connection';
import { WorkspaceTabs } from '../tabs/workspace-tabs';
import {
  EXPLORER_TREE_ROW_LIMIT,
  EXPLORER_TREE_SOURCE,
  type ExplorerNode,
} from './explorer-tree-source';

interface TreeRow {
  readonly node: ExplorerNode;
  readonly depth: number;
  readonly parent: string | null;
  readonly position: number;
  readonly size: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
}

/**
 * The explorer tree (WAI-ARIA tree): one tab stop with roving focus; Up and Down move through the
 * visible rows, Right expands or enters a node, Left collapses or goes to the parent, Home and End
 * go to the ends, Enter or Space opens the node's address in a tab. It reads nodes from the
 * `ExplorerTreeSource` and draws at most `EXPLORER_TREE_ROW_LIMIT` rows (I-7).
 */
@Component({
  selector: 'app-explorer-tree',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div role="tree" [attr.aria-label]="'shell.tree.label' | transloco">
      @for (row of view().rows; track row.node.id) {
        <div
          role="treeitem"
          class="item"
          [attr.data-node]="row.node.id"
          [attr.aria-level]="row.depth + 1"
          [attr.aria-posinset]="row.position"
          [attr.aria-setsize]="row.size"
          [attr.aria-expanded]="row.expandable ? row.expanded : null"
          [attr.aria-selected]="row.node.id === stop()"
          [class.expandable]="row.expandable"
          [class.expanded]="row.expanded"
          [tabindex]="row.node.id === stop() ? 0 : -1"
          [style.padding-inline-start.px]="8 + row.depth * 16"
          (click)="activate(row)"
          (focus)="focused.set(row.node.id)"
          (keydown)="onKeydown($event, row)"
        >
          {{ row.node.label }}
        </div>
      }
    </div>
    @if (view().truncated) {
      <p class="hint">{{ 'shell.tree.truncated' | transloco }}</p>
    }
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .item {
      min-height: var(--ds-row-height);
      display: flex;
      align-items: center;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }
    .item.expandable::before {
      content: '\\25b8';
      width: 1em;
    }
    .item.expandable.expanded::before {
      content: '\\25be';
    }
    .item:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: -2px;
    }
    .hint {
      margin: var(--ds-space-2) 0 0;
      color: var(--ds-color-text-muted);
    }
  `,
})
export class ExplorerTree {
  readonly #source = inject(EXPLORER_TREE_SOURCE);
  readonly #connection = inject(ActiveConnection);
  readonly #tabs = inject(WorkspaceTabs);
  readonly #injector = inject(Injector);
  readonly #host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly #expanded = signal<ReadonlySet<string>>(new Set());
  protected readonly focused = signal<string | null>(null);

  protected readonly view = computed(() => {
    const cid = this.#connection.cid();
    const rows: TreeRow[] = [];
    let truncated = false;
    const walk = (
      nodes: readonly ExplorerNode[],
      depth: number,
      parent: string | null,
    ): void => {
      nodes.forEach((node, index) => {
        if (rows.length >= EXPLORER_TREE_ROW_LIMIT) {
          truncated = true;
          return;
        }
        const expandable = node.children !== 'none';
        const expanded = expandable && this.#expanded().has(node.id);
        rows.push({
          node,
          depth,
          parent,
          position: index + 1,
          size: nodes.length,
          expandable,
          expanded,
        });
        if (expanded)
          walk(this.#source.children(node.id)(), depth + 1, node.id);
      });
    };
    if (cid !== null) walk(this.#source.roots(cid)(), 0, null);
    return { rows, truncated };
  });

  /** The one row that is a tab stop: the focused one if it is still shown, else the first. */
  protected readonly stop = computed(() => {
    const { rows } = this.view();
    const focused = this.focused();
    return rows.some((row) => row.node.id === focused)
      ? focused
      : (rows[0]?.node.id ?? null);
  });

  protected activate(row: TreeRow): void {
    const { url, label } = row.node;
    if (url !== null) {
      this.#tabs.open({ url, label });
    } else if (row.expandable) {
      this.#toggle(row);
    }
  }

  protected onKeydown(event: KeyboardEvent, row: TreeRow): void {
    const { rows } = this.view();
    const at = rows.findIndex((candidate) => candidate.node.id === row.node.id);
    let target: TreeRow | undefined;
    switch (event.key) {
      case 'ArrowDown':
        target = rows[at + 1];
        break;
      case 'ArrowUp':
        target = rows[at - 1];
        break;
      case 'Home':
        target = rows[0];
        break;
      case 'End':
        target = rows[rows.length - 1];
        break;
      case 'ArrowRight':
        if (!row.expandable) return;
        if (!row.expanded) this.#toggle(row);
        else target = rows[at + 1];
        break;
      case 'ArrowLeft':
        if (row.expandable && row.expanded) this.#toggle(row);
        else
          target = rows.find((candidate) => candidate.node.id === row.parent);
        break;
      case 'Enter':
      case ' ':
        this.activate(row);
        break;
      default:
        return;
    }
    event.preventDefault();
    if (target !== undefined) this.#focus(target.node.id);
  }

  #toggle(row: TreeRow): void {
    this.#expanded.update((current) => {
      const next = new Set(current);
      if (next.has(row.node.id)) next.delete(row.node.id);
      else next.add(row.node.id);
      return next;
    });
  }

  #focus(id: string): void {
    this.focused.set(id);
    afterNextRender(
      () => {
        const items =
          this.#host.nativeElement.querySelectorAll<HTMLElement>(
            '[role="treeitem"]',
          );
        for (const item of items) {
          if (item.dataset.node === id) item.focus();
        }
      },
      { injector: this.#injector },
    );
  }
}
