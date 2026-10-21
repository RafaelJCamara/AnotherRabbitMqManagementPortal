import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { EXPLORER_CONNECTION } from './connection';

/** The explorer's landing page; the overview replaces it (slice G). It shows nothing without a connection. */
@Component({
  selector: 'app-explorer',
  imports: [TranslocoPipe],
  templateUrl: './explorer.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExplorerComponent {
  protected readonly connection = inject(EXPLORER_CONNECTION);
  /** Copy comes from the i18n scope (src/i18n/en.json), never from the template. */
  protected readonly titleKey = 'explorer.title';
}
