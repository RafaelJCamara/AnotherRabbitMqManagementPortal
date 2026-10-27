// The publish studio (M1-46, PUB-01): where a message is composed. It builds a `MessagesPublishInput` from the
// draft and names, field by field, what the contract's bounds refuse (R4); the engine decides everything else. This
// slice has no Send yet: nothing here calls the engine. `mandatory` and publisher confirms are stated as fixed facts,
// never as options (DC-12). The draft stays in memory (R7). With no connection the page shows nothing.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import { PUBLISH_CONNECTION } from '../connection';
import { controlValue } from './dom';
import { type DraftIssue, type PublishDraft } from './draft';
import { DraftStore } from './draft-store';
import { draftToInput } from './draft-to-input';
import { EditorField } from './editor-field.component';
import { Field } from './field.component';
import { HeaderGrid } from './header-grid.component';
import { issueText, issuesOf } from './issue-text';
import { BODY_LANGUAGES, PUBLISH_LIMITS, publishBodyBytes } from './limits';
import { prefillFromQuery, type PrefillParam } from './prefill';
import { PropsForm } from './props-form.component';
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
  imports: [EditorField, Field, HeaderGrid, PropsForm, TranslocoDirective],
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
  `,
})
export class PublishStudio {
  private readonly connection = inject(PUBLISH_CONNECTION);
  private readonly store = inject(DraftStore);
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
