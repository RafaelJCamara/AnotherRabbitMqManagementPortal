// A text area that is the code editor when it can be loaded and a plain text box when it cannot (R3, R8): the
// value is the same either way and nothing typed is lost. The editor library has no strings, so the label and the
// hint arrive translated.
import {
  ChangeDetectionStrategy,
  Component,
  input,
  model,
  signal,
} from '@angular/core';
import { CodeEditor, type EditorLanguage } from '@app/ui-editor';
import { TranslocoDirective } from '@jsverse/transloco';

import { controlValue } from './dom';

@Component({
  selector: 'app-editor-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CodeEditor, TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      @if (failed()) {
        <p role="status">{{ t('publish.editor.fallback') }}</p>
        <textarea
          rows="10"
          spellcheck="false"
          [attr.aria-label]="label()"
          [value]="value()"
          (input)="value.set(read($event))"
        ></textarea>
      } @else {
        <app-code-editor
          [(value)]="value"
          [language]="language()"
          [ariaLabel]="label()"
          [hint]="t('publish.editor.hint')"
          (loadFailed)="failed.set(true)"
        />
      }
    </ng-container>
  `,
  styles: `
    :host {
      display: block;
    }
    app-code-editor {
      height: 16rem;
    }
    textarea {
      box-sizing: border-box;
      width: 100%;
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font-family: var(--ds-font-family-mono);
    }
  `,
})
export class EditorField {
  readonly value = model('');
  readonly language = input<EditorLanguage>('plaintext');
  /** The accessible name, already translated. */
  readonly label = input.required<string>();

  protected readonly failed = signal(false);

  protected read(event: Event): string {
    return controlValue(event);
  }
}
