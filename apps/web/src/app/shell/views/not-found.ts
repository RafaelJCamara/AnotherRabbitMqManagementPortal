import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

/** Shown in the workspace when a child route under `/c/:cid` does not exist. */
@Component({
  selector: 'app-not-found',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section>
      <h1>{{ titleKey | transloco }}</h1>
      <p>{{ hintKey | transloco }}</p>
    </section>
  `,
})
export class NotFound {
  protected readonly titleKey = 'system.notFound.title';
  protected readonly hintKey = 'system.notFound.hint';
}
