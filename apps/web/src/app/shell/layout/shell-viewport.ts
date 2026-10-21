import { Injectable, inject, signal } from '@angular/core';

import type { Viewport } from './fit-layout';
import { VIEWPORT } from './shell-layout-store';

/** The size of the window as a signal; the shell calls `refresh` when the window is resized. */
@Injectable({ providedIn: 'root' })
export class ShellViewport {
  readonly #read = inject(VIEWPORT);
  readonly #size = signal<Viewport>(this.#read());
  readonly size = this.#size.asReadonly();

  refresh(): void {
    this.#size.set(this.#read());
  }
}
