// The harness page of `perf:grid-100k` (M0-53 AC-1, AC-4, AC-16): a bare Angular app that mounts the real
// `<app-data-grid>` on a fake engine window of 100,000 rows. Built by the `grid-100k-page` target.
import { bootstrapApplication } from '@angular/platform-browser';
import { provideDesignSystem } from '@app/ui-design';

import { HarnessApp } from './harness-app';

bootstrapApplication(HarnessApp, {
  providers: [provideDesignSystem()],
}).catch((error: unknown) => {
  console.error(error);
});
