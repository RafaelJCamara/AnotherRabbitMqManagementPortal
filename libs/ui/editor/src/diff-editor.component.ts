// <app-diff-editor>: two models side by side, the original read-only. The pair is created in the
// lazy editor chunk and disposed together, once, also when destroyed before the load resolves.
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import type {
  DiffEditorHandle,
  EditorDisposable,
  EditorHost,
  EditorLanguage,
} from './facade';
import { type EditorLoadError, MONACO_LOADER, toLoadError } from './loader';
import { EditorThemeBridge } from './theme-bridge';

@Component({
  selector: 'app-diff-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #surface class="diff-editor-surface"></div>`,
  styles: `
    :host {
      display: block;
    }
    .diff-editor-surface {
      height: 100%;
      min-height: 8rem;
    }
  `,
})
export class DiffEditor {
  private readonly loader = inject(MONACO_LOADER);
  private readonly theme = inject(EditorThemeBridge);
  private readonly surface =
    viewChild.required<ElementRef<HTMLElement>>('surface');

  readonly original = input('');
  /** Two-way: `modifiedChange` fires for edits and never for a value set from outside. */
  readonly modified = model('');
  readonly language = input<EditorLanguage>('plaintext');
  readonly ariaLabel = input.required<string>();

  readonly ready = output();
  readonly loadFailed = output<EditorLoadError>();

  private readonly handle = signal<DiffEditorHandle | null>(null);
  private host: EditorHost | null = null;
  private subscription: EditorDisposable | null = null;
  private destroyed = false;
  private applying = false;

  constructor() {
    afterNextRender(() => void this.start());
    inject(DestroyRef).onDestroy(() => {
      this.teardown();
    });

    effect(() => this.handle()?.setOriginal(this.original()));
    effect(() => {
      const handle = this.handle();
      const modified = this.modified();
      if (handle !== null && handle.getModified() !== modified) {
        this.applying = true;
        try {
          handle.setModified(modified);
        } finally {
          this.applying = false;
        }
      }
    });
    effect(() => this.handle()?.setLanguage(this.language()));
    effect(() => {
      const theme = this.theme.name();
      if (this.handle() !== null) this.host?.setTheme(theme);
    });
  }

  private async start(): Promise<void> {
    let host: EditorHost;
    try {
      host = await this.loader.load();
    } catch (cause) {
      if (this.destroyed) return;
      this.loadFailed.emit(toLoadError(cause));
      return;
    }
    if (this.destroyed) return;
    const handle = host.createDiffEditor(this.surface().nativeElement, {
      original: untracked(this.original),
      modified: untracked(this.modified),
      language: untracked(this.language),
      ariaLabel: untracked(this.ariaLabel),
      originalEditable: false,
    });
    this.subscription = handle.onDidChangeModified((text) => {
      if (!this.applying) this.modified.set(text);
    });
    this.host = host;
    this.handle.set(handle);
    this.ready.emit();
  }

  private teardown(): void {
    this.destroyed = true;
    this.subscription?.dispose();
    this.handle()?.dispose();
  }
}
