// The create and edit form of a connection (M0-52). Name, environment class (the chrome follows the choice before
// anything is saved), an optional pasted URI, and one block per endpoint with its own address, TLS flag and login.
// Secrets are write-only (R3): masked, uncontrolled inputs; an empty one is not sent; a saved profile reads back
// as set or not set; nothing typed is echoed into the page. Create is allowed on a running engine in any
// environment (the engine's local scope); Save of an edit is a mutating control behind the lock gate, and the
// engine's refusal is shown as sent with the unlock offered when the engine names it. Tests (draft in create,
// saved in edit) sit under the form.
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { ConnectionProfile } from '@app/contracts';
import { ArmingStore, lockGate } from '@app/ui-data';
import { EnvChrome, Gated } from '@app/ui-design';
import { TranslocoDirective } from '@jsverse/transloco';
import { map } from 'rxjs';

import { ConnectionsService } from '../connections.service';
import { connectionIdOf } from '../ids';
import { envLabels, gatedLabels } from '../labels';
import { ConnectionLock } from '../lock/connection-lock.component';
import { offersUnlock, problemView, type ProblemView } from '../problem';
import { ProblemAlert } from '../problem-alert.component';
import {
  TestPanel,
  type AmqpPorts,
  type TestTarget,
} from '../test/test-panel.component';
import type { Translate } from '../translate';
import { Field } from './field.component';
import {
  ENV_CLASS_CHOICES,
  emptyValues,
  toCreateInput,
  toEndpoints,
  toUpdateInput,
  validate,
  valuesFromProfile,
  type AmqpAuthKind,
  type FieldErrors,
  type FieldId,
  type FormMode,
  type FormValues,
  type HttpAuthKind,
} from './form-model';

type Load =
  | { readonly kind: 'ready' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly problem: ProblemView };

/** The label key of every field, for the summary of what is wrong. */
const FIELD_LABELS: Readonly<Record<FieldId, string>> = {
  name: 'connections.form.name',
  uri: 'connections.form.uri',
  'http.host': 'connections.form.host',
  'http.port': 'connections.form.port',
  'http.pathPrefix': 'connections.form.pathPrefix',
  'http.username': 'connections.form.username',
  'http.secret': 'connections.form.secret',
  'amqp.host': 'connections.form.host',
  'amqp.port': 'connections.form.port',
  'amqp.vhost': 'connections.form.vhost',
  'amqp.username': 'connections.form.username',
  'amqp.secret': 'connections.form.secret',
};

const DOM_ID = (id: FieldId): string => `f-${id.replace('.', '-')}`;

@Component({
  selector: 'app-connection-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ConnectionLock,
    EnvChrome,
    Field,
    Gated,
    ProblemAlert,
    RouterLink,
    TestPanel,
    TranslocoDirective,
  ],
  template: `
    <ng-container *transloco="let t">
      <nav [attr.aria-label]="t('connections.nav.label')">
        <a routerLink="/connections">{{ t('connections.nav.list') }}</a>
      </nav>
      <app-env-chrome
        [environment]="values().envClass"
        [labels]="envLabels(t)"
        [detail]="values().name"
      />
      <h1>
        {{
          creating()
            ? t('connections.form.createTitle')
            : t('connections.form.editTitle')
        }}
      </h1>
      @if (load().kind === 'loading') {
        <p role="status">{{ t('connections.page.loading') }}</p>
      }
      @if (loadFailure(); as problem) {
        <app-problem-alert [problem]="problem" />
      }
      @if (load().kind === 'ready') {
        @if (profile(); as profile) {
          <app-connection-lock
            [cid]="profile.id"
            [name]="profile.name"
            [envClass]="profile.envClass"
          />
        }
        @if (summary(t); as items) {
          @if (items.length > 0) {
            <div class="summary" role="alert">
              <p>{{ t('connections.form.summary') }}</p>
              <ul>
                @for (item of items; track item.id) {
                  <li>
                    <a
                      [href]="'#' + item.domId"
                      (click)="focusField($event, item.domId)"
                      >{{ item.label }}</a
                    >: {{ item.message }}
                  </li>
                }
              </ul>
            </div>
          }
        }
        <form
          novalidate
          [attr.aria-label]="t('connections.form.region')"
          (submit)="onSubmit($event)"
        >
          <fieldset>
            <legend>{{ t('connections.form.general') }}</legend>
            <app-field
              fieldId="f-name"
              [label]="t('connections.form.name')"
              [value]="values().name"
              [error]="errorText('name', t)"
              autocomplete="off"
              (changed)="top({ name: $event })"
            />
            <fieldset class="choices">
              <legend>{{ t('connections.form.env') }}</legend>
              @for (env of envChoices; track env) {
                <label class="choice">
                  <input
                    type="radio"
                    name="env"
                    [value]="env"
                    [checked]="values().envClass === env"
                    (change)="top({ envClass: env })"
                  />
                  {{ t('connections.env.' + env) }}
                </label>
              }
              <p class="hint">{{ t('connections.form.envHint') }}</p>
            </fieldset>
          </fieldset>

          @if (creating()) {
            <fieldset>
              <legend>{{ t('connections.form.uriLegend') }}</legend>
              <app-field
                fieldId="f-uri"
                [label]="t('connections.form.uri')"
                [hint]="t('connections.form.uriHint')"
                [error]="errorText('uri', t)"
                [secret]="true"
                (changed)="top({ uri: $event })"
              />
            </fieldset>
          }

          <fieldset>
            <legend>{{ t('connections.form.http') }}</legend>
            <app-field
              fieldId="f-http-host"
              [label]="t('connections.form.host')"
              [value]="values().http.host"
              [error]="errorText('http.host', t)"
              [hint]="creating() ? t('connections.form.hostHint') : ''"
              (changed)="http({ host: $event })"
            />
            <app-field
              fieldId="f-http-port"
              [label]="t('connections.form.port')"
              [value]="values().http.port"
              [error]="errorText('http.port', t)"
              [hint]="t('connections.form.httpPortHint')"
              inputmode="numeric"
              (changed)="http({ port: $event })"
            />
            <label class="check">
              <input
                type="checkbox"
                [checked]="values().http.tls"
                (change)="http({ tls: checked($event) })"
              />
              {{ t('connections.form.tls') }}
            </label>
            <p class="hint">{{ t('connections.form.tlsHint') }}</p>
            <app-field
              fieldId="f-http-pathPrefix"
              [label]="t('connections.form.pathPrefix')"
              [value]="values().http.pathPrefix"
              [error]="errorText('http.pathPrefix', t)"
              [hint]="t('connections.form.pathPrefixHint')"
              (changed)="http({ pathPrefix: $event })"
            />
            <div class="field">
              <label for="f-http-auth">{{ t('connections.form.login') }}</label>
              <select
                id="f-http-auth"
                (change)="http({ auth: httpAuth($event) })"
              >
                @for (kind of httpKinds; track kind) {
                  <option
                    [value]="kind"
                    [selected]="values().http.auth === kind"
                  >
                    {{ t('connections.page.auth.' + kind) }}
                  </option>
                }
              </select>
            </div>
            @if (values().http.auth === 'basic') {
              <app-field
                fieldId="f-http-username"
                [label]="t('connections.form.username')"
                [value]="values().http.username"
                [error]="errorText('http.username', t)"
                autocomplete="off"
                (changed)="http({ username: $event })"
              />
            }
            @if (values().http.auth !== 'none') {
              <app-field
                fieldId="f-http-secret"
                [label]="
                  values().http.auth === 'bearer'
                    ? t('connections.form.token')
                    : t('connections.form.password')
                "
                [hint]="secretHint('http', t)"
                [error]="errorText('http.secret', t)"
                [placeholder]="secretPlaceholder('http', t)"
                [secret]="true"
                (changed)="http({ secret: $event })"
              />
            }
          </fieldset>

          <fieldset>
            <legend>{{ t('connections.form.amqp') }}</legend>
            <app-field
              fieldId="f-amqp-host"
              [label]="t('connections.form.host')"
              [value]="values().amqp.host"
              [error]="errorText('amqp.host', t)"
              [hint]="creating() ? t('connections.form.amqpHostHint') : ''"
              (changed)="amqp({ host: $event })"
            />
            <app-field
              fieldId="f-amqp-port"
              [label]="t('connections.form.port')"
              [value]="values().amqp.port"
              [error]="errorText('amqp.port', t)"
              [hint]="t('connections.form.amqpPortHint')"
              inputmode="numeric"
              (changed)="amqp({ port: $event })"
            />
            <label class="check">
              <input
                type="checkbox"
                [checked]="values().amqp.tls"
                (change)="amqp({ tls: checked($event) })"
              />
              {{ t('connections.form.tls') }}
            </label>
            <app-field
              fieldId="f-amqp-vhost"
              [label]="t('connections.form.vhost')"
              [value]="values().amqp.vhost"
              [error]="errorText('amqp.vhost', t)"
              [hint]="t('connections.form.vhostHint')"
              (changed)="amqp({ vhost: $event })"
            />
            @if (creating() && values().http.auth === 'basic') {
              <label class="check">
                <input
                  type="checkbox"
                  [checked]="values().sameLogin"
                  (change)="top({ sameLogin: checked($event) })"
                />
                {{ t('connections.form.sameLogin') }}
              </label>
            }
            @if (!sameLogin()) {
              <div class="field">
                <label for="f-amqp-auth">{{
                  t('connections.form.login')
                }}</label>
                <select
                  id="f-amqp-auth"
                  (change)="amqp({ auth: amqpAuth($event) })"
                >
                  @for (kind of amqpKinds; track kind) {
                    <option
                      [value]="kind"
                      [selected]="values().amqp.auth === kind"
                    >
                      {{ t('connections.page.auth.' + kind) }}
                    </option>
                  }
                </select>
              </div>
              @if (values().amqp.auth === 'plain') {
                <app-field
                  fieldId="f-amqp-username"
                  [label]="t('connections.form.username')"
                  [value]="values().amqp.username"
                  [error]="errorText('amqp.username', t)"
                  autocomplete="off"
                  (changed)="amqp({ username: $event })"
                />
                <app-field
                  fieldId="f-amqp-secret"
                  [label]="t('connections.form.password')"
                  [hint]="secretHint('amqp', t)"
                  [error]="errorText('amqp.secret', t)"
                  [placeholder]="secretPlaceholder('amqp', t)"
                  [secret]="true"
                  (changed)="amqp({ secret: $event })"
                />
              }
            }
          </fieldset>

          @if (saveError(); as problem) {
            <app-problem-alert [problem]="problem" />
            @if (unlockOffered()) {
              <button type="button" class="secondary" (click)="unlock()">
                {{ t('connections.problem.unlock') }}
              </button>
            }
          }
          <div class="actions">
            @if (creating()) {
              <button
                type="submit"
                class="primary"
                [attr.aria-disabled]="saving() ? 'true' : null"
              >
                {{
                  saving()
                    ? t('connections.form.saving')
                    : t('connections.form.create')
                }}
              </button>
            } @else {
              <app-gated
                [gate]="
                  saveGate(
                    t('connections.lock.reason'),
                    t('connections.page.notOwner')
                  )
                "
                [labels]="gatedLabels(t)"
                (activated)="submit()"
                >{{
                  saving()
                    ? t('connections.form.saving')
                    : t('connections.form.save')
                }}</app-gated
              >
            }
            <a class="button" [routerLink]="cancelLink()">{{
              t('connections.form.cancel')
            }}</a>
          </div>
        </form>
        <app-test-panel
          [target]="target()"
          [source]="creating() ? 'draft' : 'saved'"
          (amqpPorts)="useAmqpPorts($event)"
        />
      }
    </ng-container>
  `,
  styles: `
    :host {
      display: block;
    }
    nav {
      margin-bottom: var(--ds-space-3);
    }
    a {
      color: var(--ds-color-text-link);
    }
    fieldset {
      margin: 0 0 var(--ds-space-4);
      padding: var(--ds-space-3);
      border: 1px solid var(--ds-color-border);
      border-radius: var(--ds-radius);
      min-width: 0;
    }
    legend {
      padding: 0 var(--ds-space-2);
      font-weight: 600;
    }
    .choices {
      border: 0;
      padding: 0;
    }
    .choice,
    .check {
      display: inline-flex;
      gap: var(--ds-space-2);
      align-items: center;
      margin-inline-end: var(--ds-space-4);
      min-height: var(--ds-target-size);
    }
    .hint {
      margin: 0 0 var(--ds-space-3);
      color: var(--ds-color-text-muted);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-1);
      margin-bottom: var(--ds-space-3);
    }
    .field label {
      font-weight: 600;
    }
    select {
      min-height: var(--ds-target-size);
      padding: 0 var(--ds-space-2);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font: inherit;
    }
    .summary {
      margin: var(--ds-space-3) 0;
      padding: var(--ds-space-2) var(--ds-space-3);
      border-inline-start: 6px solid var(--ds-color-danger);
      background: var(--ds-color-surface-sunken);
    }
    .summary p {
      margin: 0 0 var(--ds-space-1);
      font-weight: 600;
    }
    .summary ul {
      margin: 0;
      padding-inline-start: var(--ds-space-4);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ds-space-3);
      align-items: flex-start;
      margin: var(--ds-space-3) 0 var(--ds-space-4);
    }
    button,
    .button {
      display: inline-flex;
      align-items: center;
      min-height: var(--ds-target-size);
      padding: 0 var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font: inherit;
      text-decoration: none;
      cursor: pointer;
    }
    .primary {
      background: var(--ds-color-accent);
      color: var(--ds-color-on-accent);
    }
    button[aria-disabled='true'] {
      cursor: not-allowed;
      border-style: dashed;
    }
    button:focus-visible,
    a:focus-visible,
    input:focus-visible,
    select:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
  `,
})
export class ConnectionForm {
  readonly #route = inject(ActivatedRoute);
  readonly #router = inject(Router);
  readonly #service = inject(ConnectionsService);
  readonly #arming = inject(ArmingStore);
  readonly #injector = inject(Injector);
  readonly #host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly lock = viewChild(ConnectionLock);

  protected readonly envLabels = envLabels;
  protected readonly gatedLabels = gatedLabels;
  protected readonly envChoices = ENV_CLASS_CHOICES;
  protected readonly httpKinds: readonly HttpAuthKind[] = [
    'basic',
    'bearer',
    'none',
  ];
  protected readonly amqpKinds: readonly AmqpAuthKind[] = ['plain', 'none'];

  /** `create` on `/connections/new`, `edit` on `/connections/:id/edit` (the route's data says which). */
  protected readonly creating = computed(
    () => this.#route.snapshot.data.mode !== 'edit',
  );
  protected readonly cid = toSignal(
    this.#route.paramMap.pipe(
      map((params) => connectionIdOf(params.get('id'))),
    ),
    { initialValue: null },
  );
  protected readonly load = signal<Load>({ kind: 'ready' });
  protected readonly profile = signal<ConnectionProfile | null>(null);
  protected readonly values = signal<FormValues>(emptyValues());
  protected readonly submitted = signal(false);
  protected readonly saving = signal(false);
  protected readonly saveError = signal<ProblemView | null>(null);

  protected readonly loadFailure = computed(() => {
    const load = this.load();
    return load.kind === 'failed' ? load.problem : null;
  });
  readonly #mode = computed((): FormMode => {
    const profile = this.profile();
    return profile === null ? { kind: 'create' } : { kind: 'edit', profile };
  });
  protected readonly errors = computed<FieldErrors>(() =>
    this.submitted() ? validate(this.values(), this.#mode()) : {},
  );
  protected readonly sameLogin = computed(
    () =>
      this.creating() &&
      this.values().sameLogin &&
      this.values().http.auth === 'basic',
  );
  protected readonly unlockOffered = computed(() => {
    const cid = this.cid();
    return cid !== null && offersUnlock(this.saveError(), cid);
  });
  protected readonly cancelLink = computed(() => {
    const cid = this.cid();
    return this.creating() || cid === null
      ? ['/connections']
      : ['/connections', cid];
  });

  /** Create tests the draft; edit tests the saved connection (its stored login). `null`: nothing to aim at yet. */
  protected readonly target = computed((): TestTarget | null => {
    if (!this.creating()) {
      const cid = this.cid();
      return cid === null ? null : { cid };
    }
    const values = this.values();
    const problems = Object.keys(validate(values, { kind: 'create' })).filter(
      (id) => id !== 'name',
    );
    return problems.length === 0 ? { draft: toEndpoints(values) } : null;
  });

  constructor() {
    effect((onCleanup) => {
      if (this.creating()) return;
      const cid = this.cid();
      let current = true;
      onCleanup(() => {
        current = false;
      });
      if (cid === null) {
        this.load.set({
          kind: 'failed',
          problem: { title: '', detail: null, code: 'NOT_FOUND', gate: null },
        });
        return;
      }
      this.load.set({ kind: 'loading' });
      this.#service.get(cid).then(
        (profile) => {
          if (!current) return;
          this.profile.set(profile);
          this.values.set(valuesFromProfile(profile));
          this.load.set({ kind: 'ready' });
        },
        (error: unknown) => {
          if (current)
            this.load.set({ kind: 'failed', problem: problemView(error) });
        },
      );
    });
  }

  // ---- edits ---------------------------------------------------------------------------------

  protected top(
    patch: Partial<Pick<FormValues, 'name' | 'envClass' | 'uri' | 'sameLogin'>>,
  ): void {
    this.values.update((values) => ({ ...values, ...patch }));
  }

  protected http(patch: Partial<FormValues['http']>): void {
    this.values.update((values) => ({
      ...values,
      http: { ...values.http, ...patch },
    }));
  }

  protected amqp(patch: Partial<FormValues['amqp']>): void {
    this.values.update((values) => ({
      ...values,
      amqp: { ...values.amqp, ...patch },
    }));
  }

  protected checked(event: Event): boolean {
    return event.target instanceof HTMLInputElement && event.target.checked;
  }

  protected httpAuth(event: Event): HttpAuthKind {
    const value = (event.target as HTMLSelectElement | null)?.value;
    return this.httpKinds.find((kind) => kind === value) ?? 'basic';
  }

  protected amqpAuth(event: Event): AmqpAuthKind {
    const value = (event.target as HTMLSelectElement | null)?.value;
    return this.amqpKinds.find((kind) => kind === value) ?? 'plain';
  }

  protected useAmqpPorts(ports: AmqpPorts): void {
    const port = this.values().amqp.tls ? ports.tls : ports.plain;
    if (port !== null) this.amqp({ port: String(port) });
  }

  // ---- what the page says --------------------------------------------------------------------

  protected errorText(id: FieldId, t: Translate): string {
    const code = this.errors()[id];
    return code === undefined ? '' : t(`connections.form.error.${code}`);
  }

  protected summary(t: Translate): readonly {
    id: FieldId;
    domId: string;
    label: string;
    message: string;
  }[] {
    return (Object.keys(this.errors()) as FieldId[]).map((id) => ({
      id,
      domId: DOM_ID(id),
      label: t(FIELD_LABELS[id]),
      message: this.errorText(id, t),
    }));
  }

  protected secretHint(protocol: 'http' | 'amqp', t: Translate): string {
    const profile = this.profile();
    if (profile === null) return t('connections.form.secretHintNew');
    const stored = profile[protocol].auth.secret.isSet;
    return stored
      ? t('connections.form.secretHintSet')
      : t('connections.form.secretHintNotSet');
  }

  protected secretPlaceholder(protocol: 'http' | 'amqp', t: Translate): string {
    const profile = this.profile();
    return profile?.[protocol].auth.secret.isSet === true
      ? t('connections.form.secretPlaceholderSet')
      : '';
  }

  /** The gate of Save: the engine's `canEdit`, then the lock from the class and this page's own unlock. */
  protected saveGate(lockedReason: string, notOwnerReason: string) {
    const profile = this.profile();
    if (profile === null) return { enabled: false };
    if (!profile.canEdit) return { enabled: false, reason: notOwnerReason };
    return lockGate({
      cid: profile.id,
      envClass: profile.envClass,
      armed: this.#arming.armed(profile.id)(),
      reason: lockedReason,
    });
  }

  protected focusField(event: Event, domId: string): void {
    event.preventDefault();
    this.#host.nativeElement.querySelector<HTMLElement>(`#${domId}`)?.focus();
  }

  // ---- saving --------------------------------------------------------------------------------

  protected onSubmit(event: Event): void {
    event.preventDefault();
    // Save of an edit is gated: Enter in a field does not get round a closed gate.
    if (!this.creating() && !this.saveGate('', '').enabled) return;
    void this.submit();
  }

  protected async submit(): Promise<void> {
    if (this.saving()) return;
    this.submitted.set(true);
    this.saveError.set(null);
    const mode = this.#mode();
    const values = this.values();
    const errors = validate(values, mode);
    const first = (Object.keys(errors) as FieldId[])[0];
    if (first !== undefined) {
      afterNextRender(
        () => {
          this.#host.nativeElement
            .querySelector<HTMLElement>(`#${DOM_ID(first)}`)
            ?.focus();
        },
        { injector: this.#injector },
      );
      return;
    }
    this.saving.set(true);
    try {
      if (mode.kind === 'create') {
        const created = await this.#service.create(toCreateInput(values));
        await this.#router.navigate(['/connections', created.id]);
      } else {
        const updated = await this.#service.update(
          toUpdateInput(mode.profile.id, values, mode.profile),
        );
        await this.#router.navigate(['/connections', updated.id]);
      }
    } catch (error) {
      const view = problemView(error);
      this.saveError.set(view);
      const cid = this.cid();
      if (cid !== null && offersUnlock(view, cid)) this.#arming.noteLocked(cid);
    } finally {
      this.saving.set(false);
    }
  }

  /** The engine named the arming as the fix: open the unlock. */
  protected unlock(): void {
    this.lock()?.open();
  }
}
