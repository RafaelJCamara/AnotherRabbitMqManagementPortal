import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { bindDocumentTitle } from './i18n/document-title';

@Component({
  imports: [RouterOutlet],
  selector: 'app-root',
  template: '<router-outlet />',
})
export class App {
  /** The page title, translated; the document title follows it. */
  readonly title = bindDocumentTitle();
}
