import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

/** Shown when no connection is selected, or the connection id in the address is not usable. */
@Component({
  selector: 'app-no-connection',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section>
      <h1>{{ titleKey | transloco }}</h1>
      <p>{{ hintKey | transloco }}</p>
    </section>
  `,
})
export class NoConnection {
  protected readonly titleKey = 'system.noConnection.title';
  protected readonly hintKey = 'system.noConnection.hint';
}
