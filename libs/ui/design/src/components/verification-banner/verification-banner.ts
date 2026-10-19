// <app-verification-banner>: says how far the connected broker build is covered by a green
// conformance run (`BrokerProfile.verification`). Only an exactly verified build shows nothing.
// Every other state, including a missing or unrecognised one, shows a banner, and an unknown
// build shows the strongest one: the banner never hides because the data is absent.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import type { Verification } from '@app/domain-model';

/** Every verification state of the broker profile. `verification-banner.spec.ts` pins it to the schema. */
export const VERIFICATION_STATES = [
  'verified',
  'unverified-patch',
  'unverified-minor',
  'unknown-build',
] as const satisfies readonly Verification[];

/** The message of each state that shows a banner, already translated. */
export type VerificationLabels = Readonly<
  Record<Exclude<Verification, 'verified'>, string>
>;

/** The state to show for whatever the engine sent: only an exact `verified` is verified. */
export function normalizeVerification(value: unknown): Verification {
  return (
    VERIFICATION_STATES.find((known) => known === value) ?? 'unknown-build'
  );
}

@Component({
  selector: 'app-verification-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (state() !== 'verified') {
      <div class="banner" role="status" [attr.data-verification]="state()">
        <span class="message">{{ message() }}</span
        >&ngsp;
        @if (detail()) {
          <span class="detail">{{ detail() }}</span>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      font-size: var(--ds-font-size);
    }
    .banner {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ds-space-3);
      padding: var(--ds-space-2) var(--ds-space-3);
      border-inline-start: 6px solid var(--ds-color-border-strong);
      background: var(--ds-color-warning);
      color: var(--ds-color-on-warning);
    }
    .banner[data-verification='unknown-build'] {
      background: var(--ds-color-danger);
      color: var(--ds-color-on-danger);
    }
    .message {
      font-weight: 600;
    }
  `,
})
export class VerificationBanner {
  /** `BrokerProfile.verification`; unset or unrecognised is treated as an unknown build. */
  readonly verification = input.required<Verification | null | undefined>();
  readonly labels = input.required<VerificationLabels>();
  /** Extra text such as the broker version. Rendered as text. */
  readonly detail = input<string>();

  protected readonly state = computed(() =>
    normalizeVerification(this.verification()),
  );
  protected readonly message = computed(() => {
    const state = this.state();
    if (state === 'verified') return '';
    const message = this.labels()[state];
    return message === '' ? state : message;
  });
}
