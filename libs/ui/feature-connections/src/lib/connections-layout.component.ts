import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';

/** The frame of the connections pages: a `main` landmark with room to read. The pages bring their own headings. */
@Component({
  selector: 'app-connections-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, TranslocoPipe],
  template: `
    <main [attr.aria-label]="'connections.main' | transloco">
      <router-outlet />
    </main>
  `,
  styles: `
    :host {
      display: block;
      min-height: 100dvh;
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
    }
    main {
      box-sizing: border-box;
      max-width: 72rem;
      margin: 0 auto;
      padding: var(--ds-space-4);
    }
  `,
})
export class ConnectionsLayout {
  /** The layout holds no state; the pages bring their own. */
  protected readonly landmark = 'main';
}
