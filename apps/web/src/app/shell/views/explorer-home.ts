import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

/**
 * The explorer's place in the workspace until the explorer feature (M0-48, M0-54) mounts its own
 * route. It is a placeholder, not a feature: it holds no data and makes no engine call.
 */
@Component({
  selector: 'app-explorer-home',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section>
      <h1>{{ titleKey | transloco }}</h1>
      <p>{{ hintKey | transloco }}</p>
    </section>
  `,
})
export class ExplorerHome {
  protected readonly titleKey = 'shell.explorer.title';
  protected readonly hintKey = 'shell.explorer.empty';
}
