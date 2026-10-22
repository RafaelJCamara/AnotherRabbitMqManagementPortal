import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';

/** Shown when no connection is selected, or the connection id in the address is not usable. */
@Component({
  selector: 'app-no-connection',
  imports: [RouterLink, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section>
      <h1>{{ titleKey | transloco }}</h1>
      <p>{{ hintKey | transloco }}</p>
      <p>
        <a routerLink="/connections">{{ manageKey | transloco }}</a>
      </p>
    </section>
  `,
})
export class NoConnection {
  protected readonly titleKey = 'system.noConnection.title';
  protected readonly hintKey = 'system.noConnection.hint';
  protected readonly manageKey = 'system.noConnection.manage';
}
