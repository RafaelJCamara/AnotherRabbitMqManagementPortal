import { TestBed } from '@angular/core/testing';
import type { BootstrapErrorCode } from '@app/ui-platform';
import { describe, expect, it, vi } from 'vitest';

import { BOOT_FAILURE, BootFailed } from '../boot/boot-failed';
import { PAGE_RELOAD } from '../boot/page-reload';
import { mountShell, routed, visit } from '../shell/test-fixtures';
import { SCOPE_LOADERS, provideI18n } from './i18n.config';
import {
  englishKeys,
  markerLoaders,
  settle,
  visibleStrings,
} from './test-fixtures';

const MARKER = /^\[\[([A-Za-z0-9.]+)\]\]$/;

/** Engine data the fixtures supply (a connection id); rendered as text, never as a key. */
const ENGINE_DATA: readonly string[] = ['c1'];

describe('shell i18n', () => {
  it('AC-2 every visible string is a Transloco key or engine data', async () => {
    const known = new Set(englishKeys());
    const seen = new Set<string>();
    const strangers: string[] = [];
    const take = (strings: readonly string[]): void => {
      for (const text of strings) {
        const key = MARKER.exec(text)?.[1];
        if (key !== undefined && known.has(key)) seen.add(key);
        else if (!ENGINE_DATA.includes(text)) strangers.push(text);
      }
    };

    // The shell in each state it can be in, with every text replaced by its key.
    const bed = await mountShell();
    for (const url of [
      '/c/c1/explorer',
      '/c/c1/nope',
      '/c/not%20an%20id/explorer',
      '/',
    ]) {
      await visit(bed, url);
      take(visibleStrings(routed(bed)));
    }

    // The cannot-start view for each cause it can name.
    const causes: readonly (BootstrapErrorCode | 'unknown')[] = [
      'bridge-invalid',
      'bridge-version',
      'port-timeout',
      'bootstrap-unavailable',
      'bootstrap-invalid',
      'unknown',
    ];
    for (const cause of causes) {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideI18n(),
          { provide: SCOPE_LOADERS, useValue: markerLoaders() },
          { provide: BOOT_FAILURE, useValue: cause },
          { provide: PAGE_RELOAD, useValue: vi.fn() },
        ],
      });
      const fixture = TestBed.createComponent(BootFailed);
      await settle(fixture);
      // The page title is a visible string too.
      take([
        ...visibleStrings(fixture.nativeElement as HTMLElement),
        document.title,
      ]);
    }

    // Nothing visible is raw text, and no key of the files is left without a use.
    expect(strangers).toEqual([]);
    expect(englishKeys().filter((key) => !seen.has(key))).toEqual([]);
  });
});
