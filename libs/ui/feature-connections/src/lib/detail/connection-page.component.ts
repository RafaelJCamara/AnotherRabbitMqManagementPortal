// One connection (M0-52): its environment chrome, the addresses and logins as the engine reads them back (a
// secret only as set or not set), the lock line with the unlock, and Edit and Delete. Delete is a mutating control
// behind the lock gate (`<app-gated>`, built from the profile's class and this page's own unlock, plus the engine's
// `canEdit`); the engine still decides, and its refusal is shown as sent with the unlock offered when the engine
// named it as the fix. Tests and the capability card are regions of this page (slices E and F).
import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
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
import { ConfirmDialog } from '../dialog/confirm-dialog.component';
import { connectionIdOf } from '../ids';
import { envLabels, gatedLabels } from '../labels';
import { ConnectionLock } from '../lock/connection-lock.component';
import { offersUnlock, problemView, type ProblemView } from '../problem';
import { ProblemAlert } from '../problem-alert.component';
import { TestPanel } from '../test/test-panel.component';
import type { Translate } from '../translate';

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly profile: ConnectionProfile }
  | { readonly kind: 'failed'; readonly problem: ProblemView };

@Component({
  selector: 'app-connection-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ConfirmDialog,
    ConnectionLock,
    DatePipe,
    EnvChrome,
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
      @switch (load().kind) {
        @case ('loading') {
          <p role="status">{{ t('connections.page.loading') }}</p>
        }
        @case ('failed') {
          @if (failure(); as problem) {
            <h1>{{ t('connections.page.failedTitle') }}</h1>
            @if (problem.code === 'NOT_FOUND') {
              <p>{{ t('connections.page.notFound') }}</p>
            }
            <app-problem-alert [problem]="problem" />
          }
        }
        @case ('ready') {
          @if (profile(); as profile) {
            <app-env-chrome
              [environment]="profile.envClass"
              [labels]="envLabels(t)"
              [detail]="profile.name"
            />
            <h1>{{ profile.name }}</h1>
            <app-connection-lock
              [cid]="profile.id"
              [name]="profile.name"
              [envClass]="profile.envClass"
            />
            <div class="actions">
              <a class="button" [routerLink]="['/c', profile.id, 'explorer']">{{
                t('connections.page.openExplorer')
              }}</a>
              <a class="button" routerLink="edit">{{
                t('connections.page.edit')
              }}</a>
              <app-gated
                [gate]="
                  deleteGate(
                    profile,
                    t('connections.lock.reason'),
                    t('connections.page.notOwner')
                  )
                "
                [labels]="gatedLabels(t)"
                (activated)="askDelete()"
                >{{ t('connections.page.delete') }}</app-gated
              >
            </div>
            <section [attr.aria-labelledby]="'endpoints-title'">
              <h2 id="endpoints-title">
                {{ t('connections.page.endpoints') }}
              </h2>
              <dl>
                <dt>{{ t('connections.page.managementUrl') }}</dt>
                <dd>{{ profile.http.url }}</dd>
                <dt>{{ t('connections.page.managementLogin') }}</dt>
                <dd>{{ login(profile.http.auth, t) }}</dd>
                <dt>{{ t('connections.page.managementSecret') }}</dt>
                <dd>
                  @if (profile.http.auth.secret.isSet) {
                    {{ t('connections.page.secretSet') }}
                    @if (profile.http.auth.secret.updatedAt; as at) {
                      ({{ at | date: 'medium' }})
                    }
                  } @else {
                    {{ t('connections.page.secretNotSet') }}
                  }
                </dd>
                <dt>{{ t('connections.page.amqpAddress') }}</dt>
                <dd>
                  {{ profile.amqp.host }}:{{ profile.amqp.port }},
                  {{ t('connections.page.vhost') }} {{ profile.amqp.vhost }},
                  {{
                    profile.amqp.tls
                      ? t('connections.page.tlsOn')
                      : t('connections.page.tlsOff')
                  }}
                </dd>
                <dt>{{ t('connections.page.amqpLogin') }}</dt>
                <dd>{{ login(profile.amqp.auth, t) }}</dd>
                <dt>{{ t('connections.page.amqpSecret') }}</dt>
                <dd>
                  @if (profile.amqp.auth.secret.isSet) {
                    {{ t('connections.page.secretSet') }}
                    @if (profile.amqp.auth.secret.updatedAt; as at) {
                      ({{ at | date: 'medium' }})
                    }
                  } @else {
                    {{ t('connections.page.secretNotSet') }}
                  }
                </dd>
                <dt>{{ t('connections.page.updated') }}</dt>
                <dd>{{ profile.updatedAt | date: 'medium' }}</dd>
              </dl>
            </section>
            <app-test-panel [target]="{ cid: profile.id }" source="saved" />
            @if (deleteOpen()) {
              <app-confirm-dialog
                [heading]="
                  t('connections.delete.title', { name: profile.name })
                "
                [confirmLabel]="t('connections.delete.confirm')"
                [cancelLabel]="t('connections.delete.cancel')"
                [busyLabel]="t('connections.delete.busy')"
                [busy]="deleteBusy()"
                [danger]="true"
                [problem]="deleteError()"
                [extraLabel]="
                  unlockOffered() ? t('connections.problem.unlock') : null
                "
                (confirmed)="confirmDelete()"
                (cancelled)="cancelDelete()"
                (extra)="unlockInstead()"
              >
                <p>
                  {{ t('connections.delete.body', { name: profile.name }) }}
                </p>
              </app-confirm-dialog>
            }
          }
        }
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
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ds-space-3);
      align-items: flex-start;
      margin: var(--ds-space-3) 0;
    }
    .button {
      display: inline-flex;
      align-items: center;
      min-height: var(--ds-target-size);
      padding: 0 var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      text-decoration: none;
    }
    a:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    dl {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: var(--ds-space-1) var(--ds-space-4);
    }
    dt {
      color: var(--ds-color-text-muted);
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
  `,
})
export class ConnectionPage {
  readonly #route = inject(ActivatedRoute);
  readonly #router = inject(Router);
  readonly #service = inject(ConnectionsService);
  readonly #arming = inject(ArmingStore);
  private readonly lock = viewChild(ConnectionLock);

  protected readonly envLabels = envLabels;
  protected readonly gatedLabels = gatedLabels;

  protected readonly cid = toSignal(
    this.#route.paramMap.pipe(
      map((params) => connectionIdOf(params.get('id'))),
    ),
    { initialValue: null },
  );
  protected readonly load = signal<Load>({ kind: 'loading' });
  protected readonly profile = computed(() => {
    const load = this.load();
    return load.kind === 'ready' ? load.profile : null;
  });
  protected readonly failure = computed(() => {
    const load = this.load();
    return load.kind === 'failed' ? load.problem : null;
  });

  protected readonly deleteOpen = signal(false);
  protected readonly deleteBusy = signal(false);
  protected readonly deleteError = signal<ProblemView | null>(null);
  protected readonly unlockOffered = computed(() => {
    const cid = this.cid();
    return cid !== null && offersUnlock(this.deleteError(), cid);
  });

  constructor() {
    effect((onCleanup) => {
      const cid = this.cid();
      let current = true;
      onCleanup(() => {
        current = false;
      });
      if (cid === null) {
        this.load.set({
          kind: 'failed',
          problem: {
            title: '',
            detail: null,
            code: 'NOT_FOUND',
            gate: null,
          },
        });
        return;
      }
      this.load.set({ kind: 'loading' });
      this.#service.get(cid).then(
        (profile) => {
          if (current) this.load.set({ kind: 'ready', profile });
        },
        (error: unknown) => {
          if (current)
            this.load.set({ kind: 'failed', problem: problemView(error) });
        },
      );
    });
  }

  /** The gate of Delete: the engine's `canEdit`, then the lock from the class and this page's own unlock. */
  protected deleteGate(
    profile: ConnectionProfile,
    lockedReason: string,
    notOwnerReason: string,
  ) {
    if (!profile.canEdit) return { enabled: false, reason: notOwnerReason };
    return lockGate({
      cid: profile.id,
      envClass: profile.envClass,
      armed: this.#arming.armed(profile.id)(),
      reason: lockedReason,
    });
  }

  /** `user name and password, guest`: the kind of login in words, then the user name the engine sent. */
  protected login(
    auth: { readonly kind: string; readonly username: string | null },
    t: Translate,
  ): string {
    const kind = t(`connections.page.auth.${auth.kind}`);
    return auth.username === null || auth.username === ''
      ? kind
      : `${kind}, ${auth.username}`;
  }

  protected askDelete(): void {
    this.deleteError.set(null);
    this.deleteOpen.set(true);
  }

  protected cancelDelete(): void {
    this.deleteOpen.set(false);
  }

  protected async confirmDelete(): Promise<void> {
    const cid = this.cid();
    if (cid === null) return;
    this.deleteBusy.set(true);
    try {
      await this.#service.remove(cid);
      this.deleteOpen.set(false);
      await this.#router.navigate(['/connections']);
    } catch (error) {
      const view = problemView(error);
      this.deleteError.set(view);
      if (offersUnlock(view, cid)) this.#arming.noteLocked(cid);
    } finally {
      this.deleteBusy.set(false);
    }
  }

  /** The engine named the arming as the fix: close the delete and open the unlock. */
  protected unlockInstead(): void {
    this.deleteOpen.set(false);
    this.lock()?.open();
  }
}
