// <app-code-editor>: one text model in the lazy editor chunk. It talks to an `EditorHost` only (the
// facade; no Monaco type), owns everything it creates and disposes it once, also when it is
// destroyed before the lazy load resolves. A value is never truncated (R3).
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

import { utf8ByteLength } from './byte-size';
import type {
  EditorDisposable,
  EditorHandle,
  EditorHost,
  EditorLanguage,
  EditorMarker,
  JsonSchema,
} from './facade';
import { type EditorLoadError, MONACO_LOADER, toLoadError } from './loader';
import { schemaRegistryFor } from './schema';
import { EditorThemeBridge } from './theme-bridge';

/** Markers kept per model (I-6); the rest are counted in `markersDropped`. */
export const EDITOR_MAX_MARKERS = 100;

@Component({
  selector: 'app-code-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div #surface class="code-editor-surface"></div>
    @if (hint(); as text) {
      <p class="code-editor-hint">{{ text }}</p>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .code-editor-surface {
      height: 100%;
      min-height: 8rem;
    }
  `,
})
export class CodeEditor {
  private readonly loader = inject(MONACO_LOADER);
  private readonly theme = inject(EditorThemeBridge);
  private readonly surface =
    viewChild.required<ElementRef<HTMLElement>>('surface');

  /** The text. Two-way: `valueChange` fires for edits and never for a value set from outside. */
  readonly value = model('');
  readonly language = input<EditorLanguage>('plaintext');
  readonly readOnly = input(false);
  /** The accessible name; the library has no strings of its own. */
  readonly ariaLabel = input.required<string>();
  /** A sentence shown under the editor, e.g. how to leave it with the keyboard. */
  readonly hint = input<string>();
  /** Applies only while `language` is `json`. */
  readonly schema = input<JsonSchema>();
  readonly maxBytes = input<number>();
  readonly markers = input<readonly EditorMarker[]>([]);

  /** The UTF-8 size while the value is over `maxBytes`; `0` once, when it is back within it. */
  readonly overLimit = output<number>();
  /** How many markers beyond the cap were not shown. */
  readonly markersDropped = output<number>();
  readonly ready = output();
  readonly loadFailed = output<EditorLoadError>();

  private readonly handle = signal<EditorHandle | null>(null);
  private host: EditorHost | null = null;
  private subscription: EditorDisposable | null = null;
  private destroyed = false;
  private applying = false;
  private wasOver = false;

  constructor() {
    afterNextRender(() => void this.start());
    inject(DestroyRef).onDestroy(() => {
      this.teardown();
    });

    effect(() => {
      const handle = this.handle();
      const value = this.value();
      if (handle !== null && handle.getValue() !== value) {
        this.applying = true;
        try {
          handle.setValue(value);
        } finally {
          this.applying = false;
        }
      }
    });
    effect(() => this.handle()?.setLanguage(this.language()));
    effect(() => this.handle()?.setReadOnly(this.readOnly()));
    effect(() => {
      const handle = this.handle();
      const all = this.markers();
      handle?.setMarkers(all.slice(0, EDITOR_MAX_MARKERS));
      if (handle !== null && all.length > EDITOR_MAX_MARKERS) {
        this.markersDropped.emit(all.length - EDITOR_MAX_MARKERS);
      }
    });
    effect(() => {
      const handle = this.handle();
      const schema = this.schema();
      const host = this.host;
      if (handle === null || host === null) return;
      const registry = schemaRegistryFor(host);
      if (schema !== undefined && this.language() === 'json') {
        registry.set(handle.modelUri, schema);
      } else {
        registry.remove(handle.modelUri);
      }
    });
    effect(() => {
      const theme = this.theme.name();
      if (this.handle() !== null) this.host?.setTheme(theme);
    });
    effect(() => {
      const max = this.maxBytes();
      const bytes = max === undefined ? 0 : utf8ByteLength(this.value());
      const over = max !== undefined && bytes > max;
      untracked(() => {
        if (over) this.overLimit.emit(bytes);
        else if (this.wasOver) this.overLimit.emit(0);
        this.wasOver = over;
      });
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
    // Destroyed while loading: nothing was created, so nothing is left to dispose.
    if (this.destroyed) return;
    const handle = host.createEditor(this.surface().nativeElement, {
      value: untracked(this.value),
      language: untracked(this.language),
      readOnly: untracked(this.readOnly),
      ariaLabel: untracked(this.ariaLabel),
    });
    this.subscription = handle.onDidChangeValue((text) => {
      if (!this.applying) this.value.set(text);
    });
    this.host = host;
    this.handle.set(handle);
    this.ready.emit();
  }

  private teardown(): void {
    this.destroyed = true;
    const handle = this.handle();
    this.subscription?.dispose();
    if (handle !== null && this.host !== null) {
      schemaRegistryFor(this.host).remove(handle.modelUri);
    }
    handle?.dispose();
  }
}
