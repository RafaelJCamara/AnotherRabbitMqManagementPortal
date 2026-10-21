import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { bindDocumentTitle } from './i18n/document-title';
import { ChunkFailure } from './shell/skew/chunk-failure';

@Component({
  imports: [ChunkFailure, RouterOutlet],
  selector: 'app-root',
  template: '<router-outlet /><app-chunk-failure />',
})
export class App {
  /** The page title, translated; the document title follows it. */
  readonly title = bindDocumentTitle();
}
