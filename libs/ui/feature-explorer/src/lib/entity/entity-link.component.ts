// A name that is another entity (M1-42, R6): a real anchor, so middle-click, "open in a new tab" and "copy link"
// work and the address can be read; its plain click opens the entity the way the shell opens pages (a workspace
// tab), through `EXPLORER_NAVIGATION`. A click with a modifier or another button is the browser's.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';

import {
  EXPLORER_NAVIGATION,
  isPlainClick,
  type NavigationTarget,
} from '../navigation';

@Component({
  selector: 'app-entity-link',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<a
    [attr.href]="href()"
    [attr.aria-label]="accessibleName()"
    (click)="go($event)"
    >{{ text() }}</a
  >`,
  styles: `
    a {
      color: var(--ds-color-text-link);
      overflow-wrap: anywhere;
    }
    a:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
  `,
})
export class EntityLink {
  readonly cid = input.required<string>();
  readonly target = input.required<NavigationTarget>();
  /** What the link says. */
  readonly text = input.required<string>();
  /** The accessible name, when the text alone does not say which entity the link opens. */
  readonly accessibleName = input<string | null>(null);
  /** What a workspace tab for the target is called; the text when not given. */
  readonly tabLabel = input<string | null>(null);

  readonly #navigation = inject(EXPLORER_NAVIGATION);

  protected readonly href = computed(() =>
    this.#navigation.href(this.cid(), this.target()),
  );

  protected go(event: MouseEvent): void {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    this.#navigation.open(
      this.cid(),
      this.target(),
      this.tabLabel() ?? this.text(),
    );
  }
}
