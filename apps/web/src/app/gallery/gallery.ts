// The dev-only gallery (it replaces Storybook): every design-system component in every state, on
// every theme and density, for visual and axe checks. It is routed only in development builds
// (app.routes.ts); `web-gallery-check:gallery-absent` proves a production build contains none of it. The copy
// is local to this file because the gallery is never shipped and needs no translation.
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import type { GateDecision } from '@app/contracts';
import {
  DENSITIES,
  ENV_CLASSES,
  EnvChrome,
  Gated,
  THEME_PREFERENCES,
  ThemeService,
  VERIFICATION_STATES,
  VerificationBanner,
  type EnvLabels,
  type GatedLabels,
  type VerificationLabels,
} from '@app/ui-design';

const copy = {
  title: 'Design system gallery',
  theme: 'Theme',
  density: 'Density',
  gated: 'Gated controls',
  env: 'Environment chrome',
  verification: 'Verification banner',
  tokens: 'Text tokens on surfaces',
  activations: 'Activations',
  action: 'Purge queue',
  sample: 'Sample text',
  profile: 'orders-eu',
  broker: 'broker 4.3.7',
  gatedLabels: {
    whyDisabled: 'Why disabled:',
    degraded: 'Limited:',
    source: 'Source:',
    noReason: 'The engine gave no reason.',
  } satisfies GatedLabels,
  envLabels: {
    prod: 'Production',
    staging: 'Staging',
    test: 'Test',
    dev: 'Development',
    local: 'Local',
  } satisfies EnvLabels,
  verificationLabels: {
    'unverified-patch': 'This patch release is not verified.',
    'unverified-minor': 'This minor release is not verified.',
    'unknown-build': 'Unknown build: no behaviour is verified.',
  } satisfies VerificationLabels,
};

interface GatedExample {
  readonly id: string;
  readonly gate: GateDecision | null | undefined;
}

const gatedExamples: readonly GatedExample[] = [
  { id: 'enabled', gate: { enabled: true } },
  {
    id: 'degraded',
    gate: {
      enabled: true,
      mode: 'degraded',
      reason: 'Statistics are off: totals only.',
      source: 'https://example.com/docs/stats',
    },
  },
  {
    id: 'disabled-link',
    gate: {
      enabled: false,
      reason: 'Purge is locked on prod until armed.',
      source: 'https://example.com/docs/prod-lock',
    },
  },
  {
    id: 'disabled-id',
    gate: { enabled: false, reason: 'Locked by policy.', source: 'prod-lock' },
  },
  { id: 'disabled-no-reason', gate: { enabled: false } },
  { id: 'unknown', gate: undefined },
];

const TEXT_TOKENS = ['text', 'muted', 'link', 'danger', 'warning', 'success'];
const SURFACES = ['base', 'raised', 'sunken'];

@Component({
  selector: 'app-dev-gallery',
  imports: [Gated, EnvChrome, VerificationBanner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="gallery" data-testid="gallery">
      <h1>{{ copy.title }}</h1>

      <section aria-labelledby="gallery-theme">
        <h2 id="gallery-theme">{{ copy.theme }}</h2>
        <div role="group" aria-labelledby="gallery-theme">
          @for (preference of themes; track preference) {
            <button
              type="button"
              [attr.aria-pressed]="theme.preference() === preference"
              (click)="theme.setPreference(preference)"
            >
              {{ preference }}
            </button>
          }
        </div>
        <h2 id="gallery-density">{{ copy.density }}</h2>
        <div role="group" aria-labelledby="gallery-density">
          @for (density of densities; track density) {
            <button
              type="button"
              [attr.aria-pressed]="theme.density() === density"
              (click)="theme.setDensity(density)"
            >
              {{ density }}
            </button>
          }
        </div>
      </section>

      <section aria-labelledby="gallery-gated">
        <h2 id="gallery-gated">{{ copy.gated }}</h2>
        <p>{{ copy.activations }}: {{ activations() }}</p>
        @for (example of gatedExamples; track example.id) {
          <app-gated
            [attr.data-example]="example.id"
            [gate]="example.gate"
            [labels]="copy.gatedLabels"
            (activated)="activations.set(activations() + 1)"
          >
            {{ copy.action }}
          </app-gated>
        }
      </section>

      <section aria-labelledby="gallery-env">
        <h2 id="gallery-env">{{ copy.env }}</h2>
        @for (env of envClasses; track env) {
          <app-env-chrome
            [environment]="env"
            [labels]="copy.envLabels"
            [detail]="copy.profile"
          />
        }
        <app-env-chrome [environment]="undefined" [labels]="copy.envLabels" />
      </section>

      <section aria-labelledby="gallery-verification">
        <h2 id="gallery-verification">{{ copy.verification }}</h2>
        @for (state of verificationStates; track state) {
          <app-verification-banner
            [verification]="state"
            [labels]="copy.verificationLabels"
            [detail]="copy.broker"
          />
        }
        <app-verification-banner
          [verification]="undefined"
          [labels]="copy.verificationLabels"
        />
      </section>

      <section aria-labelledby="gallery-tokens">
        <h2 id="gallery-tokens">{{ copy.tokens }}</h2>
        @for (surface of surfaces; track surface) {
          <div class="surface" [attr.data-surface]="surface">
            @for (token of textTokens; track token) {
              <span class="sample" [attr.data-text]="token">{{
                copy.sample
              }}</span>
            }
          </div>
        }
      </section>
    </main>
  `,
  styles: `
    .gallery {
      display: grid;
      gap: var(--ds-space-4);
      padding: var(--ds-space-4);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font-family: var(--ds-font-family-ui);
      font-size: var(--ds-font-size);
    }
    section {
      display: grid;
      gap: var(--ds-space-2);
      justify-items: start;
    }
    button {
      min-height: var(--ds-target-size);
      min-width: var(--ds-target-size);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface-raised);
      color: var(--ds-color-text);
      font: inherit;
    }
    button[aria-pressed='true'] {
      background: var(--ds-color-accent);
      color: var(--ds-color-on-accent);
    }
    button:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    app-env-chrome,
    app-verification-banner {
      justify-self: stretch;
    }
    .surface {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ds-space-3);
      padding: var(--ds-space-3);
    }
    .surface[data-surface='base'] {
      background: var(--ds-color-surface);
    }
    .surface[data-surface='raised'] {
      background: var(--ds-color-surface-raised);
    }
    .surface[data-surface='sunken'] {
      background: var(--ds-color-surface-sunken);
    }
    .sample[data-text='text'] {
      color: var(--ds-color-text);
    }
    .sample[data-text='muted'] {
      color: var(--ds-color-text-muted);
    }
    .sample[data-text='link'] {
      color: var(--ds-color-text-link);
    }
    .sample[data-text='danger'] {
      color: var(--ds-color-text-danger);
    }
    .sample[data-text='warning'] {
      color: var(--ds-color-text-warning);
    }
    .sample[data-text='success'] {
      color: var(--ds-color-text-success);
    }
  `,
})
export class Gallery {
  protected readonly copy = copy;
  protected readonly theme = inject(ThemeService);
  protected readonly themes = THEME_PREFERENCES;
  protected readonly densities = DENSITIES;
  protected readonly envClasses = ENV_CLASSES;
  protected readonly verificationStates = VERIFICATION_STATES;
  protected readonly gatedExamples = gatedExamples;
  protected readonly textTokens = TEXT_TOKENS;
  protected readonly surfaces = SURFACES;
  protected readonly activations = signal(0);
}
