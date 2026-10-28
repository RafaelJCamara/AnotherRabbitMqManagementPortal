// The publish studio (M1-46, PUB-01): where a message is composed and sent. It builds a `MessagesPublishInput` from
// the draft and names, field by field, what the contract's bounds refuse (R4); the engine decides everything else.
// Send plans and executes through `SendFlow`: the plan's gates, consents and phrase are shown as the engine sent them,
// and the answer is shown one copy at a time (R5). The prod lock is shown as the engine's rule (`lockGate`, the
// arming window); a closed lock keeps Send closed with its reason. `mandatory` and publisher confirms are stated as
// fixed facts, never as options (DC-12). The draft stays in memory (R7). With no connection the page shows nothing.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { ArmingStore, ConnectionDirectory, lockGate } from '@app/ui-data';
import { Gated } from '@app/ui-design';
import { TranslocoDirective } from '@jsverse/transloco';

import type { GateDecision } from '@app/contracts';

import { PUBLISH_CONNECTION } from '../connection';
import { gatedLabels } from '../labels';
import { controlValue } from './dom';
import { type DraftIssue, type PublishDraft } from './draft';
import { DraftStore } from './draft-store';
import { draftToInput } from './draft-to-input';
import { EditorField } from './editor-field.component';
import { Field } from './field.component';
import { HeaderGrid } from './header-grid.component';
import { issueText, issuesOf } from './issue-text';
import { BODY_LANGUAGES, PUBLISH_LIMITS, publishBodyBytes } from './limits';
import { LockStrip } from './lock-strip.component';
import { PlanDialog } from './plan-dialog.component';
import { prefillFromQuery, type PrefillParam } from './prefill';
import { offersUnlock } from './problem';
import { ProblemAlert } from './problem-alert.component';
import { PropsForm } from './props-form.component';
import { ResultPanel } from './result-panel.component';
import { SendFlow } from './send-flow';
import type { Translate } from '../translate';

type TextField = 'vhost' | 'exchange' | 'routingKey';
type NumberField = 'copies' | 'timeoutMs';

const FIELD_LABELS: Readonly<Record<TextField | NumberField, string>> = {
  vhost: 'publish.form.vhost',
  exchange: 'publish.form.exchange',
  routingKey: 'publish.form.routingKey',
  copies: 'publish.form.copies',
  timeoutMs: 'publish.form.timeoutMs',
};

const LANGUAGE_LABELS = {
  plaintext: 'publish.body.languages.plaintext',
  json: 'publish.body.languages.json',
  xml: 'publish.body.languages.xml',
  yaml: 'publish.body.languages.yaml',
} as const;

@Component({
  selector: 'app-publish-studio',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    EditorField,
    Field,
    Gated,
    HeaderGrid,
    LockStrip,
    PlanDialog,
    ProblemAlert,
    PropsForm,
    ResultPanel,
    TranslocoDirective,
  ],
  providers: [SendFlow],
  template: `
    <ng-container *transloco="let t">
      @if (view(); as d) {
        <section>
          <h1>{{ t('publish.title') }}</h1>
          <p>{{ t('publish.draft.notice') }}</p>
          @if (refused().length > 0) {
            <p class="error" role="alert">
              {{
                t('publish.prefill.refused', {
                  limit: textMax,
                  names: refused().join(', '),
                })
              }}
            </p>
          }
          @if (connection(); as cid) {
            @if (classKnown()) {
              <app-lock-strip
                [cid]="cid"
                [name]="profile()?.name ?? cid"
                [envClass]="profile()?.envClass ?? null"
              />
            }
          }
          <ul class="facts" [attr.aria-label]="t('publish.fixed.label')">
            <li data-fact="mandatory">{{ t('publish.fixed.mandatory') }}</li>
            <li data-fact="confirm">{{ t('publish.fixed.confirm') }}</li>
          </ul>
          <fieldset>
            <legend>{{ t('publish.form.legend') }}</legend>
            @for (name of textFields; track name) {
              <app-field
                [fieldId]="'f-' + name"
                [label]="t(label(name))"
                [hint]="
                  name === 'exchange' ? t('publish.form.exchangeHint') : ''
                "
                [value]="d[name]"
                [error]="error(t, name)"
                (changed)="setText(name, $event)"
              />
            }
            @for (name of numberFields; track name) {
              <app-field
                [fieldId]="'f-' + name"
                type="number"
                [label]="t(label(name))"
                [value]="numberText(d[name])"
                [error]="error(t, name)"
                (changed)="setNumber(name, $event)"
              />
            }
          </fieldset>
          <app-props-form
            [props]="d.props"
            (propsChange)="patch({ props: $event })"
            [issues]="issues()"
          />
          <app-header-grid
            [rows]="d.headers"
            (rowsChange)="patch({ headers: $event })"
            [mode]="d.headerMode"
            (modeChange)="patch({ headerMode: $event })"
            [jsonError]="d.headerJsonError"
            (jsonErrorChange)="patch({ headerJsonError: $event })"
          />
          @for (issue of headerIssues(); track $index) {
            <p class="error">{{ text(t, issue) }}</p>
          }
          <fieldset>
            <legend>{{ t('publish.body.legend') }}</legend>
            <div class="field">
              <label for="f-encoding">{{ t('publish.body.encoding') }}</label>
              <select id="f-encoding" (change)="setEncoding($event)">
                <option value="utf8" [selected]="d.body.encoding === 'utf8'">
                  {{ t('publish.body.encodingUtf8') }}
                </option>
                <option
                  value="base64"
                  [selected]="d.body.encoding === 'base64'"
                >
                  {{ t('publish.body.encodingBase64') }}
                </option>
              </select>
            </div>
            <div class="field">
              <label for="f-language">{{ t('publish.body.language') }}</label>
              <select id="f-language" (change)="setLanguage($event)">
                @for (language of languages; track language) {
                  <option
                    [value]="language"
                    [selected]="d.body.language === language"
                  >
                    {{ t(languageLabel(language)) }}
                  </option>
                }
              </select>
              <p class="hint">{{ t('publish.body.highlightingNote') }}</p>
            </div>
            <app-editor-field
              [label]="t('publish.body.label')"
              [language]="d.body.language"
              [value]="d.body.data"
              (valueChange)="setBody($event)"
            />
            <p class="hint">
              {{
                t('publish.body.size', {
                  bytes: bodyBytes() ?? 0,
                  max: bodyMax,
                })
              }}
            </p>
            @for (issue of bodyIssues(); track $index) {
              <p class="error">{{ text(t, issue) }}</p>
            }
          </fieldset>
          <p role="status">
            @if (issues().length > 0) {
              {{ t('publish.issues.summary', { count: issues().length }) }}
            }
          </p>
          <div class="send">
            <app-gated
              [gate]="sendGate(t)"
              [labels]="gatedLabels(t)"
              (activated)="send()"
              >{{
                flow.busy() ? t('publish.send.busy') : t('publish.send.label')
              }}</app-gated
            >
          </div>
          @if (flow.phase() === 'failed') {
            @if (flow.problem(); as problem) {
              <app-problem-alert [problem]="problem" />
              <div class="after">
                @if (unlockOffered()) {
                  <button type="button" (click)="unlock()">
                    {{ t('publish.send.unlock') }}
                  </button>
                }
                <button type="button" (click)="flow.dismiss()">
                  {{ t('publish.send.dismiss') }}
                </button>
              </div>
            }
          }
          @if (flow.result(); as result) {
            <app-result-panel [result]="result" />
            <div class="after">
              <button type="button" (click)="flow.dismiss()">
                {{ t('publish.send.dismiss') }}
              </button>
            </div>
          }
          @if (flow.plan(); as plan) {
            <app-plan-dialog
              [plan]="plan"
              [busy]="flow.phase() === 'executing'"
              [problem]="flow.problem()"
              (confirmed)="flow.confirm($event.consents, $event.confirmation)"
              (cancelled)="flow.cancel()"
            />
          }
          <p class="sr-only" role="status" data-announce>
            {{ announcement(t) }}
          </p>
        </section>
      }
    </ng-container>
  `,
  styles: `
    section {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-3);
      padding: var(--ds-space-3);
      max-width: 60rem;
    }
    fieldset {
      border: 1px solid var(--ds-color-border);
      border-radius: var(--ds-radius);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-1);
      margin-bottom: var(--ds-space-3);
    }
    label {
      font-weight: 600;
    }
    select {
      min-height: var(--ds-target-size);
      font: inherit;
    }
    .error {
      color: var(--ds-color-text-danger);
      font-weight: 600;
      margin: 0;
    }
    .hint {
      color: var(--ds-color-text-muted);
      margin: 0;
    }
    .send,
    .after {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ds-space-3);
      align-items: flex-start;
    }
    button {
      min-height: var(--ds-target-size);
      padding: 0 var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font: inherit;
      cursor: pointer;
    }
    button:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `,
})
export class PublishStudio {
  protected readonly connection = inject(PUBLISH_CONNECTION);
  private readonly store = inject(DraftStore);
  private readonly directory = inject(ConnectionDirectory);
  private readonly arming = inject(ArmingStore);
  protected readonly flow = inject(SendFlow);
  private readonly lockStrip = viewChild(LockStrip);
  private readonly query = toSignal(inject(ActivatedRoute).queryParamMap);

  protected readonly textFields: readonly TextField[] = [
    'vhost',
    'exchange',
    'routingKey',
  ];
  protected readonly numberFields: readonly NumberField[] = [
    'copies',
    'timeoutMs',
  ];
  protected readonly languages = BODY_LANGUAGES;
  protected readonly textMax = PUBLISH_LIMITS.textMax;
  protected readonly bodyMax = PUBLISH_LIMITS.bodyBytesMax;
  protected readonly refused = signal<readonly PrefillParam[]>([]);

  /** The connection's profile as the engine sent it, or undefined while it is not known. */
  protected readonly profile = computed(() => {
    const cid = this.connection();
    return cid === null ? undefined : this.directory.find(cid);
  });
  /** The connections are read (or the read failed): until then the page cannot say what the lock is. */
  protected readonly classKnown = computed(() => {
    const status = this.directory.status();
    return status === 'ready' || status === 'error';
  });
  /** The engine is offering the unlock as the fix of a refusal of this connection. */
  protected readonly unlockOffered = computed(() => {
    const cid = this.connection();
    return cid !== null && offersUnlock(this.flow.problem(), cid);
  });

  private readonly draft = computed(() => {
    const cid = this.connection();
    return cid === null ? null : this.store.draft(cid);
  });
  /** The draft of the active connection, or null: no connection, nothing shown, nothing asked. */
  protected readonly view = computed(() => this.draft()?.() ?? null);

  private readonly result = computed(() => {
    const cid = this.connection();
    const draft = this.view();
    return cid === null || draft === null ? null : draftToInput(cid, draft);
  });
  protected readonly issues = computed<readonly DraftIssue[]>(() => {
    const result = this.result();
    return result === null || result.ok ? [] : result.issues;
  });
  protected readonly headerIssues = computed(() =>
    issuesOf(this.issues(), 'headers'),
  );
  protected readonly bodyIssues = computed(() =>
    issuesOf(this.issues(), 'body'),
  );
  protected readonly bodyBytes = computed(() => {
    const draft = this.view();
    return draft === null ? undefined : publishBodyBytes(draft.body);
  });

  constructor() {
    // The connection's class decides what the lock strip says (the engine decides the lock itself).
    effect(() => {
      if (this.connection() !== null) {
        untracked(() => {
          this.directory.ensureLoaded();
        });
      }
    });
    // The address may carry a starting point (R7): the three parameters, each bounded; the rest is ignored.
    effect(() => {
      const params = this.query();
      if (params === undefined || this.connection() === null) return;
      const { patch, refused } = prefillFromQuery((name) => params.get(name));
      untracked(() => {
        this.refused.set(refused);
        if (Object.keys(patch).length > 0) this.patch(patch);
      });
    });
  }

  protected gatedLabels = gatedLabels;

  /**
   * The gate of Send. The lock is the engine's rule, shown from the connection's class and this page's own unlock; a
   * send in flight and a draft the contract refuses close it with their reason. None of this authorises anything:
   * the engine still decides.
   */
  protected sendGate(t: Translate): GateDecision {
    const cid = this.connection();
    if (cid === null) return { enabled: false };
    if (!this.classKnown()) {
      return { enabled: false, reason: t('publish.send.reading') };
    }
    const lock = lockGate({
      cid,
      envClass: this.profile()?.envClass,
      armed: this.arming.armed(cid)(),
      reason: t('publish.lock.reason'),
    });
    if (!lock.enabled) return lock;
    if (this.flow.busy() || this.flow.phase() === 'review') {
      return { enabled: false, reason: t('publish.send.inFlight') };
    }
    const count = this.issues().length;
    if (count > 0) {
      return { enabled: false, reason: t('publish.send.fix', { count }) };
    }
    return { enabled: true };
  }

  protected send(): void {
    const cid = this.connection();
    const draft = this.view();
    if (cid === null || draft === null) return;
    const result = draftToInput(cid, draft);
    if (result.ok) this.flow.send(result.input);
  }

  protected unlock(): void {
    this.lockStrip()?.open();
  }

  /** What the live region says as a send moves on: counts and words, nothing the person typed. */
  protected announcement(t: Translate): string {
    switch (this.flow.phase()) {
      case 'planning':
      case 'executing':
        return t('publish.send.busy');
      case 'done': {
        const result = this.flow.result();
        if (result === null) return '';
        const total = result.copies.length;
        return result.allConfirmed
          ? t('publish.result.allConfirmed', { count: total })
          : t('publish.result.notAll', {
              confirmed: result.summary.confirmed,
              count: total,
            });
      }
      case 'failed':
        return t('publish.send.failed');
      default:
        return '';
    }
  }

  protected label(name: TextField | NumberField): string {
    return FIELD_LABELS[name];
  }

  protected languageLabel(language: keyof typeof LANGUAGE_LABELS): string {
    return LANGUAGE_LABELS[language];
  }

  protected text(t: Translate, issue: DraftIssue): string {
    return issueText(t, issue);
  }

  protected error(t: Translate, field: string): string {
    const issue = issuesOf(this.issues(), field)[0];
    return issue === undefined ? '' : issueText(t, issue);
  }

  protected numberText(value: number): string {
    return Number.isNaN(value) ? '' : String(value);
  }

  protected patch(patch: Partial<PublishDraft>): void {
    this.draft()?.update((draft) => ({ ...draft, ...patch }));
  }

  protected setText(name: TextField, text: string): void {
    this.patch({ [name]: text });
  }

  protected setNumber(name: NumberField, text: string): void {
    this.patch({ [name]: text === '' ? Number.NaN : Number(text) });
  }

  protected setBody(data: string): void {
    this.draft()?.update((draft) => ({
      ...draft,
      body: { ...draft.body, data },
    }));
  }

  protected setEncoding(event: Event): void {
    const encoding = controlValue(event) === 'base64' ? 'base64' : 'utf8';
    this.draft()?.update((draft) => ({
      ...draft,
      body: { ...draft.body, encoding },
    }));
  }

  protected setLanguage(event: Event): void {
    const value = controlValue(event);
    const language = BODY_LANGUAGES.find((candidate) => candidate === value);
    if (language === undefined) return;
    this.draft()?.update((draft) => ({
      ...draft,
      body: { ...draft.body, language },
    }));
  }
}
