// One labelled input of the connection form (M0-52, R11): the label is tied to the input by `for`, a hint and an
// error are tied to it by `aria-describedby`, and an error also sets `aria-invalid`. A secret field (a password, a
// token, the pasted URI) is uncontrolled and masked: the page never binds a value back into it, so what was typed
// is held by the input and by the form's own state only, and a re-render cannot echo or clear it (R3).
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';

@Component({
  selector: 'app-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="field">
      <label [for]="fieldId()">{{ label() }}</label>
      <input
        [id]="fieldId()"
        [type]="secret() ? 'password' : 'text'"
        [attr.autocomplete]="secret() ? 'new-password' : autocomplete()"
        [attr.inputmode]="inputmode()"
        spellcheck="false"
        autocapitalize="off"
        [placeholder]="placeholder()"
        [attr.aria-invalid]="error() ? 'true' : null"
        [attr.aria-describedby]="describedBy()"
        [value]="secret() ? '' : value()"
        (input)="changed.emit(read($event))"
      />
      @if (hint()) {
        <p class="hint" [id]="fieldId() + '-hint'">{{ hint() }}</p>
      }
      @if (error()) {
        <p class="error" [id]="fieldId() + '-error'">{{ error() }}</p>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
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
    input {
      box-sizing: border-box;
      width: 100%;
      min-height: var(--ds-target-size);
      padding: 0 var(--ds-space-2);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font: inherit;
    }
    input[aria-invalid='true'] {
      border-color: var(--ds-color-danger);
      border-width: 2px;
    }
    input:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 1px;
    }
    p {
      margin: 0;
    }
    .hint {
      color: var(--ds-color-text-muted);
    }
    .error {
      color: var(--ds-color-text-danger);
      font-weight: 600;
    }
  `,
})
export class Field {
  /** The id of the input (unique on the page); the hint and the error derive theirs from it. */
  readonly fieldId = input.required<string>();
  readonly label = input.required<string>();
  /** Already translated, or empty. */
  readonly hint = input('');
  readonly error = input('');
  readonly value = input('');
  /** A password, a token or a pasted URI: masked and never bound back (see the file comment). */
  readonly secret = input(false);
  readonly placeholder = input('');
  readonly autocomplete = input('off');
  readonly inputmode = input<string | null>(null);

  readonly changed = output<string>();

  protected readonly describedBy = computed(() => {
    const ids = [
      this.hint() ? `${this.fieldId()}-hint` : null,
      this.error() ? `${this.fieldId()}-error` : null,
    ].filter((id): id is string => id !== null);
    return ids.length === 0 ? null : ids.join(' ');
  });

  protected read(event: Event): string {
    return event.target instanceof HTMLInputElement ? event.target.value : '';
  }
}
