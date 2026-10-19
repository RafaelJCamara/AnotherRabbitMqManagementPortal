// <app-env-chrome>: the strip that tells the user which environment class they are working in.
// An unset or unknown class is shown as `prod`, the same fail-closed reading the engine has
// (`EnvClassSchema`: an unset class means prod), so a connection never looks safer than it is.
// The name is text, never colour alone.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import type { EnvClass } from '@app/contracts';

/** Every environment class, in the order of the contract. `env-chrome.spec.ts` pins it to `EnvClassSchema`. */
export const ENV_CLASSES = [
  'prod',
  'staging',
  'test',
  'dev',
  'local',
] as const satisfies readonly EnvClass[];

/** The label of each class, already translated. Typed as a record so none can be missing. */
export type EnvLabels = Readonly<Record<EnvClass, string>>;

/** The class to show for whatever the engine sent: anything that is not a known class is prod. */
export function normalizeEnv(value: unknown): EnvClass {
  return ENV_CLASSES.find((known) => known === value) ?? 'prod';
}

@Component({
  selector: 'app-env-chrome',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.data-env]': 'env()',
    '[class.prod]': 'env() === "prod"',
  },
  template: `
    <span class="name">{{ label() }}</span
    >&ngsp;
    @if (detail()) {
      <span class="detail">{{ detail() }}</span>
    }
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: var(--ds-space-3);
      min-height: var(--ds-row-height);
      padding: 0 var(--ds-space-3);
      font-size: var(--ds-font-size);
      font-weight: 600;
      border-bottom: 2px solid var(--ds-color-border-strong);
    }
    :host(.prod) {
      border-bottom-width: 4px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    :host([data-env='prod']) {
      background: var(--ds-color-env-prod);
      color: var(--ds-color-on-env-prod);
    }
    :host([data-env='staging']) {
      background: var(--ds-color-env-staging);
      color: var(--ds-color-on-env-staging);
    }
    :host([data-env='test']) {
      background: var(--ds-color-env-test);
      color: var(--ds-color-on-env-test);
    }
    :host([data-env='dev']) {
      background: var(--ds-color-env-dev);
      color: var(--ds-color-on-env-dev);
    }
    :host([data-env='local']) {
      background: var(--ds-color-env-local);
      color: var(--ds-color-on-env-local);
    }
    .detail {
      font-weight: 400;
    }
  `,
})
export class EnvChrome {
  /** The environment class of the connection; unset or unknown is shown as prod. */
  readonly environment = input.required<EnvClass | null | undefined>();
  readonly labels = input.required<EnvLabels>();
  /** Extra text after the class, such as the profile name. Rendered as text. */
  readonly detail = input<string>();

  protected readonly env = computed(() => normalizeEnv(this.environment()));
  protected readonly label = computed(() => {
    const label = this.labels()[this.env()];
    // An incomplete label set (a missing translation) falls back to the class id, never to blank.
    return label === '' ? this.env() : label;
  });
}
