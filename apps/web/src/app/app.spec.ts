import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { App } from './app';
import { SCOPE_LOADERS, provideI18n } from './i18n/i18n.config';
import { markerLoaders, settle } from './i18n/test-fixtures';

describe('App', () => {
  it('hosts the router outlet and sets the page title from a translation', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideI18n(),
        { provide: SCOPE_LOADERS, useValue: markerLoaders() },
      ],
    });
    const fixture = TestBed.createComponent(App);
    await settle(fixture);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('router-outlet'),
    ).not.toBeNull();
    expect(fixture.componentInstance.title()).toBe('[[system.appTitle]]');
    expect(document.title).toBe('[[system.appTitle]]');
  });
});
