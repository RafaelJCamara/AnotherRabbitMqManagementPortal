import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { describe, expect, it, vi } from 'vitest';

import en from '../i18n/en.json';
import { EXPLORER_CONNECTION } from './connection';
import { provideExplorerScope } from './explorer-scope';
import { ExplorerComponent } from './explorer.component';

async function mount(cid: string | null) {
  TestBed.configureTestingModule({
    providers: [
      provideTransloco({
        config: { availableLangs: ['en'], defaultLang: 'en', prodMode: true },
      }),
      provideExplorerScope(),
      { provide: EXPLORER_CONNECTION, useValue: signal(cid) },
    ],
  });
  const fixture = TestBed.createComponent(ExplorerComponent);
  await fixture.whenStable();
  return fixture;
}

describe('ExplorerComponent', () => {
  it('shows its title for a connection', async () => {
    const fixture = await mount('c1');
    const el = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('h1')?.textContent).toBe(en.title);
    });
  });

  it('shows nothing without a connection', async () => {
    const fixture = await mount(null);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('h1'),
    ).toBeNull();
  });
});
