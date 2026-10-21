import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { VerificationBanner } from '@app/ui-design';
import { TranslocoPipe } from '@jsverse/transloco';

import { StatusSource } from './status-source';

/**
 * Says how far the connected broker build is covered by a green conformance run. It is mounted
 * as soon as the answers are in; a missing profile is an unknown build, the strongest message
 * (AC-12). While the answers are on their way nothing is shown (OQ-346).
 */
@Component({
  selector: 'app-verification-notice',
  imports: [TranslocoPipe, VerificationBanner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!status.loading()) {
      <app-verification-banner
        [verification]="status.model().verification"
        [labels]="{
          'unverified-patch': 'status.verification.unverifiedPatch' | transloco,
          'unverified-minor': 'status.verification.unverifiedMinor' | transloco,
          'unknown-build': 'status.verification.unknownBuild' | transloco,
        }"
        [detail]="status.model().brokerVersion ?? undefined"
      />
    }
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
  `,
})
export class VerificationNotice {
  protected readonly status = inject(StatusSource);
}
