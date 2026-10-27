// The headers of a message, as a table of typed rows or as the contract's typed JSON (R4). The rows are the
// truth: every JSON text that is a typed table replaces them, so going back to the table loses nothing. A JSON that
// is not one leaves the rows as they were and says so (`jsonError`), and the draft refuses to send meanwhile. A
// duplicate or unfit row is marked where it is.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  model,
  type OnInit,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import { controlValue } from './dom';
import { EditorField } from './editor-field.component';
import {
  headersToJson,
  headersToRows,
  isHeaderType,
  newRow,
  parseHeadersJson,
  rowsToHeaders,
  type HeaderJsonError,
  type HeaderRow,
} from './header-model';
import { issueText } from './issue-text';
import { HEADER_TYPES } from './limits';
import type { Translate } from '../translate';

type SwitchError = 'row' | HeaderJsonError;

const TYPE_LABELS = {
  string: 'publish.headers.types.string',
  byte: 'publish.headers.types.byte',
  short: 'publish.headers.types.short',
  int: 'publish.headers.types.int',
  long: 'publish.headers.types.long',
  float: 'publish.headers.types.float',
  double: 'publish.headers.types.double',
  bool: 'publish.headers.types.bool',
  timestamp: 'publish.headers.types.timestamp',
  decimal: 'publish.headers.types.decimal',
  bytes: 'publish.headers.types.bytes',
  void: 'publish.headers.types.void',
  array: 'publish.headers.types.array',
  table: 'publish.headers.types.table',
} as const;

const SWITCH_TEXT: Readonly<Record<SwitchError, string>> = {
  row: 'publish.headers.switchRow',
  json: 'publish.headers.switchJson',
  shape: 'publish.headers.switchShape',
};

@Component({
  selector: 'app-header-grid',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EditorField, TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      <fieldset>
        <legend>{{ t('publish.headers.legend') }}</legend>
        <div role="group" [attr.aria-label]="t('publish.headers.mode')">
          <button
            type="button"
            class="mode-grid"
            [attr.aria-pressed]="mode() === 'grid'"
            (click)="showGrid()"
          >
            {{ t('publish.headers.modeGrid') }}
          </button>
          <button
            type="button"
            class="mode-json"
            [attr.aria-pressed]="mode() === 'json'"
            (click)="showJson()"
          >
            {{ t('publish.headers.modeJson') }}
          </button>
        </div>
        @if (switchError(); as error) {
          <p class="error" role="alert">{{ t(switchText(error)) }}</p>
        }
        @if (mode() === 'grid') {
          @if (rows().length === 0) {
            <p>{{ t('publish.headers.none') }}</p>
          } @else {
            <table>
              <thead>
                <tr>
                  <th scope="col">{{ t('publish.headers.columnName') }}</th>
                  <th scope="col">{{ t('publish.headers.columnType') }}</th>
                  <th scope="col">{{ t('publish.headers.columnValue') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (row of rows(); track row.id; let n = $index) {
                  <tr [attr.data-row]="row.id">
                    <td>
                      <input
                        spellcheck="false"
                        [attr.aria-label]="
                          t('publish.headers.nameOf', { n: n + 1 })
                        "
                        [attr.aria-invalid]="
                          problems(t, row.id) ? 'true' : null
                        "
                        [attr.aria-describedby]="
                          problems(t, row.id) ? 'hdr-err-' + row.id : null
                        "
                        [value]="row.name"
                        (input)="set(row.id, { name: read($event) })"
                      />
                    </td>
                    <td>
                      <select
                        [attr.aria-label]="
                          t('publish.headers.typeOf', { n: n + 1 })
                        "
                        (change)="setType(row.id, $event)"
                      >
                        @for (type of types; track type) {
                          <option [value]="type" [selected]="row.type === type">
                            {{ t(typeLabel(type)) }}
                          </option>
                        }
                      </select>
                    </td>
                    <td>
                      <input
                        spellcheck="false"
                        [disabled]="row.type === 'void'"
                        [attr.aria-label]="
                          t('publish.headers.valueOf', { n: n + 1 })
                        "
                        [attr.aria-invalid]="
                          problems(t, row.id) ? 'true' : null
                        "
                        [value]="row.text"
                        (input)="set(row.id, { text: read($event) })"
                      />
                      <button
                        type="button"
                        class="remove"
                        (click)="remove(row.id)"
                      >
                        {{ t('publish.headers.remove', { n: n + 1 }) }}
                      </button>
                      @if (problems(t, row.id); as text) {
                        <p class="error" [id]="'hdr-err-' + row.id">
                          {{ text }}
                        </p>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
            @if (tableProblem(t); as text) {
              <p class="error">{{ text }}</p>
            }
          }
          <button type="button" class="add" (click)="add()">
            {{ t('publish.headers.add') }}
          </button>
          <p class="hint">{{ t('publish.headers.typedHint') }}</p>
        } @else {
          <app-editor-field
            language="json"
            [label]="t('publish.headers.jsonLabel')"
            [value]="jsonText()"
            (valueChange)="editJson($event)"
          />
          <p class="hint">{{ t('publish.headers.jsonHint') }}</p>
        }
      </fieldset>
    </ng-container>
  `,
  styles: `
    fieldset {
      border: 1px solid var(--ds-color-border);
      border-radius: var(--ds-radius);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      text-align: start;
    }
    input,
    select,
    button {
      min-height: var(--ds-target-size);
      font: inherit;
    }
    input[aria-invalid='true'] {
      border: 2px solid var(--ds-color-danger);
    }
    .error {
      color: var(--ds-color-text-danger);
      font-weight: 600;
      margin: var(--ds-space-1) 0;
    }
    .hint {
      color: var(--ds-color-text-muted);
    }
  `,
})
export class HeaderGrid implements OnInit {
  readonly rows = model<readonly HeaderRow[]>([]);
  readonly mode = model<'grid' | 'json'>('grid');
  /** Set while the JSON text is not a typed table; the rows then lag behind the text. */
  readonly jsonError = model<HeaderJsonError | null>(null);

  protected readonly types = HEADER_TYPES;
  /**
   * The switch the person tried last. The message follows the state, not the attempt: it shows while the thing the
   * switch needs is not true, so it goes when fixed, and an old attempt shows nothing (in the view it led to, the
   * rows are valid and the JSON is a table).
   */
  private readonly attempted = signal<'json' | 'grid' | null>(null);
  protected readonly switchError = computed<SwitchError | null>(() => {
    if (this.attempted() === 'json') return this.built().ok ? null : 'row';
    return this.attempted() === 'grid' ? this.jsonError() : null;
  });

  /**
   * The JSON text the editor starts from: made from the rows each time the JSON view opens, and then the editor's own
   * (what is typed reaches the rows, not this seed).
   */
  protected readonly jsonText = computed<string>(() => {
    this.mode();
    return untracked(() => {
      const built = rowsToHeaders(this.rows());
      return built.ok ? headersToJson(built.headers) : '';
    });
  });

  private readonly built = computed(() => rowsToHeaders(this.rows()));

  ngOnInit(): void {
    // A grid that is shown again has only the rows, not the text that was wrong: the text is made from them.
    if (this.jsonError() !== null) this.jsonError.set(null);
  }

  protected typeLabel(type: keyof typeof TYPE_LABELS): string {
    return TYPE_LABELS[type];
  }

  protected switchText(error: SwitchError): string {
    return SWITCH_TEXT[error];
  }

  /** The words for what is wrong with a row, or an empty string. */
  protected problems(t: Translate, rowId: string): string {
    const built = this.built();
    if (built.ok) return '';
    return built.issues
      .filter((issue) => issue.rowId === rowId)
      .map((issue) => issueText(t, issue))
      .join(' ');
  }

  protected tableProblem(t: Translate): string {
    const built = this.built();
    const issue = built.ok
      ? undefined
      : built.issues.find((candidate) => candidate.rowId === null);
    return issue === undefined ? '' : issueText(t, issue);
  }

  protected read(event: Event): string {
    return controlValue(event);
  }

  protected add(): void {
    this.rows.update((rows) => [...rows, newRow()]);
  }

  protected remove(id: string): void {
    this.rows.update((rows) => rows.filter((row) => row.id !== id));
  }

  protected set(id: string, patch: Partial<Pick<HeaderRow, 'name' | 'text'>>) {
    this.rows.update((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }

  protected setType(id: string, event: Event): void {
    const type = controlValue(event);
    if (!isHeaderType(type)) return;
    this.rows.update((rows) =>
      rows.map((row) => (row.id === id ? { ...row, type } : row)),
    );
  }

  protected showJson(): void {
    this.attempted.set('json');
    if (!this.built().ok) return;
    this.mode.set('json');
  }

  protected showGrid(): void {
    this.attempted.set('grid');
    if (this.jsonError() !== null) return;
    this.mode.set('grid');
  }

  protected editJson(text: string): void {
    const parsed = parseHeadersJson(text);
    if (parsed.ok) {
      this.jsonError.set(null);
      this.rows.set(headersToRows(parsed.headers));
    } else {
      this.jsonError.set(parsed.error);
    }
  }
}
