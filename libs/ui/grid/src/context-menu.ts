// The grid's own context menu (AC-2, AC-14). AG Grid's menu is Enterprise and the browser's is
// prevented, so the menu is ours, written to the WAI-ARIA menu pattern (OQ-542: `@angular/aria` is
// not in the catalog yet). It sits behind `GridContextMenu` so it can swap to the Aria menu later.
//
// Gated items render the engine's decision as sent: an item is live only for `enabled: true`; any
// other gate (missing, `null`, anything else) is a closed one, stays focusable (`aria-disabled`) and
// says why, with the source, as text (the same rule as `<app-gated>`).
import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { GateDecision } from '@app/contracts';

export interface GridCellTarget<Row> {
  readonly rowId: string;
  /** `undefined` while the row's block is not loaded. */
  readonly row: Row | undefined;
  readonly columnId: string;
}

export type GridMenuItem =
  | { readonly kind: 'plain'; readonly id: string; readonly label: string }
  | {
      readonly kind: 'gated';
      readonly id: string;
      readonly label: string;
      readonly gate: GateDecision | null | undefined;
    }
  | { readonly kind: 'separator' };

export type GridMenuProvider<Row> = (
  target: GridCellTarget<Row>,
) => readonly GridMenuItem[];

/** The words of the menu and of a closed gate's reason; the caller supplies them translated. */
export interface GridMenuLabels {
  /** The accessible name of the menu. */
  readonly label: string;
  /** Introduces the reason of an item the engine disabled. */
  readonly whyDisabled: string;
  /** Introduces the reason of an item that works with limits. */
  readonly degraded: string;
  /** Names the source of the decision. */
  readonly source: string;
  /** Shown when the engine disabled the item and gave no reason. */
  readonly noReason: string;
}

/** True only for `enabled: true`; any other value of any other shape is a closed gate. */
export function isItemOpen(item: GridMenuItem): boolean {
  return (
    item.kind === 'plain' ||
    (item.kind === 'gated' && item.gate?.enabled === true)
  );
}

interface ItemView {
  readonly item: Exclude<GridMenuItem, { kind: 'separator' }>;
  readonly index: number;
  readonly open: boolean;
  /** Reason text of a closed or degraded gate, with its introduction; `null` when none is shown. */
  readonly reason: string | null;
  readonly source: string | null;
}

let nextMenu = 0;

@Component({
  selector: 'app-grid-context-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      #menu
      class="menu"
      role="menu"
      tabindex="-1"
      [attr.aria-label]="labels().label"
      [style.left.px]="left()"
      [style.top.px]="top()"
      (focusout)="onFocusOut($event)"
    >
      @for (view of views(); track $index) {
        @if (view === 'separator') {
          <div class="separator" role="separator"></div>
        } @else {
          <div
            class="item"
            role="menuitem"
            tabindex="-1"
            [attr.aria-disabled]="view.open ? null : 'true'"
            [attr.aria-describedby]="view.reason ? reasonId(view.index) : null"
            (click)="activate(view)"
            (keydown)="onKeydown($event)"
          >
            <span class="item-label">{{ view.item.label }}</span>
            @if (view.reason) {
              <span class="reason" [id]="reasonId(view.index)"
                >{{ view.reason }}
                @if (view.source) {
                  <span class="reason-source">{{ view.source }}</span>
                }
              </span>
            }
          </div>
        }
      }
    </div>
  `,
  styles: `
    .menu {
      position: fixed;
      z-index: 1000;
      min-width: 12rem;
      max-width: 24rem;
      padding: var(--ds-space-1);
      background: var(--ds-color-surface-raised);
      color: var(--ds-color-text);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      font-size: var(--ds-font-size);
    }
    .menu:focus {
      outline: none;
    }
    .item {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-1);
      min-height: var(--ds-target-size);
      padding: var(--ds-space-1) var(--ds-space-3);
      border-radius: var(--ds-radius);
      cursor: pointer;
    }
    .item:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: -2px;
    }
    .item:hover {
      background: var(--ds-color-surface-sunken);
    }
    .item[aria-disabled='true'] {
      color: var(--ds-color-text-muted);
      cursor: not-allowed;
    }
    .reason {
      color: var(--ds-color-text-muted);
    }
    .reason-source {
      margin-inline-start: var(--ds-space-2);
    }
    .separator {
      height: 1px;
      margin: var(--ds-space-1) 0;
      background: var(--ds-color-border);
    }
  `,
})
export class GridContextMenu {
  readonly items = input.required<readonly GridMenuItem[]>();
  readonly labels = input.required<GridMenuLabels>();
  /** Viewport coordinates of the menu's top-left corner; it is kept inside the window. */
  readonly x = input.required<number>();
  readonly y = input.required<number>();
  /** The id of the item the user chose; only an open item emits. */
  readonly chosen = output<string>();
  /** The menu wants to go away; `returnFocus` is false when focus already moved elsewhere. */
  readonly dismissed = output<{ readonly returnFocus: boolean }>();

  private readonly menu = viewChild.required<ElementRef<HTMLElement>>('menu');
  private readonly document = inject(DOCUMENT);
  private readonly id = nextMenu++;
  private readonly shift = signal<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  protected readonly left = computed(() => this.x() + this.shift().dx);
  protected readonly top = computed(() => this.y() + this.shift().dy);
  protected readonly views = computed<readonly (ItemView | 'separator')[]>(() =>
    this.items().map((item, index) => {
      if (item.kind === 'separator') return 'separator';
      const open = isItemOpen(item);
      const gate = item.kind === 'gated' ? item.gate : undefined;
      const degraded = open && gate?.mode === 'degraded';
      const labels = this.labels();
      const reasonText = gate?.reason?.trim() ?? '';
      const shown = item.kind === 'gated' && (!open || degraded);
      let reason: string | null = null;
      if (shown) {
        const kind = degraded ? labels.degraded : labels.whyDisabled;
        const text =
          reasonText !== '' || degraded ? reasonText : labels.noReason;
        reason = text === '' ? kind : `${kind} ${text}`;
      }
      const source =
        shown && gate?.source ? `${labels.source} ${gate.source}` : null;
      return { item, index, open, reason, source };
    }),
  );

  constructor() {
    // Once rendered: keep the menu inside the window, then put focus on the first live item.
    afterNextRender(() => {
      const menu = this.menu().nativeElement;
      const view = this.document.defaultView;
      if (view) {
        const box = menu.getBoundingClientRect();
        const dx = Math.min(0, view.innerWidth - box.right - 4);
        const dy = Math.min(0, view.innerHeight - box.bottom - 4);
        if (dx !== 0 || dy !== 0) this.shift.set({ dx, dy });
      }
      const rows = this.rows();
      const open = this.views().findIndex((v) => v !== 'separator' && v.open);
      const first = open >= 0 ? this.rowOfView(open) : 0;
      (rows[first] ?? menu).focus();
    });
  }

  protected reasonId(index: number): string {
    return `app-grid-menu-${String(this.id)}-reason-${String(index)}`;
  }

  protected activate(view: ItemView): void {
    // A closed item emits nothing and the menu stays open, so its reason can be read.
    if (!view.open) return;
    this.chosen.emit(view.item.id);
    this.dismissed.emit({ returnFocus: true });
  }

  protected onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && this.menu().nativeElement.contains(next))
      return;
    this.dismissed.emit({ returnFocus: false });
  }

  protected onKeydown(event: KeyboardEvent): void {
    const rows = this.rows();
    const at = rows.indexOf(this.document.activeElement as HTMLElement);
    const move = (to: number): void => {
      event.preventDefault();
      rows[(to + rows.length) % rows.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        move(at + 1);
        break;
      case 'ArrowUp':
        move(at < 0 ? rows.length - 1 : at - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(rows.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        this.dismissed.emit({ returnFocus: true });
        break;
      case 'Tab':
        // The menu closes and focus goes on in the page, as the pattern says.
        this.dismissed.emit({ returnFocus: true });
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const view = this.viewOfRow(at);
        if (view) this.activate(view);
        break;
      }
      default:
        break;
    }
  }

  private rows(): HTMLElement[] {
    return [
      ...this.menu().nativeElement.querySelectorAll<HTMLElement>(
        '[role="menuitem"]',
      ),
    ];
  }

  /** The position among the menu items (separators do not count) of the view at `viewIndex`. */
  private rowOfView(viewIndex: number): number {
    return this.views()
      .slice(0, viewIndex)
      .filter((v) => v !== 'separator').length;
  }

  private viewOfRow(row: number): ItemView | undefined {
    if (row < 0) return undefined;
    return this.views().filter((v): v is ItemView => v !== 'separator')[row];
  }
}
