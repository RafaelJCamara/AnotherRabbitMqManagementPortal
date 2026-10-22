// Whether the palette and the cheat sheet are open, and where focus goes back to when they close (M1-41, R11).
// Opening remembers the element that had focus; closing puts focus back there before anything else runs, so a
// command that moves focus (the explorer's filter) wins over the return.
import { DOCUMENT } from '@angular/common';
import { inject, Injectable, signal, type Signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class PaletteControl {
  readonly #document = inject(DOCUMENT);
  readonly #palette = signal(false);
  readonly #shortcuts = signal(false);
  #opener: HTMLElement | null = null;

  readonly paletteOpen: Signal<boolean> = this.#palette.asReadonly();
  readonly shortcutsOpen: Signal<boolean> = this.#shortcuts.asReadonly();

  openPalette(): void {
    if (this.#palette() || this.#shortcuts()) return;
    this.#remember();
    this.#palette.set(true);
  }

  togglePalette(): void {
    if (this.#palette()) this.closePalette();
    else this.openPalette();
  }

  /** Closes the palette and, by default, gives focus back to the element that had it. */
  closePalette(restore = true): void {
    if (!this.#palette()) return;
    this.#palette.set(false);
    if (restore) this.#restore();
  }

  openShortcuts(): void {
    if (this.#shortcuts()) return;
    if (!this.#palette()) this.#remember();
    this.#palette.set(false);
    this.#shortcuts.set(true);
  }

  closeShortcuts(): void {
    if (!this.#shortcuts()) return;
    this.#shortcuts.set(false);
    this.#restore();
  }

  #remember(): void {
    const active = this.#document.activeElement;
    this.#opener = active instanceof HTMLElement ? active : null;
  }

  #restore(): void {
    const opener = this.#opener;
    this.#opener = null;
    if (opener?.isConnected === true) opener.focus();
  }
}
