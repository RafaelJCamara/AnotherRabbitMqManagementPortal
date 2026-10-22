// Test environment for Angular code: JIT compilation plus the browser testing platform. Zoneless
// change detection is the default of Angular 22, so no zone is loaded.
import '@angular/compiler';
import { getTestBed } from '@angular/core/testing';
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from '@angular/platform-browser/testing';
import { afterEach } from 'vitest';

getTestBed().initTestEnvironment(
  BrowserTestingModule,
  platformBrowserTesting(),
  { errorOnUnknownElements: true, errorOnUnknownProperties: true },
);

// Vitest runs without globals here, so Angular cannot register its own teardown.
afterEach(() => {
  getTestBed().resetTestingModule();
});
