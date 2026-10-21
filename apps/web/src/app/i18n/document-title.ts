import { inject, type Signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { TranslocoService } from '@jsverse/transloco';
import { tap } from 'rxjs';

import { SCOPE_LOADERS, scopeDefinition } from './i18n.config';

/**
 * Keeps the page title equal to the `system.appTitle` translation (index.html holds a neutral
 * placeholder) and returns it as a signal. Call it from the field initialiser or constructor of a
 * root component.
 */
export function bindDocumentTitle(): Signal<string> {
  const title = inject(Title);
  const text = inject(TranslocoService)
    .selectTranslate<string>(
      'appTitle',
      {},
      scopeDefinition(inject(SCOPE_LOADERS), 'system'),
    )
    .pipe(
      tap((value) => {
        title.setTitle(value);
      }),
      takeUntilDestroyed(),
    );
  return toSignal(text, { initialValue: '' });
}
